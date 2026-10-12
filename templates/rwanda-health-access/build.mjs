// Build "Health access in Rwanda": fetch the three sources from their
// publishers at pinned addresses and prepare the three datasets the
// workflow starts from.
//
//   node templates/rwanda-health-access/build.mjs [work folder]
//
// Writes <work>/rwanda-health-access/data/{population_cells,
// health_facilities,districts}.parquet and <work>/rwanda-health-access/
// build-record.json (every address, when it was read, its bytes and
// SHA-256, and the rows that came out).

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "rwanda-health-access");

// Kontur Population for Rwanda, the 2023-11-01 release, as listed on the
// Humanitarian Data Exchange (dataset kontur-population-rwanda).
const KONTUR_RELEASE = "20231101";
const KONTUR_ADDRESS = `https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_RW_${KONTUR_RELEASE}.gpkg.gz`;
// Maina et al. (2019), the public health facilities of sub-Saharan Africa:
// figshare article 7725374, version 1, its one file (id 14379593).
const FACILITIES_ADDRESS = "https://ndownloader.figshare.com/files/14379593";
const FACILITIES_MD5 = "3bf56fc31081c8fd798789a3d70564b8";
// geoBoundaries Rwanda ADM2 (districts), gbOpen, at a pinned commit of the
// publisher's repository; the simplified outlines.
const GEOBOUNDARIES_COMMIT = "9469f09592ced973a3448cf66b6100b741b64c0d";
const DISTRICTS_ADDRESS = `https://github.com/wmgeolab/geoBoundaries/raw/${GEOBOUNDARIES_COMMIT}/releaseData/gbOpen/RWA/ADM2/geoBoundaries-RWA-ADM2_simplified.geojson`;

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const kontur = await download(downloads, "kontur", KONTUR_ADDRESS, `kontur_population_RW_${KONTUR_RELEASE}.gpkg.gz`);
const facilities = await download(downloads, "maina-facilities", FACILITIES_ADDRESS, "facilities.xlsx");
const districts = await download(downloads, "geoboundaries-rwa-adm2", DISTRICTS_ADDRESS, "districts.geojson");
const { createHash } = await import("node:crypto");
const md5 = createHash("md5").update(await readFile(facilities.path)).digest("hex");
if (md5 !== FACILITIES_MD5) throw new Error(`The facilities file's MD5 is ${md5}; figshare lists ${FACILITIES_MD5}.`);
// The figshare address answers through a short-lived signed redirect: the
// record keeps the stable address and the file's own hashes.
delete facilities.answeredFrom;

// The population GeoPackage arrives gzipped: unpacked into a folder of its own.
const unpacked = await mkdtemp(path.join(downloads, "kontur-unpacked-"));
const gpkg = path.join(unpacked, `kontur_population_RW_${KONTUR_RELEASE}.gpkg`);
const gpkgBytes = gunzipSync(await readFile(kontur.path));
await writeFile(gpkg, gpkgBytes);
kontur.unpacked = { bytes: gpkgBytes.length, sha256: sha256(gpkgBytes) };

const db = await engine();
try {
  await db.run("INSTALL excel");
  await db.run("LOAD excel");

  // Kontur's hexagons come in Web Mercator; they ship in WGS84, each with
  // its H3 cell and its people.
  await db.run(`
    CREATE TABLE population_cells AS
    SELECT h3,
           CAST(round(population) AS INTEGER) AS population,
           ST_Transform(geom, 'EPSG:3857', 'EPSG:4326', always_xy := true) AS geom
    FROM ST_Read(${literal(gpkg)})
    ORDER BY h3`);

  // The facilities in Rwanda, every column read as text and typed here.
  await db.run(`
    CREATE TABLE health_facilities AS
    SELECT trim("Facility name") AS facility_name,
           trim("Facility type") AS facility_type,
           trim(Ownership) AS ownership,
           trim(Admin1) AS province,
           ST_Point(CAST(Long AS DOUBLE), CAST(Lat AS DOUBLE)) AS geom
    FROM read_xlsx(${literal(facilities.path)}, all_varchar = true)
    WHERE Country = 'Rwanda' AND Lat IS NOT NULL AND Long IS NOT NULL
    ORDER BY facility_name`);

  await db.run(`
    CREATE TABLE districts AS
    SELECT shapeName AS district, geom
    FROM ST_Read(${literal(districts.path)})
    ORDER BY shapeName`);

  // Hold the slice to what the sources say: every cell inside Rwanda's
  // extent, every facility too, thirty districts.
  const [check] = await db.rows(`
    SELECT (SELECT count(*) FROM population_cells)::INTEGER AS cells,
           (SELECT sum(population) FROM population_cells)::BIGINT AS people,
           (SELECT min(ST_X(ST_Centroid(geom))) FROM population_cells) AS cell_x0,
           (SELECT max(ST_X(ST_Centroid(geom))) FROM population_cells) AS cell_x1,
           (SELECT min(ST_Y(ST_Centroid(geom))) FROM population_cells) AS cell_y0,
           (SELECT max(ST_Y(ST_Centroid(geom))) FROM population_cells) AS cell_y1,
           (SELECT count(*) FROM health_facilities)::INTEGER AS facilities,
           (SELECT count(*) FROM health_facilities WHERE NOT ST_Intersects(geom, (SELECT ST_Union_Agg(geom) FROM districts)))::INTEGER AS facilities_outside,
           (SELECT count(*) FROM districts)::INTEGER AS districts`);
  if (check.cell_x0 < 28.8 || check.cell_x1 > 31 || check.cell_y0 < -2.9 || check.cell_y1 > -1) {
    throw new Error(`The population cells reach ${JSON.stringify(check)}: not Rwanda in WGS84.`);
  }
  if (check.districts !== 30) throw new Error(`${check.districts} districts; Rwanda has 30.`);

  const outputs = {};
  for (const name of ["population_cells", "health_facilities", "districts"]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    const [{ rows }] = await db.rows(`SELECT count(*)::INTEGER AS rows FROM ${name}`);
    outputs[name] = { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
  }

  const recorded = ({ path: p, ...rest }) => rest;
  const record = {
    template: "rwanda-health-access",
    builtAt: new Date().toISOString(),
    slice: {
      populationCells: check.cells,
      people: Number(check.people),
      facilities: check.facilities,
      facilitiesOutsideTheDistricts: check.facilities_outside,
      districts: check.districts,
    },
    sources: {
      kontur: recorded(kontur),
      facilities: { ...recorded(facilities), md5 },
      districts: recorded(districts),
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`population_cells: ${check.cells} (${check.people} people); health_facilities: ${check.facilities} (${check.facilities_outside} outside the districts); districts: ${check.districts}\n`);
} finally {
  db.close();
}
