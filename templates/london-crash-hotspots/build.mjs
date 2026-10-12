// Build "London's crash hotspots": fetch the Department for Transport's
// road safety data for 2025 (every personal injury collision reported to
// the police in Great Britain) and its data guide from the publisher at
// pinned addresses, and prepare the one dataset the workflow starts from:
// every collision the Metropolitan Police and the City of London Police
// recorded in 2025, its codes read through the guide.
//
//   node templates/london-crash-hotspots/build.mjs [work folder]
//
// Writes <work>/london-crash-hotspots/data/collisions.parquet and
// <work>/london-crash-hotspots/build-record.json.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "london-crash-hotspots");

// The slice: 2025, the latest final year (added to the DfT's page on
// 30 July 2026), and London's two police forces, whose areas together are
// Greater London.
const YEAR = 2025;
const COLLISIONS_ADDRESS = `https://data.dft.gov.uk/road-accidents-safety-data/dft-road-casualty-statistics-collision-${YEAR}.csv`;
// The open dataset's data guide, which decodes every coded column.
const GUIDE_ADDRESS =
  "https://assets.publishing.service.gov.uk/media/6ab2a71d997a4b2950cced58/dft-road-casualty-statistics-road-safety-open-dataset-data-guide-2025.xlsx";
const LONDON_FORCES = { 1: "Metropolitan Police", 48: "City of London" };

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const collisionsFile = await download(downloads, "collisions", COLLISIONS_ADDRESS, `collisions-${YEAR}.csv`);
const guideFile = await download(downloads, "guide", GUIDE_ADDRESS, "data-guide.xlsx");
process.stdout.write(`collisions: ${collisionsFile.bytes} bytes; guide: ${guideFile.bytes} bytes\n`);

const db = await engine();
try {
  await db.run("INSTALL excel");
  await db.run("LOAD excel");

  // The guide's codes for the collision table, and a check that it names
  // London's two forces as this build expects.
  await db.run(`
    CREATE TABLE guide AS
    SELECT "field name" AS field, "code/format" AS code, label
    FROM read_xlsx(${literal(guideFile.path)}, all_varchar = true)
    WHERE "table" = 'collision' AND "code/format" IS NOT NULL AND label IS NOT NULL`);
  for (const [code, force] of Object.entries(LONDON_FORCES)) {
    const [row] = await db.rows(`SELECT label FROM guide WHERE field = 'police_force' AND code = '${code}'`);
    if (row?.label !== force) throw new Error(`The guide names police force ${code} ${row?.label}, not ${force}.`);
  }
  const label = (field) => `(SELECT label FROM guide WHERE field = '${field}' AND code = c.${field})`;

  await db.run(`
    CREATE TABLE raw AS
    SELECT * FROM read_csv(${literal(collisionsFile.path)}, header = true, all_varchar = true)`);
  const columns = new Set((await db.rows("DESCRIBE raw")).map((c) => c.column_name));
  for (const needed of ["collision_index", "police_force", "collision_severity", "date", "time", "longitude", "latitude", "road_type", "speed_limit", "light_conditions"]) {
    if (!columns.has(needed)) throw new Error(`The collisions file has no ${needed} column.`);
  }

  // One row per collision in London: its reference, when, how severe, the
  // road, the speed limit and the light, decoded; its place as a point.
  // A speed limit the guide marks as missing or self-reported unknown is
  // left empty. Nothing else of the record is kept.
  await db.run(`
    CREATE TABLE collisions AS
    SELECT c.collision_index AS collision,
           strptime(c.date, '%d/%m/%Y')::DATE AS date,
           nullif(c.time, 'NULL') AS time,
           ${label("collision_severity")} AS severity,
           ${label("road_type")} AS road_type,
           CASE WHEN c.speed_limit IN ('-1', '99') THEN NULL ELSE TRY_CAST(c.speed_limit AS SMALLINT) END AS speed_limit,
           ${label("light_conditions")} AS light,
           ST_Point(CAST(c.longitude AS DOUBLE), CAST(c.latitude AS DOUBLE)) AS geom
    FROM raw c
    WHERE c.police_force IN (${Object.keys(LONDON_FORCES).map((k) => `'${k}'`).join(", ")})
      AND c.longitude NOT IN ('', 'NULL') AND c.latitude NOT IN ('', 'NULL')
    ORDER BY date, time, collision`);

  const [tally] = await db.rows(`
    SELECT (SELECT count(*) FROM raw)::INTEGER AS records,
           (SELECT count(*) FROM raw WHERE police_force IN (${Object.keys(LONDON_FORCES).map((k) => `'${k}'`).join(", ")}))::INTEGER AS london_records,
           count(*)::INTEGER AS collisions,
           count(*) FILTER (WHERE severity = 'Fatal')::INTEGER AS fatal,
           count(*) FILTER (WHERE severity = 'Serious')::INTEGER AS serious,
           count(*) FILTER (WHERE severity = 'Slight')::INTEGER AS slight,
           count(*) FILTER (WHERE severity IS NULL OR road_type IS NULL OR light IS NULL)::INTEGER AS undecoded,
           min(date)::VARCHAR AS first, max(date)::VARCHAR AS last,
           min(ST_X(geom)) AS west, max(ST_X(geom)) AS east, min(ST_Y(geom)) AS south, max(ST_Y(geom)) AS north
    FROM collisions`);
  if (tally.undecoded) throw new Error(`${tally.undecoded} collisions have a code the guide does not decode.`);
  if (tally.west < -0.6 || tally.east > 0.4 || tally.south < 51.2 || tally.north > 51.8) {
    throw new Error(`The collisions lie outside Greater London: ${JSON.stringify(tally)}.`);
  }
  if (!tally.first.startsWith(`${YEAR}-`) || !tally.last.startsWith(`${YEAR}-`)) throw new Error(`The dates run ${tally.first} to ${tally.last}.`);

  const outputs = {};
  const file = path.join(data, "collisions.parquet");
  await db.run(`COPY collisions TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  outputs.collisions = { file: path.relative(work, file), rows: tally.collisions, sha256: sha256(await readFile(file)) };

  const record = {
    template: "london-crash-hotspots",
    builtAt: new Date().toISOString(),
    slice: {
      year: YEAR,
      forces: Object.values(LONDON_FORCES),
      recordsInFile: tally.records,
      londonRecords: tally.london_records,
      collisions: tally.collisions,
      fatal: tally.fatal,
      serious: tally.serious,
      slight: tally.slight,
      dates: [tally.first, tally.last],
    },
    sources: {
      collisions: (({ path: p, ...f }) => f)(collisionsFile),
      guide: (({ path: p, ...f }) => f)(guideFile),
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`collisions: ${tally.collisions} in London of ${tally.records} (fatal ${tally.fatal}, serious ${tally.serious}, slight ${tally.slight})\n`);
} finally {
  db.close();
}
