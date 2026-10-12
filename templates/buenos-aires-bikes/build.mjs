// Build "Buenos Aires by shared bike": fetch the city's Ecobici trip
// records of 2026 from BA Data, the Buenos Aires city government's open
// data portal, and prepare the two datasets the map's SQL aggregates: the
// trips, and the stations they start and end at.
//
//   node templates/buenos-aires-bikes/build.mjs [work folder]
//
// Writes <work>/buenos-aires-bikes/data/{trips,stations}.parquet and
// <work>/buenos-aires-bikes/build-record.json (every address, when it was
// read, its bytes and SHA-256, and the rows that came out).

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256, USER_AGENT } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "buenos-aires-bikes");

// The catalogue record (licence, last change) and the 2026 trip file it
// lists, January to September 2026 as published on 7 October 2026. The
// city updates the file monthly under the same address, so the build
// record keeps its bytes and SHA-256.
const RECORD_ADDRESS = "https://data.buenosaires.gob.ar/api/3/action/package_show?id=bicicletas-publicas";
const TRIPS_ADDRESS = "https://cdn.buenosaires.gob.ar/datosabiertos/datasets/transporte-y-obras-publicas/bicicletas-publicas/recorridos-realizados-2026.zip";
const LICENCE = "CC-BY-2.5-AR";
const ENTRY = "trips.csv";
// The slice: every trip that started in the nine whole months the file
// holds when this template was made.
const FIRST = "2026-01-01";
const END = "2026-10-01";

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

// BA Data's portal sits behind a firewall that now and then answers 503
// or a "Request Rejected" page for a minute; the record is asked for
// again, up to four times, a little later each time.
async function patiently(label, address, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const fetched = await download(downloads, label, address, file);
      if (file.endsWith(".json")) JSON.parse(await readFile(fetched.path, "utf8"));
      return fetched;
    } catch (error) {
      if (attempt === 4) throw error;
      process.stderr.write(`${label}: ${error.message.slice(0, 120)}; asking again\n`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 20_000));
    }
  }
}
const recordFile = await patiently("record", RECORD_ADDRESS, "package.json");
const record = JSON.parse(await readFile(recordFile.path, "utf8")).result;
if (record.license_id !== LICENCE) throw new Error(`The catalogue record states ${record.license_id}, not ${LICENCE}.`);
const listed = record.resources.find((r) => r.url === TRIPS_ADDRESS);
if (!listed) throw new Error("The catalogue record no longer lists the 2026 trip file at the pinned address.");

// The server's own word for when the file last changed, kept beside its hash.
const head = await fetch(TRIPS_ADDRESS, { method: "HEAD", headers: { "user-agent": USER_AGENT } });
const lastModified = head.headers.get("last-modified");
const zip = await patiently("trips", TRIPS_ADDRESS, "recorridos-realizados-2026.zip");
process.stdout.write(`trips: ${zip.bytes} bytes\n`);

