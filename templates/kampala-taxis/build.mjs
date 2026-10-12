// Build "Kampala's minibus taxis": fetch the GIS layers of the 2019-2020
// study of Greater Kampala's paratransit from DigitalTransport4Africa's
// Kampala repository, at a pinned commit, and prepare the two datasets the
// map draws: every surveyed one-way taxi and bus trip, and the stages
// (taxi parks and terminals) the trips start and end at.
//
//   node templates/kampala-taxis/build.mjs [work folder]
//
// Writes <work>/kampala-taxis/data/{taxi_trips,stages}.parquet and
// <work>/kampala-taxis/build-record.json (every address, when it was read,
// its bytes and SHA-256, and the rows that came out).

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "kampala-taxis");

// The repository's last commit, "GTFS renamed" (23 November 2020). Every
// file is read at this commit, so the bytes cannot change under the
// template; the build record keeps their hashes all the same.
const COMMIT = "42e89cddcbd41d48fa59604e11fc22b66215a627";
const RAW = `https://gitlab.com/digitaltransport/data/africa/kampala/-/raw/${COMMIT}`;
const FILES = {
  licence: { at: "LICENSE_CC-BY-3.0", file: "LICENSE_CC-BY-3.0" },
  readme: { at: "README.md", file: "README.md" },
  codebook: { at: "AfD_GKMA-Transit_Data_Codebook.pdf", file: "codebook.pdf" },
  trips: { at: "GIS/Unique_Trips.zip", file: "Unique_Trips.zip", entry: "Unqiue_Trips" },
  stages: { at: "GIS/Stages.zip", file: "Stages.zip", entry: "Stages" },
};

// The repository's licence file is the legal code of Creative Commons
// Attribution 3.0 United States (CC-BY-3.0-US): its definitions are the
// US port's ("Collective Work", "Derivative Work"), and it names the US
// Copyright Act. The build stops unless the file is the one read when the
// template was made, word for word.
const LICENCE_SHA256 = "6a53178c005a7527bb28988490b2fb83a8dd45ccab944a6a0f7ab14ca0385d5d";
const LICENCE_MARKS = [
  '"Collective Work" means a work, such as a periodical issue, anthology or encyclopedia',
  "subject to the compulsory license created by 17 USC Section 115 of the US Copyright Act",
];

// The codebook's two-letter district codes. It reads MU as Mpigi, but the
// three stages coded MU are Mukono Taxi Park, Seeta and Misindye, all in
// Mukono District, and the routes coded MU run to Mukono; the map names it
// Mukono.
const DISTRICTS = { KA: "Kampala", WA: "Wakiso", MU: "Mukono" };
const MU_STAGES = ["Mukono Taxi Park", "Seeta Stage", "Misindye Ssonde"];

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const fetched = {};
for (const [key, f] of Object.entries(FILES)) fetched[key] = await download(downloads, key, `${RAW}/${f.at}`, f.file);

const licenceText = await readFile(fetched.licence.path, "utf8");
if (fetched.licence.sha256 !== LICENCE_SHA256 || LICENCE_MARKS.some((m) => !licenceText.includes(m))) {
  throw new Error(`The repository's licence file is not the CC BY 3.0 United States text read when the template was made (SHA-256 ${fetched.licence.sha256}).`);
}

