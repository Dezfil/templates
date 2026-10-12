// Build "Tokyo's heart in 3D": take Chiyoda's buildings from the 3D city
// model of Tokyo's 23 wards (Project PLATEAU, the Ministry of Land,
// Infrastructure, Transport and Tourism) and prepare the one dataset the map
// raises: every building in the ward, its roof outline and its measured
// height.
//
//   node templates/tokyo-3d/build.mjs [work folder]
//
// The 23 wards' CityGML is one 5.3 GB archive. The build reads its
// directory and fetches by range only the members holding the buildings of
// the grid squares that cover Chiyoda, about 124 MB of it, reads each and
// deletes it. Writes <work>/tokyo-3d/data/buildings.parquet and
// <work>/tokyo-3d/build-record.json.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { engine, literal, sha256 } from "../../tools/source.mjs";
import { fetchMember, readBuildings, remoteDirectory } from "./plateau.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "tokyo-3d");

// The archive the catalogue record lists as "CityGML (v2)" for the 23
// wards (G-spatial information center, dataset plateau-tokyo23ku), and the
// prefix of its building models: one file per third-order grid square
// (about 1.1 by 0.9 km), named by the square's code.
const ARCHIVE_ADDRESS = "https://assets.cms.plateau.reearth.io/assets/ec/d51c64-a47f-4a56-aa64-340d1d3c720b/13100_tokyo23-ku_2020_citygml_4_2_op.zip";
const BUILDINGS = "13100_tokyo23-ku_2020_citygml_4_2_op/udx/bldg/";

// The slice: Chiyoda, ward 13101, the heart of Tokyo (the Imperial Palace,
// Marunouchi and Otemachi, Kasumigaseki, Akihabara and Kanda). Its
// buildings lie inside this box; the grid squares are those the box
// touches, and the build checks that no building of the ward reaches the
// box's edge, so none was left in a square outside it.
const WARD = { code: "13101", name: "Chiyoda" };
const BOX = { south: 35.662, north: 35.708, west: 139.724, east: 139.789 };

/** The third-order (1 km) grid square code of a point, Japan's standard
 * grid (JIS X 0410). */
function gridSquare(lat, lon) {
  const p = Math.floor(lat * 1.5);
  const u = Math.floor(lon - 100);
  const a = lat * 1.5 - p;
  const b = lon - 100 - u;
  const q = Math.floor(a * 8);
  const v = Math.floor(b * 8);
  const r = Math.floor((a * 8 - q) * 10);
  const w = Math.floor((b * 8 - v) * 10);
  return `${p}${u}${q}${v}${r}${w}`;
}

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const directory = await remoteDirectory(ARCHIVE_ADDRESS);
const squares = new Set();
for (let lat = BOX.south; lat <= BOX.north + 1e-9; lat += 1 / 240) {
  for (let lon = BOX.west; lon <= BOX.east + 1e-9; lon += 1 / 160) squares.add(gridSquare(lat, lon));
  squares.add(gridSquare(lat, BOX.east));
}
for (let lon = BOX.west; lon <= BOX.east + 1e-9; lon += 1 / 160) squares.add(gridSquare(BOX.north, lon));
squares.add(gridSquare(BOX.north, BOX.east));
const wanted = [...squares].sort().map((square) => `${BUILDINGS}${square}_bldg_6697_2_op.gml`).filter((name) => directory.members.has(name));
process.stdout.write(`archive: ${directory.size} bytes, ${directory.members.size} members; ${wanted.length} building files for ${squares.size} grid squares\n`);

const rows = [];
const members = [];
let otherWards = 0;
let withParts = 0;
for (const name of wanted) {
  const square = name.slice(BUILDINGS.length, BUILDINGS.length + 8);
  const fetched = await fetchMember(downloads, `bldg-${square}`, directory, name, `${square}.gml`);
  const read = readBuildings(await readFile(fetched.path, "utf8"));
  await rm(path.dirname(fetched.path), { recursive: true, force: true });
  const mine = read.buildings.filter((b) => b.city === WARD.code);
  otherWards += read.buildings.length - mine.length;
  withParts += read.withParts;
  for (const b of mine) rows.push({ ...b, square });
  const { path: _, ...kept } = fetched;
  members.push({ ...kept, buildings: read.buildings.length, inWard: mine.length });
  process.stdout.write(`${square}: ${read.buildings.length} buildings, ${mine.length} in ${WARD.name}\n`);
}
await rm(downloads, { recursive: true, force: true });
if (withParts) throw new Error(`${withParts} buildings have parts; the build reads whole buildings only.`);