// The archive holds one CSV. It is unpacked by name into its own folder
// with the system's unzip, streamed to a file: nothing in it runs.
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn("unzip", args, { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`unzip ${args.join(" ")} exited ${code}`))));
});
const entries = (await run(["-Z1", zip.path])).split("\n").filter(Boolean);
if (entries.length !== 1 || entries[0] !== ENTRY) throw new Error(`The archive holds ${entries.join(", ")}, not ${ENTRY} alone.`);
const csv = path.join(path.dirname(zip.path), ENTRY);
{
  const child = spawn("unzip", ["-p", zip.path, ENTRY], { stdio: ["ignore", "pipe", "inherit"] });
  const closed = new Promise((resolve, reject) => child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`)))));
  await pipeline(child.stdout, createWriteStream(csv));
  await closed;
}

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'");
  await db.run("SET threads = 4");
  const columns = new Set((await db.rows(`DESCRIBE SELECT * FROM read_csv(${literal(csv)}, header = true, all_varchar = true)`)).map((c) => c.column_name));
  for (const needed of ["fecha_origen_recorrido", "duracion_recorrido", "id_estacion_origen", "id_estacion_destino",
    "nombre_estacion_origen", "nombre_estacion_destino", "long_estacion_origen", "lat_estacion_origen", "long_estacion_destino", "lat_estacion_destino"]) {
    if (!columns.has(needed)) throw new Error(`The trip records have no ${needed} column.`);
  }

  // Only what the map needs is read. The records also carry each rider's
  // user number and gender and the bicycle's model; none of them is kept.
  // Durations are written with a thousands comma ("13,541" seconds).
  await db.run(`
    CREATE TABLE raw AS
    SELECT CAST(fecha_origen_recorrido AS TIMESTAMP) AS started,
           CAST(replace(duracion_recorrido, ',', '') AS INTEGER) AS seconds,
           CAST(replace(id_estacion_origen, 'BAEcobici', '') AS SMALLINT) AS from_station,
           CAST(replace(id_estacion_destino, 'BAEcobici', '') AS SMALLINT) AS to_station,
           nombre_estacion_origen AS from_name, nombre_estacion_destino AS to_name,
           TRY_CAST(long_estacion_origen AS DOUBLE) AS from_lon, TRY_CAST(lat_estacion_origen AS DOUBLE) AS from_lat,
           TRY_CAST(long_estacion_destino AS DOUBLE) AS to_lon, TRY_CAST(lat_estacion_destino AS DOUBLE) AS to_lat
    FROM read_csv(${literal(csv)}, header = true, all_varchar = true)`);

  // The stations, from the trips themselves: each station's name and
  // position as most of its trips give them (a few stations moved a few
  // metres in the year, and one changed its name). A position outside the
  // city is not one: the depot, "[Valet] Galpón", where bikes go back to
  // the workshop, is recorded at 0, 0.
  await db.run(`
    CREATE TABLE ends AS
    SELECT from_station AS station, from_name AS name, from_lon AS lon, from_lat AS lat FROM raw
    UNION ALL
    SELECT to_station, to_name, to_lon, to_lat FROM raw`);
  await db.run(`
    CREATE TABLE stations AS
    SELECT p.station AS station_id, n.name, ST_Point(round(p.lon, 6), round(p.lat, 6)) AS geom
    FROM (SELECT station, arg_max(lon, n) AS lon, arg_max(lat, n) AS lat FROM (
            SELECT station, lon, lat, count(*) AS n FROM ends
            WHERE lon BETWEEN -58.6 AND -58.3 AND lat BETWEEN -34.75 AND -34.5 GROUP BY ALL)
          GROUP BY station) p
    JOIN (SELECT station, mode(name) AS name FROM ends WHERE name IS NOT NULL GROUP BY station) n USING (station)
    ORDER BY station_id`);

  // One row per trip that started in the nine months between two stations
  // with a place in the city: the start, to the minute, the ride's length
  // in minutes, and the two stations.
  await db.run(`
    CREATE TABLE trips AS
    SELECT date_trunc('minute', started) AS started,
           CAST(round(seconds / 60.0, 1) AS DECIMAL(7, 1)) AS minutes,
           from_station, to_station
    FROM raw
    WHERE started >= TIMESTAMP '${FIRST}' AND started < TIMESTAMP '${END}' AND seconds >= 0
      AND from_station IN (SELECT station_id FROM stations) AND to_station IN (SELECT station_id FROM stations)
    ORDER BY started, from_station, to_station`);

  const [tally] = await db.rows(`
    SELECT (SELECT count(*) FROM raw)::INTEGER AS records,
           count(*)::INTEGER AS trips,
           count(*) FILTER (WHERE from_station = to_station)::INTEGER AS round_trips,
           count(*) FILTER (WHERE dayofweek(started) IN (0, 6))::INTEGER AS weekend_trips,
           min(started)::VARCHAR AS first, max(started)::VARCHAR AS last,
           (SELECT count(*) FROM raw WHERE started < TIMESTAMP '${FIRST}' OR started >= TIMESTAMP '${END}')::INTEGER AS outside_months,
           (SELECT count(*) FROM raw WHERE seconds < 0)::INTEGER AS negative_duration,
           (SELECT count(*) FROM raw WHERE from_station IS NULL OR to_station IS NULL)::INTEGER AS without_a_station,
           (SELECT count(*) FROM raw WHERE from_station NOT IN (SELECT station_id FROM stations)
                                        OR to_station NOT IN (SELECT station_id FROM stations))::INTEGER AS at_a_station_without_a_place
    FROM trips`);
  const [places] = await db.rows(`
    SELECT count(*)::INTEGER AS stations,
           (SELECT count(DISTINCT station) FROM ends WHERE station IS NOT NULL)::INTEGER AS in_the_records,
           min(ST_X(geom)) AS west, max(ST_X(geom)) AS east, min(ST_Y(geom)) AS south, max(ST_Y(geom)) AS north
    FROM stations`);
  const placeless = await db.rows(`
    SELECT DISTINCT station::INTEGER AS station, name FROM ends
    WHERE station IS NOT NULL AND station NOT IN (SELECT station_id FROM stations) AND name IS NOT NULL`);
  if (places.in_the_records - places.stations > 1) throw new Error(`${places.in_the_records - places.stations} stations have no place in the city: ${JSON.stringify(placeless)}.`);
  // The city lies between 58.54 and 58.33 west and 34.71 and 34.52 south.
  if (places.west < -58.6 || places.east > -58.3 || places.south < -34.75 || places.north > -34.5) {
    throw new Error(`The stations fall outside Buenos Aires: ${JSON.stringify(places)}.`);
  }

  const outputs = {};
  for (const [name, rows] of [["trips", tally.trips], ["stations", places.stations]]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    outputs[name] = { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
  }

  const strip = ({ path: p, ...f }) => f;
  const built = {
    template: "buenos-aires-bikes",
    builtAt: new Date().toISOString(),
    slice: { from: FIRST, until: END, ...tally, ...places, stationsWithoutAPlace: placeless },
    licence: { record: record.license_id, recordModified: record.metadata_modified, resource: { name: listed.name, lastModified: listed.last_modified ?? null } },
    sources: { record: strip(recordFile), trips: { ...strip(zip), lastModified } },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(built, null, 2) + "\n");
  process.stdout.write(`trips: ${tally.trips} of ${tally.records} records, ${tally.first} to ${tally.last}; stations: ${places.stations}\n`);
} finally {
  db.close();
}
// The downloads are deleted once the GeoParquet is built; the build record
// keeps their addresses, sizes and hashes.
await rm(downloads, { recursive: true, force: true });
