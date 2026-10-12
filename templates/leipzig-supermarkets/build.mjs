// Build "Supermarket access in Leipzig": fetch the 2022 census's
// population grid from the statistical offices, Leipzig's districts
// (Ortsteile) from the city, and the supermarkets in and around Leipzig
// from OpenStreetMap, each at a pinned address, and prepare the three
// datasets the workflow reads: every populated 100 m cell in the city,
// the supermarkets, and the districts.
//
//   node templates/leipzig-supermarkets/build.mjs [work folder]
//
// Writes <work>/leipzig-supermarkets/data/{population_cells,supermarkets,districts}.parquet
// and <work>/leipzig-supermarkets/build-record.json.

import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { download, engine, literal, sha256, USER_AGENT } from "../../tools/source.mjs";
import { downloadStream } from "../../tools/stream.mjs";
import { readZip } from "../../tools/zip.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "leipzig-supermarkets");

// The census's population per 100 m cell (Zensus 2022, the release of
// 2024), all of Germany in one archive with its description.
const ZENSUS = "https://www.destatis.de/static/DE/zensus/gitterdaten/Zensus2022_Bevoelkerungszahl.zip";
const ZENSUS_GRID = "Zensus2022_Bevoelkerungszahl_100m-Gitter.csv";
const ZENSUS_DESCRIPTION = "Datensatzbeschreibung_Bevoelkerungszahl_Gitterzellen.xlsx";
const ZENSUS_LICENCE = "lizenziert unter der Datenlizenz Deutschland – Namensnennung – Version 2.0";
// Leipzig's 63 districts as the city's statistics office publishes them
// (EPSG:25833), with its catalogue record on the city's open data portal.
const DISTRICTS_RECORD = "https://opendata.leipzig.de/api/3/action/package_show?id=geodaten-ortsteile-leipzig";
const DISTRICTS = "https://static.leipzig.de/fileadmin/mediendatenbank/leipzig-de/Stadt/02.1_Dez1_Allgemeine_Verwaltung/12_Statistik_und_Wahlen/Geodaten/Ortsteile_Leipzig_UTM33N.json";
// Every supermarket OpenStreetMap maps in a box around the city reaching
// a few kilometres past its edge, so a cell near the boundary can find
// its nearest shop across it.
const OVERPASS = "https://overpass-api.de/api/interpreter";
const BOX = { south: 51.2, west: 12.17, north: 51.48, east: 12.6 };
const OVERPASS_QUERY = `[out:json][timeout:120];nwr["shop"="supermarket"](${BOX.south},${BOX.west},${BOX.north},${BOX.east});out center tags;`;

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

