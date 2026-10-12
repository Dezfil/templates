// Build "Forty years of big earthquakes": fetch both sources from their
// publishers at pinned addresses and prepare the two datasets the map draws.
//
//   node templates/earthquakes/build.mjs [work folder]
//
// Writes <work>/earthquakes/data/{earthquakes,plate_boundaries}.parquet and
// <work>/earthquakes/build-record.json (every address, when it was read, its
// bytes and SHA-256, and the rows that came out).

import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "earthquakes");

// The slice: every earthquake of magnitude 5 or more in forty whole
// calendar years, 1986 to 2025 (UTC). Whole past years, so the catalogue's
// reviewed solutions are what ships.
const FIRST_YEAR = 1986;
const LAST_YEAR = 2025;
const MIN_MAGNITUDE = 5;

// The USGS FDSN event service answers at most 20,000 events a query, so
// the catalogue is read one year per request.
const quakeAddress = (year) =>
  "https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv" +
  `&starttime=${year}-01-01T00:00:00&endtime=${year}-12-31T23:59:59.999` +
  `&minmagnitude=${MIN_MAGNITUDE}&eventtype=earthquake&orderby=time-asc`;

// PB2002 plate boundaries as converted by Hugo Ahlenius (Nordpil), at a
// pinned commit of the publisher's repository.
const PLATES_COMMIT = "339b0c56563c118307b1f4542703047f5f698fae";
const PLATES_ADDRESS = `https://raw.githubusercontent.com/fraxen/tectonicplates/${PLATES_COMMIT}/GeoJSON/PB2002_boundaries.json`;

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const quakeFiles = [];
for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
  const fetched = await download(downloads, `usgs-${year}`, quakeAddress(year), `${year}.csv`);
  quakeFiles.push({ year, ...fetched });
  process.stdout.write(`usgs ${year}: ${fetched.bytes} bytes\n`);
}
const plates = await download(downloads, "pb2002", PLATES_ADDRESS, "PB2002_boundaries.json");
process.stdout.write(`plates: ${plates.bytes} bytes\n`);

const db = await engine();
try {
  // Every column is read as text and typed here, so the shape never rests
  // on what the reader guesses from a year's sample.
  const csvs = `[${quakeFiles.map((f) => literal(f.path)).join(", ")}]`;
  await db.run(`
    CREATE TABLE raw AS
    SELECT * FROM read_csv(${csvs}, header = true, all_varchar = true, filename = true)`);
  for (const file of quakeFiles) {
    const [{ n }] = await db.rows(`SELECT count(*)::INTEGER AS n FROM raw WHERE filename = ${literal(file.path)}`);
    file.rows = n;
    if (n >= 20000) throw new Error(`${file.year} answered ${n} events: at the service's limit, so the year may be cut.`);
  }
  await db.run(`
    CREATE TABLE earthquakes AS
    SELECT
      id,
      CAST(replace(time, 'Z', '') AS TIMESTAMP) AS time_utc,
      CAST(year(CAST(replace(time, 'Z', '') AS TIMESTAMP)) AS INTEGER) AS year,
      CAST(mag AS DOUBLE) AS magnitude,
      magType AS magnitude_type,
      CAST(depth AS DOUBLE) AS depth_km,
      CASE
        WHEN CAST(depth AS DOUBLE) < 70 THEN 'Shallow, under 70 km'
        WHEN CAST(depth AS DOUBLE) < 300 THEN 'Intermediate, 70 to 300 km'
        ELSE 'Deep, 300 km or more'
      END AS depth_class,
      NULLIF(place, '') AS place,
      ST_Point(CAST(longitude AS DOUBLE), CAST(latitude AS DOUBLE)) AS geom
    FROM raw
    WHERE type = 'earthquake' AND CAST(mag AS DOUBLE) >= ${MIN_MAGNITUDE}
    ORDER BY time_utc, id`);
  const [{ total, distinct_ids, first, last, min_mag }] = await db.rows(`
    SELECT count(*)::INTEGER AS total, count(DISTINCT id)::INTEGER AS distinct_ids,
           min(time_utc)::VARCHAR AS first, max(time_utc)::VARCHAR AS last, min(magnitude) AS min_mag
    FROM earthquakes`);
  if (total !== distinct_ids) throw new Error(`${total - distinct_ids} events appear twice.`);
  if (!first.startsWith(`${FIRST_YEAR}-`) || !last.startsWith(`${LAST_YEAR}-`)) throw new Error(`The events run ${first} to ${last}.`);

  await db.run(`
    CREATE TABLE plate_boundaries AS
    SELECT
      Name AS name,
      PlateA AS plate_a,
      PlateB AS plate_b,
      CASE WHEN Type = 'subduction' THEN 'Subduction zone' ELSE 'Other plate boundary' END AS boundary_type,
      Source AS segment_source,
      geom
    FROM ST_Read(${literal(plates.path)})`);
  const [{ boundaries }] = await db.rows(`SELECT count(*)::INTEGER AS boundaries FROM plate_boundaries`);

  const outputs = {};
  for (const [name, rows] of [["earthquakes", total], ["plate_boundaries", boundaries]]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    outputs[name] = { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
  }

  const record = {
    template: "earthquakes",
    builtAt: new Date().toISOString(),
    slice: { years: [FIRST_YEAR, LAST_YEAR], minMagnitude: MIN_MAGNITUDE, eventType: "earthquake", first, last, minMagnitudeFound: min_mag },
    sources: {
      usgs: quakeFiles.map(({ path: p, ...f }) => f),
      plates: (({ path: p, ...f }) => ({ ...f, rows: boundaries }))(plates),
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`earthquakes: ${total} rows, ${first} to ${last}; plate boundaries: ${boundaries}\n`);
} finally {
  db.close();
}
