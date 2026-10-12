// Build "Where is parking hardest in Frankfurt?": fetch the start2park
// trips and the Frankfurt UAS street parking supply from their publishers
// at pinned addresses (the same addresses and reading as the
// frankfurt-parking map, in ../frankfurt-parking/sources.mjs) and prepare
// the two datasets the workflow starts from.
//
//   node templates/frankfurt-parking-hardest/build.mjs [work folder]
//
// Writes <work>/frankfurt-parking-hardest/data/{search_points,
// parking_spaces}.parquet and <work>/frankfurt-parking-hardest/
// build-record.json.

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
} from "../frankfurt-parking/sources.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "frankfurt-parking-hardest");
const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const trips = await fetchTrips(downloads);
const supply = await fetchSupply(downloads);

const db = await engine();
try {
  const read = await readTrips(db, trips);
  const supplied = await readSupply(db, supply);

  // Every waypoint the app marked as searching for parking, on the trips
  // that end in Frankfurt, each worth the time until the next waypoint:
  // the minutes of searching spent there. A trip's last waypoint is worth
  // nothing.
  await db.run(`
    CREATE TABLE search_points AS
    SELECT trip_id AS trip,
           strftime(t, '%Y-%m-%d %H:%M:%S') AS time,
           round(coalesce(epoch(next_t - t), 0) / 60, 4) AS search_minutes,
           ST_Point(lon, lat) AS geom
    FROM waypoints
    WHERE label = 'searching'
    ORDER BY trip_id, t`);
  const [{ points, searching_trips, minutes }] = await db.rows(`
    SELECT count(*)::INTEGER AS points, count(DISTINCT trip)::INTEGER AS searching_trips,
           round(sum(search_minutes), 1) AS minutes
    FROM search_points`);

  await parkingSpaces(db);

  const outputs = {};
  for (const name of ["search_points", "parking_spaces"]) outputs[name] = await writeOutput(db, work, data, name);

  const record = {
    template: "frankfurt-parking-hardest",
    builtAt: new Date().toISOString(),
    slice: {
      trips: read.trips,
      searchPoints: points,
      tripsWithSearching: searching_trips,
      searchMinutes: minutes,
      spaces: supplied.spaces,
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
  process.stdout.write(`search_points: ${points} on ${searching_trips} trips, ${minutes} minutes; parking_spaces: ${outputs.parking_spaces.rows}\n`);
} finally {
  db.close();
}
