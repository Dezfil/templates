// Build "Ships through the Strait of Hormuz in 2026": fetch the sources from
// their publishers at pinned addresses and prepare the five datasets the
// map draws.
//
//   node templates/strait-of-hormuz/build.mjs [work folder]
//
// Writes <work>/strait-of-hormuz/data/{strait_transits,ports,port_calls,
// shipping_lanes,separation_schemes}.parquet and the build record (every
// address, when it was read, its bytes and SHA-256, the rows that came out
// and the figures the map's text quotes).

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { USER_AGENT, download, engine, literal, sha256 } from "../../tools/source.mjs";
import { fetchEntry, readWindow } from "./density.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "strait-of-hormuz");

// The slice. PortWatch counts from the first day of 2025 to the last day
// each series held when the build was written (it refreshes weekly, on
// Tuesdays): the strait to 4 October 2026, the ports to 2 October.
const FIRST_DAY = "2025-01-01";
const TRANSITS_LAST_DAY = "2026-10-04";
const PORTS_LAST_DAY = "2026-10-02";
// The eight countries on the Gulf and its approaches whose ports PortWatch
// follows: the United Arab Emirates, Saudi Arabia, Qatar, Bahrain, Kuwait,
// Iraq, Iran and Oman.
const COUNTRIES = ["ARE", "SAU", "QAT", "BHR", "KWT", "IRQ", "IRN", "OMN"];
const HORMUZ = "chokepoint6";

// IMF PortWatch's ArcGIS services, as its FAQ documents them.
const PORTWATCH = "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services";
const query = (service, where, fields = "*", order = "") =>
  `${PORTWATCH}/${service}/FeatureServer/0/query?where=${encodeURIComponent(where)}` +
  `&outFields=${encodeURIComponent(fields)}${order ? `&orderByFields=${encodeURIComponent(order)}` : ""}` +
  "&returnGeometry=false&maxRecordCountFactor=5&f=json";

// The World Bank's Global Shipping Traffic Density, commercial ships, the
// catalogue's own download (dataset 0037580, resource DR0045405). Only the
// raster's entry of the ZIP is read, by a byte range.
const DENSITY_ZIP = "https://datacatalogfiles.worldbank.org/ddh-published/0037580/5/DR0045405/shipdensity_commercial_.zip";
const DENSITY_ENTRY = "ShipDensity_Commercial1.tif";
// The map's region, from the Red Sea to the Arabian Sea, with a margin.
const WINDOW = [33, 11, 65, 33];
const LANE_RESOLUTION = 5;

// OpenStreetMap's traffic separation schemes in the Gulf, the strait and
// the Gulf of Oman, as they stood at the start of 12 October 2026.
const OSM_DATE = "2026-10-12T00:00:00Z";
const OVERPASS_QUERY = `[out:json][timeout:120][date:"${OSM_DATE}"];way["seamark:type"~"^separation_(lane|boundary|line|zone)$"](22,47,30.5,60);out geom tags;`;
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://lambert.openstreetmap.de/api/interpreter"];

// Natural Earth's marine areas, 1:10m, version 5.1.0: which sea each port
// lies on.
const NATURAL_EARTH = "https://naciscdn.org/naturalearth/10m/physical/ne_10m_geography_marine_polys.zip";

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const recorded = ({ path: _p, ...rest }) => rest;
const features = async (fetched) => {
  const body = JSON.parse(await readFile(fetched.path, "utf8"));
  if (body.error) throw new Error(`${fetched.url} answered ${JSON.stringify(body.error)}`);
  if (body.exceededTransferLimit) throw new Error(`${fetched.url} answered only part of its rows.`);
  return body.features.map((f) => f.attributes);
};

// PortWatch: the strait's location and its daily transits; the ports of the
// eight countries and their daily calls, one request per port as the FAQ
// advises.
const chokepoint = await download(downloads, "portwatch-chokepoints", query("PortWatch_chokepoints_database", `portid = '${HORMUZ}'`), "chokepoint.json");
const transits = await download(
  downloads,
  "portwatch-daily-chokepoints",
  query("Daily_Chokepoints_Data", `portid = '${HORMUZ}' AND date >= DATE '${FIRST_DAY}' AND date <= DATE '${TRANSITS_LAST_DAY}'`, "*", "date"),
  "transits.json",
);
const portList = await download(
  downloads,
  "portwatch-ports",
  query("PortWatch_ports_database", `ISO3 IN (${COUNTRIES.map((c) => `'${c}'`).join(",")})`, "portid,portname,country,ISO3,lat,lon", "portid"),
  "ports.json",
);
const portRows = await features(portList);
const callFiles = [];
for (const port of portRows) {
  const fetched = await download(
    downloads,
    `portwatch-daily-${port.portid}`,
    query("Daily_Ports_Data", `portid = '${port.portid}' AND date >= DATE '${FIRST_DAY}' AND date <= DATE '${PORTS_LAST_DAY}'`, "*", "date"),
    "calls.json",
  );
  callFiles.push({ portid: port.portid, ...fetched });
}
process.stdout.write(`portwatch: ${portRows.length} ports, ${callFiles.length} daily series\n`);

