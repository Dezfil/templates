// Build "Charging Germany's cars": fetch the Bundesnetzagentur's register
// of public charging stations, Germany's counties from Overture Maps'
// divisions and Kontur's population grid for Germany, each from its
// publisher at a pinned address, and prepare the three datasets the map
// reads: every charging station in the register, the counties, and the
// people living in each county.
//
//   node templates/charging-germany/build.mjs [work folder]
//
// Writes <work>/charging-germany/data/{chargers,counties,county_population}.parquet
// and <work>/charging-germany/build-record.json.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { engine, literal, sha256 } from "../../tools/source.mjs";
import { downloadStream } from "../../tools/stream.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "charging-germany");

// The register's page states the licence and the credit; the list as of
// 1 September 2026, the newest the page offers as CSV.
const REGISTER_PAGE = "https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenkarte/start.html";
const REGISTER_DATE = "2026-09-01";
const REGISTER = `https://data.bundesnetzagentur.de/Bundesnetzagentur/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenregister_BNetzA_${REGISTER_DATE}.csv`;
const LICENCE_WORDS = [
  "Die Daten sind durch eine Creative Commons Namensnennung 4.0 International Lizenz lizenziert.",
  "Als Namensnennung für Daten dieser Internetseite ist Bundesnetzagentur.de zu verwenden.",
];
// Overture Maps' divisions, release 2026-09-23.1: Germany's counties, and
// Berlin and Hamburg, which are states with no county of their own.
const OVERTURE_RELEASE = "2026-09-23.1";
const OVERTURE = `s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=divisions/type=division_area/*.parquet`;
// Kontur Population for Germany, the 2023-11-01 release, as listed on the
// Humanitarian Data Exchange (dataset kontur-population-germany).
const KONTUR_RELEASE = "20231101";
const KONTUR = `https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_DE_${KONTUR_RELEASE}.gpkg.gz`;
// County outlines simplified to about 100 m, which a country-wide map
// cannot tell apart from the original and which keeps the layer light.
const SIMPLIFY_DEGREES = 0.001;

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const page = await downloadStream(downloads, "register-page", REGISTER_PAGE, "start.html");
{
  const text = (await readFile(page.path, "utf8")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  for (const words of LICENCE_WORDS) if (!text.includes(words)) throw new Error(`The register's page no longer says: ${words}`);
}
const register = await downloadStream(downloads, "register", REGISTER, `Ladesaeulenregister_${REGISTER_DATE}.csv`);
const kontur = await downloadStream(downloads, "kontur", KONTUR, `kontur_population_DE_${KONTUR_RELEASE}.gpkg.gz`);
const unpacked = await mkdtemp(path.join(downloads, "kontur-unpacked-"));
const gpkg = path.join(unpacked, `kontur_population_DE_${KONTUR_RELEASE}.gpkg`);
await pipeline(createReadStream(kontur.path), createGunzip(), createWriteStream(gpkg));
process.stdout.write(`register: ${register.bytes} bytes; kontur: ${kontur.bytes} bytes\n`);

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'; SET threads = 4;");
  await db.run("INSTALL httpfs; LOAD httpfs; SET s3_region = 'us-west-2';");

  // The register: ten lines of notes, a line grouping the columns, then
  // the columns, separated by semicolons, with decimal commas. Every
  // column is read as text and typed here.
  await db.run(`
    CREATE TABLE raw AS
    SELECT * FROM read_csv(${literal(register.path)}, skip = 10, header = true, delim = ';', quote = '"', escape = '"', all_varchar = true)`);
  const decimal = (column) => `TRY_CAST(replace(trim("${column}"), ',', '.') AS DOUBLE)`;
  await db.run(`
    CREATE TABLE chargers AS
    SELECT TRY_CAST("Ladeeinrichtungs-ID" AS INTEGER) AS station,
           trim("Betreiber") AS operator,
           CASE trim("Art der Ladeeinrichtung") WHEN 'Schnellladeeinrichtung' THEN 'Fast' WHEN 'Normalladeeinrichtung' THEN 'Normal' END AS kind,
           TRY_CAST("Anzahl Ladepunkte" AS INTEGER) AS charge_points,
           ${decimal("Nennleistung Ladeeinrichtung [kW]")} AS power_kw,
           TRY_STRPTIME(trim("Inbetriebnahmedatum"), '%d.%m.%Y')::DATE AS commissioned,
           trim("Status") AS status,
           nullif(trim(concat_ws(' ', trim("Straße"), trim("Hausnummer"))), '') AS street,
           trim("Postleitzahl") AS postcode,
           trim("Ort") AS town,
           trim("Kreis/kreisfreie Stadt") AS register_county,
           trim("Bundesland") AS state,
           ST_Point(${decimal("Längengrad")}, ${decimal("Breitengrad")}) AS geom
    FROM raw`);
  const [bad] = await db.rows(`
    SELECT count(*)::INTEGER AS rows,
           count(*) FILTER (WHERE station IS NULL OR kind IS NULL OR charge_points IS NULL OR power_kw IS NULL OR commissioned IS NULL)::INTEGER AS untyped,
           count(*) FILTER (WHERE ST_X(geom) NOT BETWEEN 5.8 AND 15.1 OR ST_Y(geom) NOT BETWEEN 47.2 AND 55.1 OR geom IS NULL)::INTEGER AS outside
    FROM chargers`);
  if (bad.untyped) throw new Error(`${bad.untyped} of ${bad.rows} stations have a field that does not read: ${JSON.stringify(bad)}.`);

  // The counties as Overture keeps them, with Berlin and Hamburg.
  await db.run(`
    CREATE TABLE counties AS
    SELECT id AS division,
           names.primary AS county,
           region,
           ST_SimplifyPreserveTopology(geometry, ${SIMPLIFY_DEGREES}) AS geom,
           geometry AS outline
    FROM read_parquet(${literal(OVERTURE)})
    WHERE country = 'DE' AND class = 'land'
      AND (subtype = 'county' OR (subtype = 'region' AND region IN ('DE-BE', 'DE-HH')))
      AND bbox.xmin > 5.8 AND bbox.xmax < 15.1 AND bbox.ymin > 47.2 AND bbox.ymax < 55.1
    ORDER BY region, county`);
  // What the template keeps of a county (its outline, its primary name)
  // comes from OpenStreetMap; Overture adds names in other languages from
  // Esri Community Maps (CC0) for Berlin and Hamburg, which are left out.
  const overtureSources = await db.rows(`
    WITH s AS (
      SELECT unnest(sources) AS source
      FROM read_parquet(${literal(OVERTURE)})
      WHERE id IN (SELECT division FROM counties))
    SELECT source.dataset AS dataset, source.license AS licence, count(*)::INTEGER AS n
    FROM s
    WHERE source.property IN ('', '/geometry', '/properties/names/primary')
    GROUP BY ALL`);
  if (overtureSources.some((s) => s.dataset !== "OpenStreetMap")) {
    throw new Error(`A county's outline or name comes from ${JSON.stringify(overtureSources)}, not OpenStreetMap alone.`);
  }

  // Each station in its county, by the original outline; a station in no
  // county or in two is a fault in the slice.
  const [placed] = await db.rows(`
    WITH hits AS (
      SELECT s.station, count(c.division) AS n
      FROM chargers s LEFT JOIN counties c ON ST_Intersects(c.outline, s.geom)
      GROUP BY s.station)
    SELECT count(*) FILTER (WHERE n = 0)::INTEGER AS nowhere, count(*) FILTER (WHERE n > 1)::INTEGER AS twice FROM hits`);

  // Kontur's hexagons in Web Mercator: each counted in the county its
  // middle falls in.
  await db.run(`
    CREATE TABLE cells AS
    SELECT population, ST_Transform(ST_Centroid(geom), 'EPSG:3857', 'EPSG:4326', always_xy := true) AS centre
    FROM ST_Read(${literal(gpkg)})`);
  await db.run(`
    CREATE TABLE county_population AS
    SELECT c.division, c.county, round(sum(k.population))::INTEGER AS population
    FROM counties c JOIN cells k ON ST_Intersects(c.outline, k.centre)
    GROUP BY ALL
    ORDER BY c.division`);
  await db.run("ALTER TABLE counties DROP COLUMN outline");

  const [tally] = await db.rows(`
    SELECT (SELECT count(*) FROM chargers)::INTEGER AS stations,
           (SELECT sum(charge_points) FROM chargers)::INTEGER AS charge_points,
           (SELECT count(*) FILTER (WHERE kind = 'Fast') FROM chargers)::INTEGER AS fast_stations,
           (SELECT count(*) FILTER (WHERE power_kw >= 150) FROM chargers)::INTEGER AS stations_150kw,
           (SELECT round(sum(power_kw) / 1000)::INTEGER FROM chargers) AS megawatts,
           (SELECT count(*) FROM counties)::INTEGER AS counties,
           (SELECT count(*) FROM county_population)::INTEGER AS counties_with_people,
           (SELECT sum(population) FROM county_population)::BIGINT AS people,
           (SELECT sum(population) FROM cells)::BIGINT AS people_in_grid,
           (SELECT min(commissioned)::VARCHAR FROM chargers) AS first_commissioned,
           (SELECT max(commissioned)::VARCHAR FROM chargers) AS last_commissioned`);
  if (tally.counties_with_people !== tally.counties) throw new Error(`${tally.counties - tally.counties_with_people} counties have no people.`);

  const outputs = {};
  for (const name of ["chargers", "counties", "county_population"]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    const [{ n }] = await db.rows(`SELECT count(*)::INTEGER AS n FROM ${name}`);
    outputs[name] = { file: path.relative(work, file), rows: n, sha256: sha256(await readFile(file)) };
  }

  const strip = ({ path: p, ...f }) => f;
  const record = {
    template: "charging-germany",
    builtAt: new Date().toISOString(),
    slice: { registerDate: REGISTER_DATE, ...tally, stationsOutsideCounties: placed.nowhere, stationsInTwoCounties: placed.twice, outsideGermanyBox: bad.outside },
    sources: {
      registerPage: strip(page),
      register: strip(register),
      overture: { release: OVERTURE_RELEASE, address: OVERTURE, readAt: new Date().toISOString(), sources: overtureSources },
      kontur: strip(kontur),
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(record.slice)}\n`);
} finally {
  db.close();
}
