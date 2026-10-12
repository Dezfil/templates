// Build "Hunting for a parking spot in Frankfurt": fetch the start2park
// trips and the Frankfurt UAS street parking supply from their publishers
// at pinned addresses and prepare the three datasets the map draws.
//
//   node templates/frankfurt-parking/build.mjs [work folder]
//
// Writes <work>/frankfurt-parking/data/{trip_phases,parking_spaces,
// parking_segments}.parquet and <work>/frankfurt-parking/build-record.json
// (every address, when it was read, its bytes and SHA-256, and the rows
// that came out).

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { engine } from "../../tools/source.mjs";
import {
  fetchSupply,
  fetchTrips,
  parkingSpaces,
  readSupply,
  readTrips,
  recorded,
  writeOutput,
} from "./sources.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "frankfurt-parking");
const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const trips = await fetchTrips(downloads);
const supply = await fetchSupply(downloads);
process.stdout.write(`trips: ${trips.waypoints.bytes} + ${trips.metadata.bytes} bytes; supply: ${supply.archive.bytes} bytes\n`);

const db = await engine();
try {
  const read = await readTrips(db, trips);
  const supplied = await readSupply(db, supply);

  // Each trip, whole, as one line per stretch of one activity. A stretch
  // runs on to the first waypoint of the next one, so a trip draws
  // unbroken from where it set off to where the driver walked to.
  await db.run(`
    CREATE TABLE run_points AS
    SELECT trip_id, run, t, lon, lat FROM waypoints
    UNION ALL
    SELECT trip_id, run - 1, min(t), arg_min(lon, t), arg_min(lat, t)
    FROM waypoints WHERE run > 1 GROUP BY trip_id, run`);
  await db.run(`
    CREATE TABLE trip_phases AS
    WITH lines AS (
      SELECT trip_id, run,
             min(t) AS started,
             max(t) AS ended,
             count(*) AS points,
             ST_MakeLine(list(ST_Point(lon, lat) ORDER BY t)) AS geom
      FROM run_points GROUP BY trip_id, run),
    labelled AS (
      SELECT trip_id, run, any_value(label) AS label FROM waypoints GROUP BY trip_id, run),
    first_run AS (
      SELECT trip_id, min(run) AS run FROM lines WHERE points >= 2 GROUP BY trip_id)
    SELECT
      l.trip_id AS trip,
      CASE b.label WHEN 'driving' THEN 'Driving' WHEN 'searching' THEN 'Searching' WHEN 'walking' THEN 'Walking' END AS activity,
      strftime(l.started, '%Y-%m-%d %H:%M') AS started,
      round(epoch(l.ended - l.started) / 60, 1) AS minutes,
      round(f.search_minutes, 1) AS search_minutes,
      CASE
        WHEN f.search_minutes = 0 THEN 'No search'
        WHEN f.search_minutes < 1 THEN 'Under a minute'
        WHEN f.search_minutes < 3 THEN '1 to 3 minutes'
        ELSE '3 minutes or more'
      END AS search_time,
      f.parked,
      f.cost,
      f.knew_the_area,
      -- One stretch of each trip carries 1 and the others 0, so a widget
      -- summing it counts trips rather than stretches.
      CASE WHEN l.run = r.run THEN 1 ELSE 0 END AS trips,
      l.geom
    FROM lines l
    JOIN labelled b USING (trip_id, run)
    JOIN trip_facts f USING (trip_id)
    JOIN first_run r USING (trip_id)
    WHERE l.points >= 2
    ORDER BY l.trip_id, l.run`);
  const [{ counted, phases }] = await db.rows(`
    SELECT sum(trips)::INTEGER AS counted, count(*)::INTEGER AS phases FROM trip_phases`);
  if (counted !== read.trips) throw new Error(`The phases count ${counted} trips; ${read.trips} end in Frankfurt.`);

  await parkingSpaces(db);

  // The street segments with how many spaces each holds per 100 m of kerb.
  // A segment the supply marks as having no parking holds none; one whose
  // data is missing or was not processed has no figure at all.
  await db.run(`
    CREATE TABLE parking_segments AS
    SELECT highway_name AS street,
           side,
           orientation,
           replace(position, '_', ' ') AS position,
           CAST(coalesce(capacity, 0) AS INTEGER) AS spaces,
           round(length, 1) AS length_m,
           CASE
             WHEN capacity_status = 'no_parking' THEN 0
             WHEN capacity_status = 'other' AND length > 0 THEN round(100 * coalesce(capacity, 0) / length, 1)
           END AS spaces_per_100m,
           geom
    FROM supply_segments
    WHERE geom IS NOT NULL
    ORDER BY id`);

  const outputs = {};
  for (const name of ["trip_phases", "parking_spaces", "parking_segments"]) {
    outputs[name] = await writeOutput(db, work, data, name);
  }
  const [{ first, last }] = await db.rows(`
    SELECT min(started) AS first, max(started) AS last FROM trip_phases`);
  const [{ measured }] = await db.rows(`
    SELECT count(*)::INTEGER AS measured FROM parking_segments WHERE spaces_per_100m IS NOT NULL`);

  const record = {
    template: "frankfurt-parking",
    builtAt: new Date().toISOString(),
    slice: {
      trips: read.trips,
      waypoints: read.waypoints,
      phases,
      tripsFrom: first,
      tripsTo: last,
      spaces: supplied.spaces,
      segments: supplied.segments,
      segmentsWithAFigure: measured,
    },
    sources: {
      parkAndVisit: {
        waypoints: recorded(trips.waypoints),
        metadata: recorded(trips.metadata),
        licence: recorded(trips.licence),
      },
      supply: {
        archive: recorded(supply.archive),
        members: Object.fromEntries(Object.entries(supply.members).map(([k, v]) => [k, recorded(v)])),
      },
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(
    `trip_phases: ${phases} stretches of ${read.trips} trips; parking_spaces: ${outputs.parking_spaces.rows}; ` +
      `parking_segments: ${outputs.parking_segments.rows} (${measured} with a figure)\n`,
  );
} finally {
  db.close();
}