// The density raster's window.
const densityEntry = await fetchEntry({ url: DENSITY_ZIP, entryName: DENSITY_ENTRY, downloads });
const density = await readWindow(densityEntry, { window: WINDOW, block: 2 });
process.stdout.write(`density: ${density.record.window.nonzeroBlocks} blocks with positions\n`);
await rm(path.dirname(densityEntry.path), { recursive: true, force: true });

// OpenStreetMap through Overpass: the main instance first, its sibling if
// it is too busy to answer.
let overpass;
for (const endpoint of OVERPASS) {
  try {
    overpass = await download(downloads, "osm-separation-schemes", `${endpoint}?data=${encodeURIComponent(OVERPASS_QUERY)}`, "separation.json");
    JSON.parse(await readFile(overpass.path, "utf8"));
    break;
  } catch (error) {
    process.stdout.write(`overpass ${endpoint}: ${error.message}\n`);
    overpass = null;
  }
}
if (!overpass) throw new Error("No Overpass instance answered.");
const osm = JSON.parse(await readFile(overpass.path, "utf8"));

const seas = await download(downloads, "natural-earth-marine", NATURAL_EARTH, "ne_10m_geography_marine_polys.zip");

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'");
  await db.run("SET threads = 4");
  await db.run("INSTALL h3 FROM community");
  await db.run("LOAD h3");

  // The strait: one row a day, the ship types PortWatch counts and their
  // total, at PortWatch's own point for the strait.
  const [strait] = await features(chokepoint);
  const transitRows = await features(transits);
  await db.run(`CREATE TABLE raw_transits AS SELECT * FROM read_json(${literal(transits.path)}, maximum_object_size = 268435456)`);
  await db.run(`
    CREATE TABLE strait_transits AS
    SELECT CAST(f.attributes."date" AS DATE) AS day,
           CAST(f.attributes.n_total AS INTEGER) AS ships,
           CAST(f.attributes.n_tanker AS INTEGER) AS tanker,
           CAST(f.attributes.n_container AS INTEGER) AS container,
           CAST(f.attributes.n_dry_bulk AS INTEGER) AS dry_bulk,
           CAST(f.attributes.n_general_cargo AS INTEGER) AS general_cargo,
           CAST(f.attributes.n_roro AS INTEGER) AS roro,
           ST_Point(${strait.lon}, ${strait.lat}) AS geom
    FROM (SELECT unnest(features) AS f FROM raw_transits)
    ORDER BY day`);

  // The ports, each on the sea Natural Earth's nearest marine area names.
  await db.run(`
    CREATE TABLE seas AS
    SELECT name AS sea, geom
    FROM ST_Read(${literal(`/vsizip/${seas.path}/ne_10m_geography_marine_polys.shp`)})
    WHERE ST_Intersects(geom, ST_MakeEnvelope(30, 5, 70, 48))`);
  await db.run(`CREATE TABLE raw_ports AS SELECT * FROM read_json(${literal(portList.path)}, maximum_object_size = 268435456)`);
  await db.run(`
    CREATE TABLE ports AS
    WITH p AS (
      SELECT f.attributes.portid AS portid, f.attributes.portname AS port, f.attributes.country AS country,
             ST_Point(f.attributes.lon, f.attributes.lat) AS geom
      FROM (SELECT unnest(features) AS f FROM raw_ports)),
    nearest AS (
      SELECT p.portid, s.sea, row_number() OVER (PARTITION BY p.portid ORDER BY ST_Distance(p.geom, s.geom)) AS k
      FROM p, seas AS s)
    SELECT p.portid, p.port, p.country,
           CASE n.sea
             WHEN 'Persian Gulf' THEN 'The Gulf, inside the strait'
             WHEN 'Gulf of Masira' THEN 'Arabian Sea'
             ELSE n.sea
           END AS sea,
           p.geom
    FROM p JOIN nearest AS n ON n.portid = p.portid AND n.k = 1
    ORDER BY p.portid`);

  // The ports' daily calls, every port's series in one table.
  await db.run(`CREATE TABLE raw_calls (f JSON)`);
  for (const file of callFiles) {
    await db.run(`INSERT INTO raw_calls SELECT unnest(features) FROM read_json(${literal(file.path)}, maximum_object_size = 268435456)`);
  }
  await db.run(`
    CREATE TABLE port_calls AS
    SELECT CAST(f->>'$.attributes.date' AS DATE) AS day,
           f->>'$.attributes.portid' AS portid,
           CAST(f->>'$.attributes.portcalls' AS INTEGER) AS calls,
           CAST(f->>'$.attributes.portcalls_tanker' AS INTEGER) AS tanker,
           CAST(f->>'$.attributes.portcalls_container' AS INTEGER) AS container,
           CAST(f->>'$.attributes.portcalls_dry_bulk' AS INTEGER) AS dry_bulk,
           CAST(f->>'$.attributes.portcalls_general_cargo' AS INTEGER) AS general_cargo,
           CAST(f->>'$.attributes.portcalls_roro' AS INTEGER) AS roro
    FROM raw_calls
    ORDER BY portid, day`);

  // The usual lanes: the window's AIS positions summed into H3 cells. The
  // blocks pass to the engine through a CSV beside the downloads.
  const blocksFile = path.join(await mkdtemp(path.join(downloads, "density-blocks-")), "blocks.csv");
  {
    const out = createWriteStream(blocksFile);
    const { sums, cols, rows, centre } = density.grid;
    out.write("lon,lat,positions\n");
    for (let r = 0; r < rows; r++) {
      let line = "";
      for (let c = 0; c < cols; c++) {
        const v = sums[r * cols + c];
        if (!v) continue;
        const [lon, lat] = centre(r, c);
        line += `${lon.toFixed(5)},${lat.toFixed(5)},${Math.round(v)}\n`;
      }
      if (line && !out.write(line)) await new Promise((resolve) => out.once("drain", resolve));
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  }
  await db.run(`CREATE TABLE blocks AS SELECT * FROM read_csv(${literal(blocksFile)}, columns = {'lon': 'DOUBLE', 'lat': 'DOUBLE', 'positions': 'BIGINT'}, header = true)`);
  await db.run(`
    CREATE TABLE shipping_lanes AS
    SELECT h3_h3_to_string(cell) AS h3,
           positions,
           ST_ReducePrecision(ST_GeomFromText(h3_cell_to_boundary_wkt(cell)), 0.0001) AS geom
    FROM (SELECT h3_latlng_to_cell(lat, lon, ${LANE_RESOLUTION}) AS cell, sum(positions)::BIGINT AS positions FROM blocks GROUP BY 1)
    ORDER BY h3`);

  // The traffic separation schemes, as lines.
  const ways = osm.elements.filter((e) => e.type === "way" && e.geometry?.length >= 2);
  await db.run(`
    CREATE TABLE separation_schemes AS
    SELECT * FROM (VALUES ${ways.map((w) => `(${w.id}, ${literal(w.tags["seamark:type"].replace("separation_", "").replace(/^./, (c) => c.toUpperCase()))}, ST_GeomFromText(${literal(`LINESTRING(${w.geometry.map((g) => `${g.lon} ${g.lat}`).join(", ")})`)}))`).join(",\n")})
      AS t(osm_way, part, geom)
    ORDER BY osm_way`);

  // Hold the slice to what the sources say.
  const [check] = await db.rows(`
    SELECT (SELECT count(*) FROM strait_transits)::INTEGER AS transit_days,
           (SELECT min(day) FROM strait_transits)::VARCHAR AS transits_from,
           (SELECT max(day) FROM strait_transits)::VARCHAR AS transits_to,
           (SELECT count(*) FROM strait_transits WHERE ships <> tanker + container + dry_bulk + general_cargo + roro)::INTEGER AS transit_type_mismatches,
           (SELECT count(*) FROM ports)::INTEGER AS ports,
           (SELECT count(*) FROM ports WHERE sea IS NULL)::INTEGER AS ports_without_sea,
           (SELECT count(*) FROM port_calls)::INTEGER AS port_call_rows,
           (SELECT count(DISTINCT portid) FROM port_calls)::INTEGER AS ports_with_calls,
           (SELECT min(day) FROM port_calls)::VARCHAR AS calls_from,
           (SELECT max(day) FROM port_calls)::VARCHAR AS calls_to,
           (SELECT count(*) FROM shipping_lanes)::INTEGER AS lane_cells,
           (SELECT count(*) FROM separation_schemes)::INTEGER AS separation_ways`);
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
  if (check.transit_days !== days(FIRST_DAY, TRANSITS_LAST_DAY) || check.transits_to !== TRANSITS_LAST_DAY) {
    throw new Error(`The strait's series holds ${check.transit_days} days to ${check.transits_to}; the slice is ${days(FIRST_DAY, TRANSITS_LAST_DAY)} days to ${TRANSITS_LAST_DAY}.`);
  }
  if (check.transit_type_mismatches) throw new Error(`${check.transit_type_mismatches} days whose ship types do not add up to the total.`);
  if (check.ports !== portRows.length || check.ports_without_sea) throw new Error(`Ports: ${JSON.stringify(check)}`);
  if (check.port_call_rows !== check.ports * days(FIRST_DAY, PORTS_LAST_DAY) || check.calls_to !== PORTS_LAST_DAY) {
    throw new Error(`The ports' series hold ${check.port_call_rows} rows to ${check.calls_to}; ${check.ports} ports over ${days(FIRST_DAY, PORTS_LAST_DAY)} days are expected.`);
  }
  if (transitRows.length !== check.transit_days) throw new Error("The strait's rows did not all land.");

  // The figures the map's text quotes, each from the data as built.
  const [figures] = await db.rows(`
    SELECT (SELECT round(avg(ships), 1) FROM strait_transits WHERE year(day) = 2025)::DOUBLE AS transits_a_day_2025,
           (SELECT max(ships) FROM strait_transits)::INTEGER AS busiest_day_ships,
           (SELECT max(day) FILTER (WHERE ships = (SELECT max(ships) FROM strait_transits)) FROM strait_transits)::VARCHAR AS busiest_day,
           (SELECT list({'day': day::VARCHAR, 'ships': ships} ORDER BY day) FROM strait_transits WHERE day BETWEEN DATE '2026-02-27' AND DATE '2026-03-05') AS around_28_february,
           (SELECT round(avg(ships), 1) FROM strait_transits WHERE day BETWEEN DATE '2025-03-01' AND DATE '2025-10-02')::DOUBLE AS strait_2025,
           (SELECT round(avg(ships), 1) FROM strait_transits WHERE day BETWEEN DATE '2026-03-01' AND DATE '2026-10-02')::DOUBLE AS strait_2026,
           (SELECT sum(ships) FROM strait_transits WHERE day BETWEEN DATE '2026-03-01' AND DATE '2026-10-04')::INTEGER AS transits_since_1_march,
           (SELECT count(*) FROM strait_transits WHERE day >= DATE '2026-03-01' AND ships = 0)::INTEGER AS days_without_a_transit`);

  const outputs = {};
  for (const name of ["strait_transits", "ports", "port_calls", "shipping_lanes", "separation_schemes"]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    const [{ rows: n }] = await db.rows(`SELECT count(*)::INTEGER AS rows FROM ${name}`);
    outputs[name] = { file: path.relative(work, file), rows: n, sha256: sha256(await readFile(file)) };
  }

  const record = {
    template: "strait-of-hormuz",
    builtAt: new Date().toISOString(),
    slice: { ...check, firstDay: FIRST_DAY, transitsLastDay: TRANSITS_LAST_DAY, portsLastDay: PORTS_LAST_DAY, countries: COUNTRIES, strait: { portid: HORMUZ, lon: strait.lon, lat: strait.lat } },
    figures,
    sources: {
      portwatch: {
        chokepoint: recorded(chokepoint),
        transits: recorded(transits),
        ports: recorded(portList),
        calls: callFiles.map((f) => ({ portid: f.portid, url: f.url, fetchedAt: f.fetchedAt, bytes: f.bytes, sha256: f.sha256 })),
      },
      density: { ...densityEntry.record, ...density.record, laneResolution: LANE_RESOLUTION },
      openStreetMap: { ...recorded(overpass), query: OVERPASS_QUERY, osmBase: osm.osm3s?.timestamp_osm_base ?? null, ways: ways.length },
      naturalEarth: recorded(seas),
    },
    userAgent: USER_AGENT,
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(check)}\n${JSON.stringify(figures)}\n`);
} finally {
  db.close();
}
