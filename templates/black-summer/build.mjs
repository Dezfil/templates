// Build "Black Summer fires": fetch NASA FIRMS's MODIS fire detections for
// Australia (the 2019 and 2020 country files) and Natural Earth's states,
// and prepare the two datasets the workflow starts from: the detections in
// New South Wales, Victoria and the ACT from 1 November 2019 to 31 January
// 2020, and those states.
//
//   node templates/black-summer/build.mjs [work folder]
//
// Writes <work>/black-summer/data/{fire_detections,states}.parquet and the
// build record (every address, when it was read, its bytes and SHA-256,
// and the rows that came out).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "black-summer");

// FIRMS's yearly country files: MODIS (Terra and Aqua) standard-quality
// detections, MCD14ML, for Australia.
const FIRMS = "https://firms.modaps.eosdis.nasa.gov/data/country/modis";
const YEARS = [2019, 2020];
const FIRST_DAY = "2019-11-01";
const LAST_DAY = "2020-01-31";
// Natural Earth 1:10m states and provinces.
const STATES_ADDRESS = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip";
const STATE_NAMES = ["New South Wales", "Victoria", "Australian Capital Territory", "Jervis Bay Territory"];

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const firms = [];
for (const year of YEARS) {
  firms.push(await download(downloads, `firms-modis-${year}`, `${FIRMS}/${year}/modis_${year}_Australia.csv`, `modis_${year}_Australia.csv`));
}
const statesZip = await download(downloads, "natural-earth-states", STATES_ADDRESS, "ne_10m_admin_1_states_provinces.zip");
const { execFileSync } = await import("node:child_process");
const statesVersion = execFileSync("unzip", ["-p", statesZip.path, "ne_10m_admin_1_states_provinces.VERSION.txt"], { encoding: "utf8" }).trim();

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'");
  await db.run("SET threads = 4");

  await db.run(`
    CREATE TABLE states AS
    SELECT name AS state, geom
    FROM ST_Read(${literal(`/vsizip/${statesZip.path}/ne_10m_admin_1_states_provinces.shp`)})
    WHERE adm0_a3 = 'AUS' AND name IN (${STATE_NAMES.map(literal).join(", ")})
    ORDER BY state`);

  // Every detection of the season inside those states, as FIRMS gives it,
  // presumed vegetation fires only (type 0); the time of the overpass in
  // UTC.
  await db.run(`
    CREATE TABLE fire_detections AS
    SELECT CAST(f.acq_date AS DATE) AS acq_date,
           strptime(CAST(f.acq_date AS VARCHAR) || ' ' || lpad(CAST(f.acq_time AS VARCHAR), 4, '0'), '%Y-%m-%d %H%M') AS detected_at_utc,
           f.satellite,
           CAST(f.confidence AS INTEGER) AS confidence,
           CAST(f.frp AS DOUBLE) AS frp,
           CAST(f.brightness AS DOUBLE) AS brightness,
           f.daynight,
           s.state,
           ST_Point(CAST(f.longitude AS DOUBLE), CAST(f.latitude AS DOUBLE)) AS geom
    FROM read_csv([${firms.map((f) => literal(f.path)).join(", ")}], union_by_name = true, header = true) AS f
    JOIN states AS s ON ST_Within(ST_Point(CAST(f.longitude AS DOUBLE), CAST(f.latitude AS DOUBLE)), s.geom)
    WHERE CAST(f.acq_date AS DATE) BETWEEN DATE ${literal(FIRST_DAY)} AND DATE ${literal(LAST_DAY)}
      AND CAST(f.type AS INTEGER) = 0
    ORDER BY detected_at_utc`);

  // Hold the slice to what the sources say.
  const [check] = await db.rows(`
    SELECT (SELECT count(*) FROM fire_detections)::INTEGER AS detections,
           (SELECT count(*) FROM fire_detections WHERE confidence >= 80)::INTEGER AS confident,
           (SELECT min(acq_date) FROM fire_detections)::VARCHAR AS first_day,
           (SELECT max(acq_date) FROM fire_detections)::VARCHAR AS last_day,
           (SELECT string_agg(DISTINCT satellite, ', ' ORDER BY satellite) FROM fire_detections) AS satellites,
           (SELECT count(*) FROM states)::INTEGER AS states`);
  if (check.states !== STATE_NAMES.length) throw new Error(`${check.states} states; expected ${STATE_NAMES.length}.`);
  if (check.first_day !== FIRST_DAY || check.last_day !== LAST_DAY) throw new Error(`The detections run ${check.first_day} to ${check.last_day}.`);
  const versions = await db.rows(`SELECT DISTINCT CAST(version AS VARCHAR) AS v FROM read_csv([${firms.map((f) => literal(f.path)).join(", ")}], union_by_name = true, header = true)`);

  const outputs = {};
  for (const name of ["fire_detections", "states"]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    const [{ rows }] = await db.rows(`SELECT count(*)::INTEGER AS rows FROM ${name}`);
    outputs[name] = { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
  }

  const recorded = ({ path: p, ...rest }) => rest;
  const record = {
    template: "black-summer",
    builtAt: new Date().toISOString(),
    slice: { ...check, firmsVersions: versions.map((r) => r.v), naturalEarthStatesVersion: statesVersion },
    sources: { firms: firms.map(recorded), states: recorded(statesZip) },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(record.slice)}\n`);
} finally {
  db.close();
}
