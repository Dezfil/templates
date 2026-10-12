// The two Frankfurt sources, shared by "Hunting for a parking spot in
// Frankfurt" (the map) and "Where is parking hardest in Frankfurt?" (the
// workflow example): the start2park trips and the Frankfurt UAS street
// parking supply, each fetched from its publisher at a pinned address and
// read into DuckDB the same way for both templates.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { USER_AGENT, download, literal, sha256 } from "../../tools/source.mjs";
import { readZip } from "../../tools/zip.mjs";

const run = promisify(execFile);

// Park-and-Visit, the start2park trips, at the commit that added the folder.
export const PARK_AND_VISIT_COMMIT = "de394ee98e37612da887b0e5cd9c87f8adf6a106";
const parkAndVisit = (file) =>
  `https://raw.githubusercontent.com/ReLUT/parking-search-prediction/${PARK_AND_VISIT_COMMIT}/${file}`;
export const WAYPOINTS_ADDRESS = parkAndVisit("Park-and-Visit/Dynamic_Park-and-visit_waypoints.csv");
export const METADATA_ADDRESS = parkAndVisit("Park-and-Visit/Dynamic_Park-and-visit_metadata.csv");
export const LICENSE_ADDRESS = parkAndVisit("LICENSE");

// Georeferenced street parking locations in Frankfurt am Main, Mobilithek
// offer 886571101635461120, the one file the offer publishes.
export const SUPPLY_OFFER = "886571101635461120";
export const SUPPLY_ADDRESS = `https://mobilithek.info/mdp-api/files/aux/${SUPPLY_OFFER}/FFM_parking_data.zip`;
const SUPPLY_MEMBERS = ["parking_spaces_frankfurt.gpkg", "parking_segments_frankfurt.gpkg"];

// The study drove in Frankfurt and in Rostock; a trip belongs to the city
// it ends in. Rostock lies near 54° N and Frankfurt near 50° N, so the
// 52nd parallel parts them with room to spare.
const FRANKFURT_BELOW_LATITUDE = 52;

/** Fetch the trips: the waypoints, the per-trip metadata and the licence. */
export async function fetchTrips(downloads) {
  return {
    waypoints: await download(downloads, "park-and-visit-waypoints", WAYPOINTS_ADDRESS, "waypoints.csv"),
    metadata: await download(downloads, "park-and-visit-metadata", METADATA_ADDRESS, "metadata.csv"),
    licence: await download(downloads, "park-and-visit-licence", LICENSE_ADDRESS, "LICENSE"),
  };
}

/**
 * Fetch one address with curl, into a new folder of its own, answering
 * what `download` answers. Node's TLS refused mobilithek.info's chain on
 * the machine this was first built on (SELF_SIGNED_CERT_IN_CHAIN, though
 * the chain ends in a root Node ships), while curl verifies it against the
 * system's store; the certificate is still checked, only by curl.
 */
async function downloadWithCurl(root, label, url, file) {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, `${label}-`));
  const target = path.join(dir, file);
  const fetchedAt = new Date().toISOString();
  await run("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--user-agent", USER_AGENT, "--output", target, url]);
  const bytes = await readFile(target);
  return { url, fetchedAt, bytes: bytes.length, sha256: sha256(bytes), path: target, fetchedWith: "curl" };
}

/**
 * Fetch the supply archive and take out the two GeoPackages the templates
 * read, each written under its own fixed name into a new folder (a name in
 * the archive never becomes a path).
 */
export async function fetchSupply(downloads) {
  const archive = await downloadWithCurl(downloads, "mobilithek-supply", SUPPLY_ADDRESS, "FFM_parking_data.zip");
  const members = readZip(await readFile(archive.path));
  const dir = await mkdtemp(path.join(downloads, "mobilithek-supply-members-"));
  const files = {};
  for (const name of SUPPLY_MEMBERS) {
    const member = members.find((m) => m.name === name);
    if (!member) throw new Error(`The supply archive holds no ${name}.`);
    files[name] = { path: path.join(dir, name), bytes: member.data.length, sha256: sha256(member.data) };
    await writeFile(files[name].path, member.data);
  }
  return { archive, members: files };
}

/**
 * Read the trips into the engine: `waypoints` (every waypoint of the
 * trips that end in Frankfurt, in time order, with its run of one
 * activity) and `trip_facts` (one row per such trip from the metadata).
 */
