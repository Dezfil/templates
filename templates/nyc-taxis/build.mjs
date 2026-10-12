// Build "Where New York's taxis go": fetch one month of yellow taxi trip
// records and the taxi zones from the NYC Taxi & Limousine Commission and
// prepare the two datasets the map's SQL aggregates.
//
//   node templates/nyc-taxis/build.mjs [work folder]
//
// Writes <work>/nyc-taxis/data/{trips,taxi_zones}.parquet and
// <work>/nyc-taxis/build-record.json (every address, when it was read, its
// bytes and SHA-256, and the rows that came out).

import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "nyc-taxis");

// The slice: every yellow taxi trip picked up in August 2026, the most
// recent whole month the TLC had published when this template was made.
// The records carry each trip's pickup and drop-off taxi zone, not its
// coordinates; the map joins them to the zones.
const MONTH = "2026-08";
const NEXT_MONTH = "2026-09";
const TRIPS_ADDRESS = `https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_${MONTH}.parquet`;
const ZONES_ADDRESS = "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zones.zip";
const LOOKUP_ADDRESS = "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv";
// The zones' shapes in their own projection, New York State Plane Long
// Island (feet), simplified by about two metres for drawing.
const SIMPLIFY_DEGREES = 0.00002;

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const tripsFile = await download(downloads, "trips", TRIPS_ADDRESS, `yellow_tripdata_${MONTH}.parquet`);
const zonesFile = await download(downloads, "zones", ZONES_ADDRESS, "taxi_zones.zip");
const lookupFile = await download(downloads, "lookup", LOOKUP_ADDRESS, "taxi_zone_lookup.csv");
process.stdout.write(`trips: ${tripsFile.bytes} bytes; zones: ${zonesFile.bytes} bytes; lookup: ${lookupFile.bytes} bytes\n`);

const db = await engine();
try {
  const columns = new Set((await db.rows(`DESCRIBE SELECT * FROM read_parquet(${literal(tripsFile.path)})`)).map((c) => c.column_name));
  for (const needed of ["tpep_pickup_datetime", "PULocationID", "DOLocationID", "fare_amount"]) {
    if (!columns.has(needed)) throw new Error(`The trip records have no ${needed} column.`);
  }

  // One row per trip picked up in the month: the two zones, the hour of the
  // pickup and the metered fare. Nothing else of the record is kept.
  await db.run(`
    CREATE TABLE trips AS
    SELECT CAST(PULocationID AS SMALLINT) AS pickup_zone,
           CAST(DOLocationID AS SMALLINT) AS dropoff_zone,
           CAST(hour(tpep_pickup_datetime) AS TINYINT) AS pickup_hour,
           CAST(round(fare_amount, 2) AS DECIMAL(8, 2)) AS fare
    FROM read_parquet(${literal(tripsFile.path)})
    WHERE tpep_pickup_datetime >= TIMESTAMP '${MONTH}-01' AND tpep_pickup_datetime < TIMESTAMP '${NEXT_MONTH}-01'
      AND PULocationID IS NOT NULL AND DOLocationID IS NOT NULL
    ORDER BY pickup_zone, dropoff_zone, pickup_hour, fare`);
  const [tally] = await db.rows(`
    SELECT (SELECT count(*) FROM read_parquet(${literal(tripsFile.path)}))::INTEGER AS records,
           count(*)::INTEGER AS trips,
           count(*) FILTER (WHERE pickup_zone >= 264 OR dropoff_zone >= 264)::INTEGER AS unknown_zone,
           count(*) FILTER (WHERE pickup_zone = dropoff_zone)::INTEGER AS same_zone,
           count(*) FILTER (WHERE fare <= 0)::INTEGER AS no_fare
    FROM trips`);

  // The zones: the TLC's shapes, reprojected to longitude and latitude, with
  // the TLC's own borough and service zone from its lookup table.
  await db.run(`
    CREATE TABLE lookup AS
    SELECT CAST(LocationID AS SMALLINT) AS location_id, Borough AS borough, Zone AS zone, service_zone
    FROM read_csv(${literal(lookupFile.path)}, header = true, all_varchar = true)`);
  await db.run(`
    CREATE TABLE taxi_zones AS
    SELECT CAST(s.LocationID AS SMALLINT) AS location_id, s.zone, s.borough, l.service_zone,
           ST_ReducePrecision(ST_SimplifyPreserveTopology(
             ST_Transform(s.geom, 'EPSG:2263', 'EPSG:4326', always_xy := true), ${SIMPLIFY_DEGREES}), 0.000001) AS geom
    FROM ST_Read(${literal(`/vsizip/${zonesFile.path}/taxi_zones/taxi_zones.shp`)}) s
    JOIN lookup l ON l.location_id = s.LocationID
    ORDER BY location_id`);
  const [zones] = await db.rows(`
    SELECT count(*)::INTEGER AS zones, count(DISTINCT location_id)::INTEGER AS ids,
           (SELECT count(*) FROM lookup WHERE location_id NOT IN (SELECT location_id FROM taxi_zones))::INTEGER AS unmapped,
           min(ST_XMin(geom)) AS west, max(ST_XMax(geom)) AS east, min(ST_YMin(geom)) AS south, max(ST_YMax(geom)) AS north
    FROM taxi_zones`);
  if (zones.zones !== zones.ids) throw new Error("A zone id appears twice.");
  if (zones.west < -74.3 || zones.east > -73.6 || zones.south < 40.4 || zones.north > 41) {
    throw new Error(`The zones reprojected outside New York: ${JSON.stringify(zones)}.`);
  }

  const outputs = {};
  for (const [name, rows] of [["trips", tally.trips], ["taxi_zones", zones.zones]]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    outputs[name] = { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
  }

  const record = {
    template: "nyc-taxis",
    builtAt: new Date().toISOString(),
    slice: {
      month: MONTH,
      recordsInFile: tally.records,
      tripsInMonth: tally.trips,
      tripsWithAnUnknownZone: tally.unknown_zone,
      tripsWithinOneZone: tally.same_zone,
      tripsWithoutAFare: tally.no_fare,
      zones: zones.zones,
      lookupIdsWithoutAShape: zones.unmapped,
      simplifiedByDegrees: SIMPLIFY_DEGREES,
    },
    sources: {
      trips: (({ path: p, ...f }) => f)(tripsFile),
      zones: (({ path: p, ...f }) => f)(zonesFile),
      lookup: (({ path: p, ...f }) => f)(lookupFile),
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`trips: ${tally.trips} of ${tally.records} records in ${MONTH}; zones: ${zones.zones}\n`);
} finally {
  db.close();
}