// The census archive, its grid streamed out of it into a folder of its
// own, and its description's licence read from the spreadsheet's text.
const zensus = await downloadStream(downloads, "zensus", ZENSUS, "Zensus2022_Bevoelkerungszahl.zip");
const unpacked = await mkdtemp(path.join(downloads, "zensus-unpacked-"));
const gridFile = path.join(unpacked, ZENSUS_GRID);
await new Promise((resolve, reject) => {
  const unzip = spawn("unzip", ["-p", zensus.path, ZENSUS_GRID]);
  unzip.stdout.pipe(createWriteStream(gridFile));
  unzip.on("error", reject);
  unzip.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`unzip ended with ${code}`))));
});
{
  const { stdout } = await run("unzip", ["-p", zensus.path, ZENSUS_DESCRIPTION], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  const shared = readZip(stdout).find((m) => m.name === "xl/sharedStrings.xml");
  if (!shared?.data.toString("utf8").includes(ZENSUS_LICENCE)) throw new Error("The census description no longer names dl-de/by-2.0.");
}
const districtsRecord = await download(downloads, "districts-record", DISTRICTS_RECORD, "record.json");
{
  const { result } = JSON.parse(await readFile(districtsRecord.path, "utf8"));
  const licences = new Set(result.resources.map((r) => r.license));
  if (licences.size !== 1 || !licences.has("http://dcat-ap.de/def/licenses/dl-by-de/2.0")) {
    throw new Error(`The districts' record states ${[...licences].join(", ")}, not dl-by-de/2.0.`);
  }
  districtsRecord.modified = result.metadata_modified;
  districtsRecord.organisation = result.organization?.title;
}
const districtsFile = await download(downloads, "districts", DISTRICTS, "Ortsteile_Leipzig_UTM33N.json");

// The Overpass API answers a busy moment with an error page: asked again,
// up to five times, a little later each time.
const overpass = await (async () => {
  for (let attempt = 1; ; attempt++) {
    const dir = await mkdtemp(path.join(downloads, "overpass-"));
    const fetchedAt = new Date().toISOString();
    const response = await fetch(OVERPASS, {
      method: "POST",
      headers: { "user-agent": USER_AGENT, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: OVERPASS_QUERY }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.ok && bytes[0] === 0x7b) {
      const target = path.join(dir, "supermarkets.json");
      await writeFile(target, bytes);
      const { osm3s } = JSON.parse(bytes.toString("utf8"));
      return { url: OVERPASS, query: OVERPASS_QUERY, fetchedAt, bytes: bytes.length, sha256: sha256(bytes), osmBase: osm3s.timestamp_osm_base, path: target };
    }
    if (attempt === 5) throw new Error(`The Overpass API answered ${response.status} five times.`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 20_000));
  }
})();
process.stdout.write(`zensus: ${zensus.bytes} bytes; supermarkets as of ${overpass.osmBase}\n`);

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'; SET threads = 4;");

  await db.run(`
    CREATE TABLE districts AS
    SELECT OT AS district_number, Name AS district,
           ST_Transform(geom, 'EPSG:25833', 'EPSG:4326', always_xy := true) AS geom,
           ST_Transform(geom, 'EPSG:25833', 'EPSG:3035', always_xy := true) AS grid_geom
    FROM ST_Read(${literal(districtsFile.path)})
    ORDER BY OT`);
  await db.run("CREATE TABLE city AS SELECT ST_Union_Agg(grid_geom) AS geom FROM districts");
  const [box] = await db.rows("SELECT ST_XMin(geom) AS x0, ST_XMax(geom) AS x1, ST_YMin(geom) AS y0, ST_YMax(geom) AS y1 FROM city");

  // The census grid streamed from its CSV: only the cells in the city's
  // box are read into memory, then those whose middle lies in the city
  // are kept, each as its 100 m square in longitude and latitude.
  await db.run(`
    CREATE TABLE grid AS
    SELECT GITTER_ID_100m AS cell, x_mp_100m AS x, y_mp_100m AS y, Einwohner AS people
    FROM read_csv(${literal(gridFile)}, delim = ';', header = true, columns = {
      'GITTER_ID_100m': 'VARCHAR', 'x_mp_100m': 'INTEGER', 'y_mp_100m': 'INTEGER', 'Einwohner': 'VARCHAR'})
    WHERE x_mp_100m BETWEEN ${Math.floor(box.x0) - 100} AND ${Math.ceil(box.x1) + 100}
      AND y_mp_100m BETWEEN ${Math.floor(box.y0) - 100} AND ${Math.ceil(box.y1) + 100}`);
  const [odd] = await db.rows("SELECT count(*) FILTER (WHERE TRY_CAST(people AS INTEGER) IS NULL)::INTEGER AS n, string_agg(DISTINCT people, ', ') FILTER (WHERE TRY_CAST(people AS INTEGER) IS NULL) AS values FROM grid");
  if (odd.n) throw new Error(`${odd.n} cells carry a population that is not a number: ${odd.values}.`);
  await db.run(`
    CREATE TABLE population_cells AS
    SELECT g.cell,
           g.people::INTEGER AS population,
           ST_Transform(ST_MakeEnvelope(g.x - 50, g.y - 50, g.x + 50, g.y + 50), 'EPSG:3035', 'EPSG:4326', always_xy := true) AS geom
    FROM grid g, city c
    WHERE ST_Contains(c.geom, ST_Point(g.x, g.y))
    ORDER BY g.cell`);
  await db.run("ALTER TABLE districts DROP COLUMN grid_geom");

  // The supermarkets: a point each (a shop mapped as a building is
  // placed at its centre), with its name and brand. A shop mapped twice,
  // as a point and as its building, within 50 m and under one name, is
  // kept once (DuckDB's distance on the sphere reads latitude first).
  const elements = JSON.parse(await readFile(overpass.path, "utf8")).elements
    .map((e) => ({ osm: `${e.type}/${e.id}`, name: e.tags?.name ?? null, brand: e.tags?.brand ?? e.tags?.name ?? null, lon: e.lon ?? e.center?.lon, lat: e.lat ?? e.center?.lat }))
    .filter((e) => Number.isFinite(e.lon) && Number.isFinite(e.lat));
  const text = (v) => (v === null ? "NULL" : literal(v));
  await db.run(`
    CREATE TABLE raw_shops AS
    SELECT osm, name, brand, ST_Point(lon, lat) AS geom
    FROM (VALUES ${elements.map((e) => `(${literal(e.osm)}, ${text(e.name)}, ${text(e.brand)}, ${e.lon}, ${e.lat})`).join(", ")}) AS v(osm, name, brand, lon, lat)`);
  await db.run(`
    CREATE TABLE supermarkets AS
    SELECT osm, name, brand, geom FROM raw_shops a
    WHERE NOT EXISTS (
      SELECT 1 FROM raw_shops b
      WHERE b.osm < a.osm AND lower(coalesce(b.brand, '')) = lower(coalesce(a.brand, ''))
        AND ST_Distance_Sphere(ST_FlipCoordinates(a.geom), ST_FlipCoordinates(b.geom)) < 50)
    ORDER BY osm`);

  const [tally] = await db.rows(`
    SELECT (SELECT count(*) FROM grid)::INTEGER AS cells_in_box,
           (SELECT count(*) FROM population_cells)::INTEGER AS cells,
           (SELECT sum(population) FROM population_cells)::INTEGER AS people,
           (SELECT count(*) FROM raw_shops)::INTEGER AS shops_mapped,
           (SELECT count(*) FROM supermarkets)::INTEGER AS supermarkets,
           (SELECT count(*) FROM supermarkets s, districts d WHERE ST_Contains(d.geom, s.geom))::INTEGER AS supermarkets_in_city,
           (SELECT count(*) FROM districts)::INTEGER AS districts`);
  if (tally.districts !== 63) throw new Error(`${tally.districts} districts; Leipzig has 63.`);
  if (tally.people < 550_000 || tally.people > 650_000) throw new Error(`${tally.people} people in the cells: not Leipzig's census count.`);

  const outputs = {};
  for (const name of ["population_cells", "supermarkets", "districts"]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    const [{ n }] = await db.rows(`SELECT count(*)::INTEGER AS n FROM ${name}`);
    outputs[name] = { file: path.relative(work, file), rows: n, sha256: sha256(await readFile(file)) };
  }

  const strip = ({ path: p, ...f }) => f;
  const record = {
    template: "leipzig-supermarkets",
    builtAt: new Date().toISOString(),
    slice: tally,
    sources: { zensus: strip(zensus), districtsRecord: strip(districtsRecord), districts: strip(districtsFile), overpass: strip(overpass) },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(tally)}\n`);
} finally {
  db.close();
}