const db = await engine();
try {
  const rowsFile = path.join(work, "buildings.ndjson");
  await writeFile(rowsFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await db.run(`CREATE TABLE raw AS SELECT * FROM read_json(${literal(rowsFile)}, format = 'newline_delimited', columns = {id: 'VARCHAR', name: 'VARCHAR', height: 'DOUBLE', city: 'VARCHAR', surveyYear: 'INTEGER', wkt: 'VARCHAR', square: 'VARCHAR'})`);
  await rm(rowsFile);

  // One row per building: its id in the model, its name where the model
  // gives one, its measured height, a height band for the widget, and its
  // roof outline. (Every building of the ward was surveyed in the same
  // year, which the record keeps rather than a column of one value.) A building with no outline
  // or no height has nothing to raise and is left out (counted below).
  await db.run(`
    CREATE TABLE buildings AS
    SELECT id AS building,
           name,
           round(height, 1) AS height_m,
           CASE
             WHEN height < 10 THEN 'Under 10 m'
             WHEN height < 30 THEN '10 to 30 m'
             WHEN height < 60 THEN '30 to 60 m'
             WHEN height < 100 THEN '60 to 100 m'
             ELSE '100 m and over'
           END AS height_band,
           ST_ReducePrecision(ST_MakeValid(ST_GeomFromText(wkt)), 0.0000001) AS geom
    FROM raw
    WHERE wkt IS NOT NULL AND height IS NOT NULL AND height > 0
    QUALIFY row_number() OVER (PARTITION BY id ORDER BY square) = 1
    ORDER BY height_m`);
  const [tally] = await db.rows(`
    SELECT (SELECT count(*) FROM raw)::INTEGER AS in_ward,
           (SELECT count(DISTINCT id) FROM raw)::INTEGER AS ids,
           (SELECT count(*) FROM raw WHERE wkt IS NULL OR height IS NULL OR height <= 0)::INTEGER AS no_outline_or_height,
           count(*)::INTEGER AS buildings,
           count(name)::INTEGER AS named,
           max(height_m) AS tallest,
           round(median(height_m), 1) AS median,
           count(*) FILTER (WHERE height_m >= 100)::INTEGER AS over_100,
           (SELECT min(surveyYear) FROM raw) AS first_survey, (SELECT max(surveyYear) FROM raw) AS last_survey,
           count(*) FILTER (WHERE NOT ST_IsValid(geom) OR ST_IsEmpty(geom))::INTEGER AS bad,
           min(ST_XMin(geom)) AS west, max(ST_XMax(geom)) AS east, min(ST_YMin(geom)) AS south, max(ST_YMax(geom)) AS north
    FROM buildings`);
  if (tally.bad) throw new Error(`${tally.bad} outlines are invalid or empty.`);
  const margin = 0.002;
  if (tally.west < BOX.west + margin || tally.east > BOX.east - margin || tally.south < BOX.south + margin || tally.north > BOX.north - margin) {
    throw new Error(`${WARD.name}'s buildings reach the edge of the box: ${JSON.stringify(tally)}.`);
  }
  const [{ name: tallestName }] = await db.rows("SELECT coalesce(name, building) AS name FROM buildings ORDER BY height_m DESC LIMIT 1");

  const outputs = {};
  const file = path.join(data, "buildings.parquet");
  await db.run(`COPY buildings TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  outputs.buildings = { file: path.relative(work, file), rows: tally.buildings, sha256: sha256(await readFile(file)) };

  const record = {
    template: "tokyo-3d",
    builtAt: new Date().toISOString(),
    slice: {
      ward: WARD,
      box: BOX,
      gridSquares: wanted.length,
      buildingsInTheSquares: rows.length + otherWards,
      buildingsInWard: tally.in_ward,
      distinctIds: tally.ids,
      leftOutNoOutlineOrHeight: tally.no_outline_or_height,
      buildings: tally.buildings,
      named: tally.named,
      tallestMetres: tally.tallest,
      tallest: tallestName,
      medianMetres: tally.median,
      hundredMetresAndOver: tally.over_100,
      surveyYears: [tally.first_survey, tally.last_survey],
    },
    sources: {
      archive: { url: ARCHIVE_ADDRESS, bytes: directory.size, lastModified: directory.lastModified },
      members,
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`buildings: ${tally.buildings} in ${WARD.name} (tallest ${tally.tallest} m, ${tallestName}; median ${tally.median} m; ${tally.over_100} at 100 m or more)\n`);
} finally {
  db.close();
}
