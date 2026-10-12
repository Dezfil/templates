// Build "Living with volcanoes": fetch the Philippines' volcanoes and their
// significant eruptions from NOAA NCEI, Kontur's population grid for the
// Philippines and Natural Earth's outline of the country, and prepare the
// four datasets the workflow starts from.
//
//   node templates/living-with-volcanoes/build.mjs [work folder]
//
// Writes <work>/living-with-volcanoes/data/{volcanoes,significant_eruptions,
// population_cells,philippines}.parquet and the build record (every
// address, when it was read, its bytes and SHA-256, and the rows that came
// out).

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "living-with-volcanoes");

// NOAA NCEI's natural hazards service: the Volcano Locations Database and
// the Global Significant Volcanic Eruptions Database, the Philippines'
// rows (doi:10.7289/V5JW8BSH).
const NCEI = "https://www.ngdc.noaa.gov/hazel/hazard-service/api/v1";
const VOLCANOES = `${NCEI}/volcanolocs?country=Philippines`;
const ERUPTIONS = `${NCEI}/volcanoes?country=Philippines`;
// Kontur Population for the Philippines, the 2023-11-01 release, as listed
// on the Humanitarian Data Exchange (dataset kontur-population-philippines).
const KONTUR_RELEASE = "20231101";
const KONTUR_ADDRESS = `https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_PH_${KONTUR_RELEASE}.gpkg.gz`;
// Natural Earth 1:10m countries, for the Philippines' land.
const COUNTRIES = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries.zip";

// The Volcano Locations Database's codes for the last known eruption, as
// its metadata (NCEI record G02135) lists them.
const LAST_ERUPTION = {
  D1: "1964 or later",
  D2: "1900 to 1963",
  D3: "1800 to 1899",
  D4: "1700 to 1799",
  D5: "1500 to 1699",
  D6: "AD 1 to 1499",
  D7: "Before AD 1 (Holocene)",
  U: "Undated, probably Holocene",
  Q: "Quaternary; only hydrothermal activity in the Holocene",
  "?": "Uncertain Holocene eruption",
};

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const volcanoesFile = await download(downloads, "ncei-volcano-locations", VOLCANOES, "volcanolocs.json");
const eruptionsFile = await download(downloads, "ncei-significant-eruptions", ERUPTIONS, "volcanoes.json");
const kontur = await download(downloads, "kontur", KONTUR_ADDRESS, `kontur_population_PH_${KONTUR_RELEASE}.gpkg.gz`);
const countries = await download(downloads, "natural-earth-countries", COUNTRIES, "ne_10m_admin_0_countries.zip");

const page = async (file) => {
  const body = JSON.parse(await readFile(file.path, "utf8"));
  if (body.totalPages !== 1 || body.items.length !== body.totalItems) throw new Error(`${file.url} answered page ${body.page} of ${body.totalPages}.`);
  return body.items;
};
const volcanoItems = await page(volcanoesFile);
const eruptionItems = await page(eruptionsFile);

