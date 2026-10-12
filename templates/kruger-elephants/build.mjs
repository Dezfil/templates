// Build "Kruger's elephants and the heat": fetch the GPS fixes of fourteen
// elephant herds in Kruger National Park, with the temperature their
// collars measured, from the Movebank Data Repository, and prepare the one
// dataset the map's SQL draws its tracks from.
//
//   node templates/kruger-elephants/build.mjs [work folder]
//
// Writes <work>/kruger-elephants/data/elephant_fixes.parquet and
// <work>/kruger-elephants/build-record.json (every address, when it was
// read, its bytes and SHA-256, and the rows that came out).

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "kruger-elephants");

// The data package doi:10.5441/001/1.403h24q5 (Slotow, Thaker and Vanak
// 2019), its data file "ThermochronTracking Elephants Kruger 2007"
// (handle 10255/move.981). The repository's API answers the item's record
// (its licence) and the bundle's file list (each file's MD5); the files
// themselves are read at their pinned bitstream addresses.
const API = "https://datarepository.movebank.org/server/api";
const ITEM_ADDRESS = `${API}/pid/find?id=hdl:10255/move.981`;
const FILES_ADDRESS = `${API}/core/bundles/82133439-dc84-40db-a67e-4d99fc5bc9ff/bitstreams`;
const DATA_NAME = "ThermochronTracking Elephants Kruger 2007.csv";
const DATA_ADDRESS = `${API}/core/bitstreams/10240da1-0a99-42bf-a34f-eff15883bbfb/content`;
const README_ADDRESS = `${API}/core/bitstreams/09bb9678-356b-4bff-a950-cfa9217fc240/content`;
const LICENCE = "CC0 1.0 Universal";

// The collars log in UTC (or GPS time, a few seconds off it); Kruger keeps
// South African Standard Time, two hours ahead all year, with no summer
// time. The map reads local time, so "the heat of the day" is the
// afternoon a ranger would recognise.
const LOCAL_OFFSET_HOURS = 2;

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const itemFile = await download(downloads, "item", ITEM_ADDRESS, "item.json");
const item = JSON.parse(await readFile(itemFile.path, "utf8"));
const rights = item.metadata?.["dc.rights"]?.map((r) => r.value);
const doi = item.metadata?.["dc.identifier.doi"]?.[0]?.value;
if (!rights?.includes(LICENCE)) throw new Error(`The repository's record states ${JSON.stringify(rights)}, not ${LICENCE}.`);
if (doi !== "doi:10.5441/001/1.403h24q5") throw new Error(`The record is ${doi}, not the data package the template names.`);

const filesFile = await download(downloads, "files", FILES_ADDRESS, "bitstreams.json");
const listed = JSON.parse(await readFile(filesFile.path, "utf8"))._embedded.bitstreams;
const dataEntry = listed.find((b) => b.name === DATA_NAME);
if (!dataEntry || !DATA_ADDRESS.startsWith(dataEntry._links.content.href.replace(/\/content$/, ""))) {
  throw new Error(`The bundle no longer lists ${DATA_NAME} at the pinned address.`);
}

const readme = await download(downloads, "readme", README_ADDRESS, "README.txt");
const readmeText = await readFile(readme.path, "utf8");
if (!readmeText.includes("This data file is licensed by the Creative Commons Zero (CC0 1.0) license.")) {
  throw new Error("The data package's README no longer states the CC0 1.0 licence.");
}

