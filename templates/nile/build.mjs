// Build "The Nile": fetch Kontur's population grid for Egypt and three
// Natural Earth layers from their publishers and prepare the four datasets
// the workflow starts from.
//
//   node templates/nile/build.mjs [work folder]
//
// Writes <work>/nile/data/{population_cells,nile,nile_delta,egypt}.parquet
// and <work>/nile/build-record.json (every address, when it was read, its
// bytes and SHA-256, and the rows that came out).

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "nile");

// Kontur Population for Egypt, the 2023-11-01 release, as listed on the
// Humanitarian Data Exchange (dataset kontur-population-egypt).
const KONTUR_RELEASE = "20231101";
const KONTUR_ADDRESS = `https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_EG_${KONTUR_RELEASE}.gpkg.gz`;
// Natural Earth 1:10m, from its own download host: the rivers' centre
// lines (the Nile, its course through Lake Nasser, and its two Delta
// branches), the geographic regions (the Nile Delta) and the countries
// (Egypt).
const NATURAL_EARTH = "https://naciscdn.org/naturalearth/10m";
const RIVERS = `${NATURAL_EARTH}/physical/ne_10m_rivers_lake_centerlines.zip`;
const REGIONS = `${NATURAL_EARTH}/physical/ne_10m_geography_regions_polys.zip`;
const COUNTRIES = `${NATURAL_EARTH}/cultural/ne_10m_admin_0_countries.zip`;
const NILE_NAMES = ["Nile", "Rosetta Branch", "Damietta Branch"];

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const kontur = await download(downloads, "kontur", KONTUR_ADDRESS, `kontur_population_EG_${KONTUR_RELEASE}.gpkg.gz`);
const rivers = await download(downloads, "natural-earth-rivers", RIVERS, "ne_10m_rivers_lake_centerlines.zip");
const regions = await download(downloads, "natural-earth-regions", REGIONS, "ne_10m_geography_regions_polys.zip");
const countries = await download(downloads, "natural-earth-countries", COUNTRIES, "ne_10m_admin_0_countries.zip");

// The population GeoPackage arrives gzipped: unpacked into a folder of its own.
const unpacked = await mkdtemp(path.join(downloads, "kontur-unpacked-"));
const gpkg = path.join(unpacked, `kontur_population_EG_${KONTUR_RELEASE}.gpkg`);
const gpkgBytes = gunzipSync(await readFile(kontur.path));
await writeFile(gpkg, gpkgBytes);
kontur.unpacked = { bytes: gpkgBytes.length, sha256: sha256(gpkgBytes) };

const shapefile = (zip, name) => literal(`/vsizip/${zip.path}/${name}.shp`);
const version = async (zip, name) => {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("unzip", ["-p", zip.path, `${name}.VERSION.txt`], { encoding: "utf8" }).trim();
};
const versions = {
  rivers: await version(rivers, "ne_10m_rivers_lake_centerlines"),
  regions: await version(regions, "ne_10m_geography_regions_polys"),
  countries: await version(countries, "ne_10m_admin_0_countries"),
};

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'");
  await db.run("SET threads = 4");

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
    CREATE TABLE egypt AS
    SELECT 'Egypt' AS country, geom
    FROM ST_Read(${shapefile(countries, "ne_10m_admin_0_countries")})
    WHERE ADM0_A3 = 'EGY'`);

  // The Nile inside Egypt: its course (through Lake Nasser too) and the
  // Rosetta and Damietta branches, cut at the border.
  await db.run(`
    CREATE TABLE nile AS
    SELECT name, lower(featurecla) AS course, ST_Intersection(r.geom, e.geom) AS geom
    FROM ST_Read(${shapefile(rivers, "ne_10m_rivers_lake_centerlines")}) AS r, egypt AS e
    WHERE r.name IN (${NILE_NAMES.map(literal).join(", ")}) AND ST_Intersects(r.geom, e.geom)
    ORDER BY name, course`);

  await db.run(`
    CREATE TABLE nile_delta AS
    SELECT 'Nile Delta' AS region, geom
    FROM ST_Read(${shapefile(regions, "ne_10m_geography_regions_polys")})
    WHERE NAME = 'Nile Delta'`);

  // Hold the slice to what the sources say.
  const [check] = await db.rows(`
    SELECT (SELECT count(*) FROM population_cells)::INTEGER AS cells,
           (SELECT sum(population) FROM population_cells)::BIGINT AS people,
           (SELECT min(ST_X(ST_Centroid(geom))) FROM population_cells) AS cell_x0,
           (SELECT max(ST_X(ST_Centroid(geom))) FROM population_cells) AS cell_x1,
           (SELECT min(ST_Y(ST_Centroid(geom))) FROM population_cells) AS cell_y0,
           (SELECT max(ST_Y(ST_Centroid(geom))) FROM population_cells) AS cell_y1,
           (SELECT count(*) FROM egypt)::INTEGER AS egypts,
           (SELECT count(*) FROM nile)::INTEGER AS nile_parts,
           (SELECT string_agg(DISTINCT name, ', ' ORDER BY name) FROM nile) AS nile_names,
           (SELECT count(*) FROM nile_delta)::INTEGER AS deltas`);
  if (check.cell_x0 < 24.5 || check.cell_x1 > 37 || check.cell_y0 < 21.8 || check.cell_y1 > 31.8) {
    throw new Error(`The population cells reach ${JSON.stringify(check)}: not Egypt in WGS84.`);
  }
  if (check.egypts !== 1 || check.deltas !== 1) throw new Error(`Egypt ${check.egypts}, Delta ${check.deltas}: one of each expected.`);
  if (check.nile_names !== "Damietta Branch, Nile, Rosetta Branch") throw new Error(`The Nile's parts are ${check.nile_names}.`);

  const outputs = {};
  for (const name of ["population_cells", "nile", "nile_delta", "egypt"]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    const [{ rows }] = await db.rows(`SELECT count(*)::INTEGER AS rows FROM ${name}`);
    outputs[name] = { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
  }

  const recorded = ({ path: p, ...rest }) => rest;
  const record = {
    template: "nile",
    builtAt: new Date().toISOString(),
    slice: {
      populationCells: check.cells,
      people: Number(check.people),
      nileParts: check.nile_parts,
      naturalEarthVersions: versions,
    },
    sources: {
      kontur: recorded(kontur),
      rivers: recorded(rivers),
      regions: recorded(regions),
      countries: recorded(countries),
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`population_cells: ${check.cells} (${check.people} people); nile: ${check.nile_parts} parts; Natural Earth ${JSON.stringify(versions)}\n`);
} finally {
  db.close();
}