// Each archive holds one shapefile. It is unpacked by name into its own
// folder with the system's unzip: nothing in it runs.
const unzip = (args) => new Promise((resolve, reject) => {
  const child = spawn("unzip", args, { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`unzip ${args.join(" ")} exited ${code}`))));
});
const shapefile = {};
for (const key of ["trips", "stages"]) {
  const { entry } = FILES[key];
  const archive = fetched[key].path;
  const entries = (await unzip(["-Z1", archive])).split("\n").filter(Boolean).sort();
  const expected = ["cpg", "dbf", "prj", "qpj", "shp", "shx"].map((ext) => `${entry}.${ext}`);
  if (JSON.stringify(entries) !== JSON.stringify(expected)) throw new Error(`${FILES[key].at} holds ${entries.join(", ")}, not the ${entry} shapefile alone.`);
  const folder = path.join(path.dirname(archive), "unpacked");
  await mkdir(folder);
  await unzip(["-q", archive, ...expected, "-d", folder]);
  shapefile[key] = path.join(folder, `${entry}.shp`);
  const prj = await readFile(path.join(folder, `${entry}.prj`), "utf8");
  if (!prj.includes('GEOGCS["GCS_WGS_1984"')) throw new Error(`${entry} is not in WGS 84 longitude and latitude: ${prj}`);
}

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'");
  await db.run("SET threads = 4");
  await db.run(`CREATE TABLE raw_trips AS SELECT * FROM ST_Read(${literal(shapefile.trips)})`);
  await db.run(`CREATE TABLE raw_stages AS SELECT * FROM ST_Read(${literal(shapefile.stages)})`);

  const district = (column) => `CASE ${column} ${Object.entries(DISTRICTS).map(([code, name]) => `WHEN '${code}' THEN '${name}'`).join(" ")} END`;

  // One row per one-way trip, as the study's "unique trips" layer has it:
  // the route, where the trip starts and ends, the vehicle, its length and
  // the fare for the whole trip in the first quarter of 2020, in Ugandan
  // shillings. A fare of 0 means none was recorded and is kept as no fare.
  // Positions are rounded to five decimal places, about a metre.
  await db.run(`
    CREATE TABLE taxi_trips AS
    SELECT trip_id,
           route_shor AS route,
           trip_short AS trip_name,
           O_TERMINAL AS from_stage,
           trip_heads AS to_stage,
           CASE agency_id WHEN 'taxi' THEN 'Minibus taxi' WHEN 'bus' THEN 'Bus' END AS vehicle,
           ${district("O_AREA")} AS starts_in,
           ${district("D_AREA")} AS ends_in,
           CAST(round(LEN_KM, 2) AS DECIMAL(5, 2)) AS length_km,
           CAST(nullif(FARE_Q120, 0) AS INTEGER) AS fare_ugx,
           ST_ReducePrecision(geom, 0.00001) AS geom
    FROM raw_trips
    ORDER BY trip_id`);

  // The stages, with the number of trips the study counted starting and
  // ending at each. The study draws each stage as the outline of its yard
  // or roadside, a few dozen metres across; the map marks it with a point
  // inside that outline, so it can be sized by its trips.
  await db.run(`
    CREATE TABLE stages AS
    SELECT Name AS name,
           ${district("gov_code")} AS district,
           CAST(tripspu_o AS SMALLINT) AS trips_from,
           CAST(tripspu_d AS SMALLINT) AS trips_to,
           ST_ReducePrecision(ST_PointOnSurface(geom), 0.00001) AS geom
    FROM raw_stages
    ORDER BY trips_from DESC, name`);

  const [tally] = await db.rows(`
    SELECT count(*)::INTEGER AS trips,
           count(DISTINCT trip_id)::INTEGER AS distinct_trips,
           count(DISTINCT (vehicle, route))::INTEGER AS routes,
           count(*) FILTER (WHERE vehicle = 'Bus')::INTEGER AS bus_trips,
           count(*) FILTER (WHERE vehicle IS NULL OR starts_in IS NULL OR ends_in IS NULL)::INTEGER AS unread,
           count(*) FILTER (WHERE fare_ugx IS NULL)::INTEGER AS without_a_fare,
           count(*) FILTER (WHERE from_stage NOT IN (SELECT name FROM stages))::INTEGER AS from_an_unknown_stage,
           count(*) FILTER (WHERE ST_GeometryType(geom) <> 'LINESTRING' OR ST_IsEmpty(geom))::INTEGER AS not_a_line,
           round(sum(length_km), 1)::DOUBLE AS km,
           min(ST_XMin(geom)) AS west, max(ST_XMax(geom)) AS east, min(ST_YMin(geom)) AS south, max(ST_YMax(geom)) AS north
    FROM taxi_trips`);
  const [places] = await db.rows(`
    SELECT count(*)::INTEGER AS stages,
           count(*) FILTER (WHERE district IS NULL)::INTEGER AS unread,
           list(name ORDER BY name) FILTER (WHERE district = 'Mukono') AS mukono,
           count(*) FILTER (WHERE ST_GeometryType(geom) <> 'POINT')::INTEGER AS not_a_point,
           (SELECT count(*) FROM raw_stages WHERE ST_GeometryType(geom) NOT IN ('POLYGON', 'MULTIPOLYGON'))::INTEGER AS not_an_outline
    FROM stages`);
  if (tally.trips !== tally.distinct_trips) throw new Error("A trip appears twice in the unique trips layer.");
  if (places.not_a_point || places.not_an_outline) throw new Error(`Stages that are not outlines: ${JSON.stringify(places)}.`);
  if (tally.unread || places.unread) throw new Error(`Codes the build does not know: ${JSON.stringify({ tally, places })}.`);
  if (tally.from_an_unknown_stage || tally.not_a_line) throw new Error(`Trips that do not fit: ${JSON.stringify(tally)}.`);
  if (JSON.stringify(places.mukono) !== JSON.stringify([...MU_STAGES].sort())) throw new Error(`The stages coded MU are ${places.mukono}.`);
  // Greater Kampala, Entebbe included, lies within these bounds.
  if (tally.west < 32.3 || tally.east > 32.9 || tally.south < 0 || tally.north > 0.6) throw new Error(`The trips leave Greater Kampala: ${JSON.stringify(tally)}.`);

  const outputs = {};
  for (const [name, rows] of [["taxi_trips", tally.trips], ["stages", places.stages]]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    outputs[name] = { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
  }

  const strip = ({ path: p, ...f }) => f;
  const built = {
    template: "kampala-taxis",
    builtAt: new Date().toISOString(),
    commit: COMMIT,
    slice: { ...tally, stages: places.stages },
    sources: Object.fromEntries(Object.entries(fetched).map(([key, f]) => [key, strip(f)])),
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(built, null, 2) + "\n");
  process.stdout.write(`trips: ${tally.trips} on ${tally.routes} routes (${tally.without_a_fare} without a fare); stages: ${places.stages}\n`);
} finally {
  db.close();
}
// The downloads are deleted once the GeoParquet is built; the build record
// keeps their addresses, sizes and hashes.
await rm(downloads, { recursive: true, force: true });
