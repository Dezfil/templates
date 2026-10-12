// Build "The world's air routes": fetch the OpenFlights route and airport
// databases from the publisher's repository at a pinned commit and prepare
// the two datasets the map draws.
//
//   node templates/air-routes/build.mjs [work folder]
//
// Writes <work>/air-routes/data/{air_routes,airports}.parquet and
// <work>/air-routes/build-record.json (every address, when it was read, its
// bytes and SHA-256, and the rows that came out).

import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "air-routes");

// The OpenFlights data as its repository held it at this commit. The route
// database stopped in June 2014 ("of historical value only", openflights.org/data);
// the airport database was last revised in 2019.
const COMMIT = "7d1a611e070295dba776d6afb86e57d0d1aa1cef";
const address = (file) => `https://raw.githubusercontent.com/jpatokal/openflights/${COMMIT}/data/${file}`;

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const routesFile = await download(downloads, "routes", address("routes.dat"), "routes.dat");
const airportsFile = await download(downloads, "airports", address("airports.dat"), "airports.dat");
process.stdout.write(`routes: ${routesFile.bytes} bytes; airports: ${airportsFile.bytes} bytes\n`);

const db = await engine();
try {
  // Both files are headerless CSV with \N for a missing value; every column
  // is read as text and typed here.
  await db.run(`
    CREATE TABLE raw_routes AS
    SELECT * FROM read_csv(${literal(routesFile.path)}, header = false, all_varchar = true, nullstr = '\\N', quote = '"',
      columns = {'airline': 'VARCHAR', 'airline_id': 'VARCHAR', 'source': 'VARCHAR', 'source_id': 'VARCHAR',
                 'destination': 'VARCHAR', 'destination_id': 'VARCHAR', 'codeshare': 'VARCHAR', 'stops': 'VARCHAR',
                 'equipment': 'VARCHAR'})`);
  await db.run(`
    CREATE TABLE raw_airports AS
    SELECT * FROM read_csv(${literal(airportsFile.path)}, header = false, all_varchar = true, nullstr = '\\N', quote = '"', escape = '"',
      columns = {'id': 'VARCHAR', 'name': 'VARCHAR', 'city': 'VARCHAR', 'country': 'VARCHAR', 'iata': 'VARCHAR',
                 'icao': 'VARCHAR', 'latitude': 'VARCHAR', 'longitude': 'VARCHAR', 'altitude': 'VARCHAR',
                 'utc_offset': 'VARCHAR', 'dst': 'VARCHAR', 'tz': 'VARCHAR', 'type': 'VARCHAR', 'source': 'VARCHAR'})`);

  await db.run(`
    CREATE TABLE places AS
    SELECT CAST(id AS INTEGER) AS id, name, city, country, iata,
           round(CAST(latitude AS DOUBLE), 4) AS lat, round(CAST(longitude AS DOUBLE), 4) AS lon
    FROM raw_airports`);

  // Each route's two airports by the IATA code the route names, which the
  // airport database holds once each. The airport ids the routes carry are
  // not used: since 2014 some of them point at rows the database has since
  // rewritten as another airport. Routes whose code the database no longer
  // holds are left out and counted. Nonstop routes only; a codeshare (sold
  // by one airline, flown by another) is not a second airline on the pair.
  const [{ shared }] = await db.rows(`SELECT count(*)::INTEGER AS shared FROM (SELECT iata FROM places WHERE iata IS NOT NULL GROUP BY iata HAVING count(*) > 1)`);
  if (shared) throw new Error(`${shared} IATA codes name more than one airport.`);
  await db.run(`
    CREATE TABLE flown AS
    SELECT r.airline, a.id AS a_id, b.id AS b_id, coalesce(r.codeshare, '') = 'Y' AS codeshare
    FROM raw_routes r
    LEFT JOIN places a ON a.iata = r.source
    LEFT JOIN places b ON b.iata = r.destination
    WHERE r.stops = '0'`);
  const [counts] = await db.rows(`
    SELECT (SELECT count(*) FROM raw_routes)::INTEGER AS routes,
           (SELECT count(*) FROM raw_routes WHERE stops <> '0')::INTEGER AS with_stops,
           count(*) FILTER (WHERE a_id IS NULL OR b_id IS NULL)::INTEGER AS unmatched,
           count(*) FILTER (WHERE a_id = b_id)::INTEGER AS loops
    FROM flown`);

  // One row per pair of airports, both directions together: nearly every
  // route is flown both ways, so a direction would only draw each arc twice.
  await db.run(`
    CREATE TABLE pairs AS
    SELECT least(a_id, b_id) AS p, greatest(a_id, b_id) AS q,
           count(DISTINCT airline) FILTER (WHERE NOT codeshare)::INTEGER AS operating,
           count(DISTINCT airline)::INTEGER AS selling
    FROM flown
    WHERE a_id IS NOT NULL AND b_id IS NOT NULL AND a_id <> b_id
    GROUP BY ALL`);
  await db.run(`
    CREATE TABLE degree AS
    SELECT id, count(*)::INTEGER AS destinations FROM (SELECT p AS id FROM pairs UNION ALL SELECT q FROM pairs) GROUP BY id`);

  const label = (alias) => `${alias}.iata || ' · ' || ${alias}.city || ', ' || ${alias}.country`;
  // Each pair is oriented from its busier airport (more destinations; the
  // lower id on a tie) toward the other, so every hub gathers the arcs'
  // starting colour.
  await db.run(`
    CREATE TABLE air_routes AS
    WITH oriented AS (
      SELECT CASE WHEN dp.destinations > dq.destinations OR (dp.destinations = dq.destinations AND pairs.p < pairs.q) THEN pairs.p ELSE pairs.q END AS busier,
             CASE WHEN dp.destinations > dq.destinations OR (dp.destinations = dq.destinations AND pairs.p < pairs.q) THEN pairs.q ELSE pairs.p END AS other,
             greatest(pairs.operating, 1) AS airlines
      FROM pairs JOIN degree dp ON dp.id = pairs.p JOIN degree dq ON dq.id = pairs.q
    )
    SELECT ${label("a")} AS busier_airport,
           ${label("b")} AS other_airport,
           o.airlines,
           CASE WHEN o.airlines = 1 THEN 'One' WHEN o.airlines = 2 THEN 'Two'
                WHEN o.airlines <= 4 THEN 'Three or four' ELSE 'Five or more' END AS airline_band,
           CAST(round(ST_Distance_Sphere(ST_Point(a.lat, a.lon), ST_Point(b.lat, b.lon)) / 1000) AS INTEGER) AS distance_km,
           CASE WHEN ST_Distance_Sphere(ST_Point(a.lat, a.lon), ST_Point(b.lat, b.lon)) < 1500000 THEN 'Short haul'
                WHEN ST_Distance_Sphere(ST_Point(a.lat, a.lon), ST_Point(b.lat, b.lon)) < 4000000 THEN 'Medium haul'
                ELSE 'Long haul' END AS haul,
           CASE WHEN a.country = b.country THEN 'Domestic' ELSE 'International' END AS scope,
           a.lon AS busier_lon, a.lat AS busier_lat, b.lon AS other_lon, b.lat AS other_lat
    FROM oriented o JOIN places a ON a.id = o.busier JOIN places b ON b.id = o.other
    ORDER BY o.airlines, busier_airport, other_airport`);

  await db.run(`
    CREATE TABLE airports AS
    SELECT p.iata, p.name, p.city, p.country, d.destinations, ST_Point(p.lon, p.lat) AS geom
    FROM degree d JOIN places p ON p.id = d.id
    ORDER BY d.destinations, p.iata`);

  const [shape] = await db.rows(`
    SELECT (SELECT count(*) FROM air_routes)::INTEGER AS pairs,
           (SELECT count(*) FROM airports)::INTEGER AS airports,
           (SELECT count(*) FROM pairs WHERE operating = 0)::INTEGER AS codeshare_only,
           (SELECT count(*) FROM air_routes WHERE busier_airport IS NULL OR other_airport IS NULL)::INTEGER AS unnamed,
           (SELECT max(airlines) FROM air_routes)::INTEGER AS most_airlines,
           (SELECT max(distance_km) FROM air_routes)::INTEGER AS longest_km`);
  if (shape.unnamed) throw new Error(`${shape.unnamed} pairs name an airport without a code, city or country.`);

  const outputs = {};
  for (const [name, rows] of [["air_routes", shape.pairs], ["airports", shape.airports]]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    outputs[name] = { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
  }

  const record = {
    template: "air-routes",
    builtAt: new Date().toISOString(),
    slice: {
      commit: COMMIT,
      routesRead: counts.routes,
      routesWithStops: counts.with_stops,
      routesUnmatched: counts.unmatched,
      routesToItself: counts.loops,
      pairs: shape.pairs,
      pairsSoldOnlyAsCodeshare: shape.codeshare_only,
      airports: shape.airports,
      mostAirlinesOnAPair: shape.most_airlines,
      longestKm: shape.longest_km,
    },
    sources: {
      routes: (({ path: p, ...f }) => f)(routesFile),
      airports: (({ path: p, ...f }) => f)(airportsFile),
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`air routes: ${shape.pairs} airport pairs, ${shape.airports} airports; ${counts.unmatched} routes unmatched\n`);
} finally {
  db.close();
}