// The population GeoPackage arrives gzipped: unpacked into a folder of its own.
const unpacked = await mkdtemp(path.join(downloads, "kontur-unpacked-"));
const gpkg = path.join(unpacked, `kontur_population_PH_${KONTUR_RELEASE}.gpkg`);
const gpkgBytes = gunzipSync(await readFile(kontur.path));
await writeFile(gpkg, gpkgBytes);
kontur.unpacked = { bytes: gpkgBytes.length, sha256: sha256(gpkgBytes) };
const { execFileSync } = await import("node:child_process");
const countriesVersion = execFileSync("unzip", ["-p", countries.path, "ne_10m_admin_0_countries.VERSION.txt"], { encoding: "utf8" }).trim();

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'");
  await db.run("SET threads = 4");

  const number = (v) => (v === undefined || v === null ? "NULL" : String(Number(v)));
  const text = (v) => (v === undefined || v === null ? "NULL" : literal(v));
  await db.run(`
    CREATE TABLE volcanoes AS
    SELECT * FROM (VALUES ${volcanoItems.map((v) => `(${number(v.id)}, ${text(v.name)}, ${text(v.location)}, ${text(v.morphology)}, ${number(v.elevation)}, ${text(v.status)}, ${text(v.timeErupt)}, ${text(LAST_ERUPTION[v.timeErupt] ?? "Not given")}, ST_Point(${number(v.longitude)}, ${number(v.latitude)}))`).join(",\n")})
      AS t(volcano_id, name, location, morphology, elevation_m, status, last_eruption_code, last_known_eruption, geom)
    ORDER BY volcano_id`);

  await db.run(`
    CREATE TABLE significant_eruptions AS
    SELECT * FROM (VALUES ${eruptionItems.map((e) => `(${number(e.id)}, ${number(e.volcanoLocationId)}, ${text(e.name)}, ${number(e.year)}, ${number(e.month)}, ${number(e.day)}, ${number(e.vei)}, ${number(e.deaths)}, ${number(e.deathsTotal)}, ST_Point(${number(e.longitude)}, ${number(e.latitude)}))`).join(",\n")})
      AS t(eruption_id, volcano_id, volcano, year, month, day, vei, deaths, deaths_total, geom)
    ORDER BY volcano_id, year, month, day`);

  // Kontur's hexagons come in Web Mercator; they ship in WGS84, each with
  // its H3 cell and its people.
  await db.run(`
    CREATE TABLE population_cells AS
    SELECT h3,
           CAST(round(population) AS INTEGER) AS population,
           ST_Transform(geom, 'EPSG:3857', 'EPSG:4326', always_xy := true) AS geom
    FROM ST_Read(${literal(gpkg)})
    ORDER BY h3`);

  await db.run(`
    CREATE TABLE philippines AS
    SELECT 'Philippines' AS country, geom
    FROM ST_Read(${literal(`/vsizip/${countries.path}/ne_10m_admin_0_countries.shp`)})
    WHERE ADM0_A3 = 'PHL'`);

  // Hold the slice to what the sources say.
  const [check] = await db.rows(`
    SELECT (SELECT count(*) FROM volcanoes)::INTEGER AS volcanoes,
           (SELECT count(*) FROM volcanoes WHERE status = 'Historical')::INTEGER AS historical,
           (SELECT count(*) FROM significant_eruptions)::INTEGER AS eruptions,
           (SELECT count(*) FROM significant_eruptions WHERE volcano_id NOT IN (SELECT volcano_id FROM volcanoes))::INTEGER AS eruptions_unmatched,
           (SELECT count(*) FROM population_cells)::INTEGER AS cells,
           (SELECT sum(population) FROM population_cells)::BIGINT AS people,
           (SELECT min(ST_X(ST_Centroid(geom))) FROM population_cells) AS cell_x0,
           (SELECT max(ST_X(ST_Centroid(geom))) FROM population_cells) AS cell_x1,
           (SELECT min(ST_Y(ST_Centroid(geom))) FROM population_cells) AS cell_y0,
           (SELECT max(ST_Y(ST_Centroid(geom))) FROM population_cells) AS cell_y1,
           (SELECT count(*) FROM philippines)::INTEGER AS countries`);
  // Kontur counts the Kalayaan islands in the Spratlys too, near 114° E.
  if (check.cell_x0 < 114 || check.cell_x1 > 127.5 || check.cell_y0 < 4 || check.cell_y1 > 21.5) {
    throw new Error(`The population cells reach ${JSON.stringify(check)}: not the Philippines in WGS84.`);
  }
  if (check.eruptions_unmatched !== 0 || check.countries !== 1) throw new Error(`Unexpected slice: ${JSON.stringify(check)}`);

  const outputs = {};
  for (const name of ["volcanoes", "significant_eruptions", "population_cells", "philippines"]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    const [{ rows }] = await db.rows(`SELECT count(*)::INTEGER AS rows FROM ${name}`);
    outputs[name] = { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
  }

  const recorded = ({ path: p, ...rest }) => rest;
  const record = {
    template: "living-with-volcanoes",
    builtAt: new Date().toISOString(),
    slice: {
      volcanoes: check.volcanoes,
      historical: check.historical,
      significantEruptions: check.eruptions,
      populationCells: check.cells,
      people: Number(check.people),
      naturalEarthCountriesVersion: countriesVersion,
    },
    sources: {
      volcanoes: recorded(volcanoesFile),
      eruptions: recorded(eruptionsFile),
      kontur: recorded(kontur),
      countries: recorded(countries),
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(record.slice)}\n`);
} finally {
  db.close();
}