const csv = await download(downloads, "fixes", DATA_ADDRESS, "fixes.csv");
const md5 = createHash("md5").update(await readFile(csv.path)).digest("hex");
if (md5 !== dataEntry.checkSum.value) throw new Error(`The data file's MD5 is ${md5}; the repository lists ${dataEntry.checkSum.value}.`);
process.stdout.write(`fixes: ${csv.bytes} bytes, MD5 as listed\n`);

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'");
  await db.run("SET threads = 4");
  await db.run(`
    CREATE TABLE raw AS
    SELECT * FROM read_csv(${literal(csv.path)}, header = true, columns = {
      'event-id': 'BIGINT', 'visible': 'BOOLEAN', 'timestamp': 'TIMESTAMP',
      'location-long': 'DOUBLE', 'location-lat': 'DOUBLE', 'external-temperature': 'DOUBLE',
      'sensor-type': 'VARCHAR', 'individual-taxon-canonical-name': 'VARCHAR',
      'tag-local-identifier': 'VARCHAR', 'individual-local-identifier': 'VARCHAR', 'study-name': 'VARCHAR'})`);
  const [tally] = await db.rows(`
    SELECT count(*)::INTEGER AS records,
           count(*) FILTER (WHERE NOT visible)::INTEGER AS hidden,
           count(*) FILTER (WHERE "location-long" IS NULL OR "location-lat" IS NULL)::INTEGER AS without_position,
           count(*) FILTER (WHERE "external-temperature" IS NULL)::INTEGER AS without_temperature,
           count(*) FILTER (WHERE "external-temperature" <> round("external-temperature"))::INTEGER AS fractional,
           count(DISTINCT "individual-local-identifier")::INTEGER AS herds,
           count(*) FILTER (WHERE "individual-taxon-canonical-name" <> 'Loxodonta africana' OR "sensor-type" <> 'gps')::INTEGER AS other,
           (count(*) - count(DISTINCT ("individual-local-identifier", timestamp)))::INTEGER AS repeated,
           min(timestamp)::VARCHAR AS first, max(timestamp)::VARCHAR AS last
    FROM raw`);
  if (tally.fractional) throw new Error("Some temperatures are not whole degrees; the dataset keeps them as whole numbers.");
  if (tally.other) throw new Error(`${tally.other} records are not an elephant's GPS fix.`);

  // One row per fix: the herd's collar, the local time, the temperature the
  // collar measured and the position. Nothing else of the record is kept.
  await db.run(`
    CREATE TABLE elephant_fixes AS
    SELECT "individual-local-identifier" AS herd,
           timestamp + INTERVAL ${LOCAL_OFFSET_HOURS} HOUR AS time_local,
           CAST("external-temperature" AS SMALLINT) AS temperature_c,
           ST_Point(round("location-long", 5), round("location-lat", 5)) AS geom
    FROM raw
    WHERE visible AND "location-long" IS NOT NULL AND "location-lat" IS NOT NULL AND "external-temperature" IS NOT NULL
    ORDER BY herd, time_local`);
  const [kept] = await db.rows(`
    SELECT count(*)::INTEGER AS fixes, count(DISTINCT herd)::INTEGER AS herds,
           min(time_local)::VARCHAR AS first_local, max(time_local)::VARCHAR AS last_local,
           min(temperature_c)::INTEGER AS coolest, max(temperature_c)::INTEGER AS hottest,
           min(ST_X(geom)) AS west, max(ST_X(geom)) AS east, min(ST_Y(geom)) AS south, max(ST_Y(geom)) AS north
    FROM elephant_fixes`);
  // Kruger lies between 30.9 and 32.1 east and 22.3 and 25.6 south.
  if (kept.west < 30.8 || kept.east > 32.1 || kept.south < -25.6 || kept.north > -22.3) {
    throw new Error(`The fixes fall outside Kruger: ${JSON.stringify(kept)}.`);
  }

  const outputs = {};
  const file = path.join(data, "elephant_fixes.parquet");
  await db.run(`COPY elephant_fixes TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  outputs.elephant_fixes = { file: path.relative(work, file), rows: kept.fixes, sha256: sha256(await readFile(file)) };

  const strip = ({ path: p, ...f }) => f;
  const record = {
    template: "kruger-elephants",
    builtAt: new Date().toISOString(),
    slice: {
      recordsInFile: tally.records,
      hidden: tally.hidden,
      withoutPosition: tally.without_position,
      withoutTemperature: tally.without_temperature,
      repeatedTimes: tally.repeated,
      fixes: kept.fixes,
      herds: kept.herds,
      firstLocal: kept.first_local,
      lastLocal: kept.last_local,
      coolestC: kept.coolest,
      hottestC: kept.hottest,
      localOffsetHours: LOCAL_OFFSET_HOURS,
      bounds: { west: kept.west, east: kept.east, south: kept.south, north: kept.north },
    },
    licence: { record: rights, doi },
    sources: {
      item: strip(itemFile),
      files: strip(filesFile),
      readme: strip(readme),
      fixes: { ...strip(csv), md5 },
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`fixes: ${kept.fixes} of ${tally.records} records, ${kept.herds} herds, ${kept.first_local} to ${kept.last_local}\n`);
} finally {
  db.close();
}
// The downloads are deleted once the GeoParquet is built; the build record
// keeps their addresses, sizes and hashes.
await rm(downloads, { recursive: true, force: true });