export async function readTrips(db, trips) {
  // Every column is read as text and typed here, so the shape never rests
  // on what the reader guesses from a sample.
  await db.run(`
    CREATE TABLE all_waypoints AS
    SELECT TripID AS trip_id,
           CAST(lon AS DOUBLE) AS lon,
           CAST(lat AS DOUBLE) AS lat,
           CAST(time AS TIMESTAMP) AS t,
           label
    FROM read_csv(${literal(trips.waypoints.path)}, header = true, all_varchar = true)`);
  await db.run(`
    CREATE TABLE frankfurt_trips AS
    SELECT trip_id FROM all_waypoints GROUP BY trip_id
    HAVING arg_max(lat, t) < ${FRANKFURT_BELOW_LATITUDE}`);
  // A run is a stretch of one activity: it starts wherever the label
  // differs from the waypoint before it.
  await db.run(`
    CREATE TABLE waypoints AS
    WITH ordered AS (
      SELECT w.*, lag(label) OVER (PARTITION BY trip_id ORDER BY t) AS previous,
             lead(t) OVER (PARTITION BY trip_id ORDER BY t) AS next_t
      FROM all_waypoints w JOIN frankfurt_trips USING (trip_id))
    SELECT trip_id, lon, lat, t, next_t, label,
           sum(CASE WHEN previous IS NULL OR previous <> label THEN 1 ELSE 0 END)
             OVER (PARTITION BY trip_id ORDER BY t ROWS UNBOUNDED PRECEDING) AS run
    FROM ordered`);
  await db.run(`
    CREATE TABLE trip_facts AS
    SELECT TripID AS trip_id,
           CASE Parking_Location_Type WHEN 'on-street' THEN 'On-street' WHEN 'off-street' THEN 'Off-street' END AS parked,
           Parking_Cost_Status AS cost,
           CASE Familiar_With_Destination WHEN '1' THEN 'Yes' WHEN '0' THEN 'No' END AS knew_the_area,
           CAST(Parking_Search_Duration_min AS DOUBLE) AS search_minutes
    FROM read_csv(${literal(trips.metadata.path)}, header = true, all_varchar = true)
    WHERE TripID IN (SELECT trip_id FROM frankfurt_trips)`);
  const [{ trips: n, points, with_facts, labels, costs, parked }] = await db.rows(`
    SELECT (SELECT count(*) FROM frankfurt_trips)::INTEGER AS trips,
           (SELECT count(*) FROM waypoints)::INTEGER AS points,
           (SELECT count(*) FROM trip_facts)::INTEGER AS with_facts,
           (SELECT string_agg(DISTINCT label, ',' ORDER BY label) FROM waypoints) AS labels,
           (SELECT string_agg(DISTINCT cost, ',' ORDER BY cost) FROM trip_facts) AS costs,
           (SELECT string_agg(DISTINCT parked, ',' ORDER BY parked) FROM trip_facts) AS parked`);
  if (n !== with_facts) throw new Error(`${n} Frankfurt trips, but ${with_facts} have metadata.`);
  if (labels !== "driving,searching,walking") throw new Error(`Unexpected activity labels: ${labels}.`);
  if (costs !== "Free,Illegal,Paid") throw new Error(`Unexpected parking costs: ${costs}.`);
  if (parked !== "Off-street,On-street") throw new Error(`Unexpected parking places: ${parked}.`);
  return { trips: n, waypoints: points };
}

/** Read the supply's parking spaces (points) and street segments (lines). */
export async function readSupply(db, supply) {
  await db.run(`
    CREATE TABLE supply_spaces AS
    SELECT * FROM ST_Read(${literal(supply.members["parking_spaces_frankfurt.gpkg"].path)})`);
  await db.run(`
    CREATE TABLE supply_segments AS
    SELECT * FROM ST_Read(${literal(supply.members["parking_segments_frankfurt.gpkg"].path)})`);
  const [{ spaces, segments }] = await db.rows(`
    SELECT (SELECT count(*) FROM supply_spaces)::INTEGER AS spaces,
           (SELECT count(*) FROM supply_segments)::INTEGER AS segments`);
  return { spaces, segments };
}

/** The parking spaces as the templates carry them: one point per space. */
export async function parkingSpaces(db) {
  await db.run(`
    CREATE TABLE parking_spaces AS
    SELECT highway_name AS street,
           side,
           orientation,
           replace(position, '_', ' ') AS position,
           geom
    FROM supply_spaces
    WHERE geom IS NOT NULL
    ORDER BY id`);
}

/** Write a table as GeoParquet and say what came out. */
export async function writeOutput(db, work, data, name) {
  await mkdir(data, { recursive: true });
  const file = path.join(data, `${name}.parquet`);
  await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  const [{ rows }] = await db.rows(`SELECT count(*)::INTEGER AS rows FROM ${name}`);
  return { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
}

/** A download's record without its local path. */
export const recorded = ({ path: p, ...rest }) => rest;
