// Build "Zurich's counters": fetch the City of Zurich's automatic bicycle
// and pedestrian counts for 2025 (quarter-hour values) and the counters'
// sites from its open data portal at pinned addresses, check both records'
// licences, and prepare the two datasets the map reads: every quarter
// hour's count at every counter, and the counters with their names.
//
//   node templates/zurich-counters/build.mjs [work folder]
//
// Writes <work>/zurich-counters/data/{counts,counters}.parquet and
// <work>/zurich-counters/build-record.json.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";
import { downloadStream } from "../../tools/stream.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "zurich-counters");

// The year: 2025, the last whole year the counts cover.
const YEAR = 2025;
const CKAN = "https://data.stadt-zuerich.ch/api/3/action/package_show?id=";
const COUNTS_RECORD = `${CKAN}ted_taz_verkehrszaehlungen_werte_fussgaenger_velo`;
const SITES_RECORD = `${CKAN}geo_standorte_der_automatischen_fuss__und_velozaehlungen`;
const COUNTS = `https://data.stadt-zuerich.ch/dataset/ted_taz_verkehrszaehlungen_werte_fussgaenger_velo/download/${YEAR}_verkehrszaehlungen_werte_fussgaenger_velo.csv`;
// The sites through the city's feature service, as GeoJSON in WGS84.
const SITES =
  "https://www.ogd.stadt-zuerich.ch/wfs/geoportal/Standorte_der_automatischen_Fuss__und_Velozaehlungen" +
  "?SERVICE=WFS&REQUEST=GetFeature&VERSION=1.1.0&TYPENAME=view_eco_standorte&outputFormat=application/vnd.geo%2Bjson";

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const records = {};
for (const [key, url] of Object.entries({ counts: COUNTS_RECORD, sites: SITES_RECORD })) {
  records[key] = await download(downloads, `record-${key}`, url, `${key}.json`);
  const { result } = JSON.parse(await readFile(records[key].path, "utf8"));
  if (result.license_id !== "cc-zero") throw new Error(`The ${key} record states the licence ${result.license_id}, not cc-zero.`);
  records[key].licence = { id: result.license_id, title: result.license_title, url: result.license_url };
  records[key].modified = result.metadata_modified;
  records[key].author = result.author;
}
const counts = await downloadStream(downloads, "counts", COUNTS, `${YEAR}.csv`);
const sites = await download(downloads, "sites", SITES, "sites.geojson");
process.stdout.write(`counts: ${counts.bytes} bytes; sites: ${sites.bytes} bytes\n`);

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'; SET threads = 4;");
  // The quarter hours as the city writes them: the counter, the start of
  // the quarter hour in Zurich's local time, the bicycles or pedestrians
  // counted each way, and the counter's place in the Swiss grid (LV95).
  await db.run(`
    CREATE TABLE raw AS
    SELECT * FROM read_csv(${literal(counts.path)}, header = true, columns = {
      'FK_STANDORT': 'INTEGER', 'DATUM': 'TIMESTAMP', 'VELO_IN': 'INTEGER', 'VELO_OUT': 'INTEGER',
      'FUSS_IN': 'INTEGER', 'FUSS_OUT': 'INTEGER', 'OST': 'DOUBLE', 'NORD': 'DOUBLE'})`);
  const [mixed] = await db.rows(`
    SELECT count(*)::INTEGER AS n FROM raw
    WHERE (VELO_IN IS NOT NULL OR VELO_OUT IS NOT NULL) AND (FUSS_IN IS NOT NULL OR FUSS_OUT IS NOT NULL)`);
  if (mixed.n) throw new Error(`${mixed.n} quarter hours count bicycles and pedestrians at once.`);

  // The counters: one per site in the counts, named from the city's site
  // register. The register keeps a site's earlier records beside its
  // current one at the same place, so each counter takes the nearest
  // record, the current one first.
  await db.run(`
    CREATE TABLE places AS
    SELECT FK_STANDORT AS counter,
           ST_Transform(ST_Point(any_value(OST), any_value(NORD)), 'EPSG:2056', 'EPSG:4326', always_xy := true) AS geom,
           bool_or(VELO_IN IS NOT NULL OR VELO_OUT IS NOT NULL) AS bikes
    FROM raw GROUP BY FK_STANDORT`);
  await db.run(`
    CREATE TABLE register AS
    SELECT bezeichnung, abkuerzung, status, richtung_in, richtung_out, geom FROM ST_Read(${literal(sites.path)})`);
  await db.run(`
    CREATE TABLE counters AS
    SELECT p.counter,
           r.bezeichnung AS name,
           CASE WHEN p.bikes THEN 'Bicycles' ELSE 'Pedestrians' END AS mode,
           nullif(r.richtung_in, '---') AS towards_in,
           nullif(r.richtung_out, '---') AS towards_out,
           r.distance_m,
           p.geom
    FROM places p
    CROSS JOIN LATERAL (
      SELECT bezeichnung, richtung_in, richtung_out, ST_Distance_Sphere(ST_FlipCoordinates(p.geom), ST_FlipCoordinates(geom)) AS distance_m
      FROM register
      ORDER BY round(ST_Distance_Sphere(ST_FlipCoordinates(p.geom), ST_FlipCoordinates(geom))), status = 'aktuell' DESC
      LIMIT 1
    ) r
    ORDER BY p.counter`);
  const far = await db.rows("SELECT counter, name, distance_m FROM counters WHERE distance_m > 5");
  if (far.length) throw new Error(`Counters with no site within 5 m: ${JSON.stringify(far)}.`);
  await db.run("ALTER TABLE counters DROP COLUMN distance_m");

  // Every quarter hour at every counter: when, what, each way and both.
  await db.run(`
    CREATE TABLE counts AS
    SELECT FK_STANDORT AS counter,
           DATUM AS quarter_hour,
           CASE WHEN VELO_IN IS NOT NULL OR VELO_OUT IS NOT NULL THEN 'Bicycles' ELSE 'Pedestrians' END AS mode,
           coalesce(VELO_IN, FUSS_IN) AS passages_in,
           coalesce(VELO_OUT, FUSS_OUT) AS passages_out,
           coalesce(VELO_IN, FUSS_IN, 0) + coalesce(VELO_OUT, FUSS_OUT, 0) AS passages
    FROM raw
    WHERE year(DATUM) = ${YEAR}
    ORDER BY quarter_hour, counter`);

  const [tally] = await db.rows(`
    SELECT count(*)::INTEGER AS quarter_hours, count(DISTINCT counter)::INTEGER AS counters,
           sum(passages)::BIGINT AS passages, min(quarter_hour)::VARCHAR AS first, max(quarter_hour)::VARCHAR AS last,
           sum(passages) FILTER (WHERE mode = 'Bicycles')::BIGINT AS bicycles,
           sum(passages) FILTER (WHERE mode = 'Pedestrians')::BIGINT AS pedestrians
    FROM counts`);
  const named = await db.rows("SELECT counter, name, mode FROM counters ORDER BY name");

  const outputs = {};
  for (const name of ["counts", "counters"]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    const [{ n }] = await db.rows(`SELECT count(*)::INTEGER AS n FROM ${name}`);
    outputs[name] = { file: path.relative(work, file), rows: n, sha256: sha256(await readFile(file)) };
  }

  const strip = ({ path: p, ...f }) => f;
  const record = {
    template: "zurich-counters",
    builtAt: new Date().toISOString(),
    slice: { year: YEAR, ...tally, counters: named },
    sources: {
      records: Object.fromEntries(Object.entries(records).map(([k, v]) => [k, strip(v)])),
      counts: strip(counts),
      sites: strip(sites),
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(tally)}\n${named.map((c) => `${c.counter} ${c.name} (${c.mode})`).join("\n")}\n`);
} finally {
  db.close();
}
