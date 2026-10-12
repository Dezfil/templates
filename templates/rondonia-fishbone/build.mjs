// Build "Rondônia's fishbone": fetch INPE's PRODES deforestation maps for
// the state of Rondônia from TerraBrasilis, its web feature service sliced
// to the state on the server, and prepare the two datasets the map draws:
// the forest cleared before 2008, and the forest cleared each year since.
//
//   node templates/rondonia-fishbone/build.mjs [work folder]
//
// Writes <work>/rondonia-fishbone/data/{cleared_before_2008,cleared_by_year}.parquet
// and <work>/rondonia-fishbone/build-record.json (every address, when it
// was read, its bytes and SHA-256, and the rows that came out).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "rondonia-fishbone");

// PRODES, the Brazilian Legal Amazon's yearly deforestation survey, on
// TerraBrasilis's GeoServer. The state is cut on the server (state 'RO'),
// so the Legal Amazon's whole archive is never downloaded; the features
// come in pages in a fixed order.
const WFS = "https://terrabrasilis.dpi.inpe.br/geoserver/prodes-legal-amz/ows";
const LAYERS = {
  yearly: { type: "prodes-legal-amz:yearly_deforestation", record: "a5220c18-f7fa-4e3e-b39b-feeb3ccc4830" },
  before2008: { type: "prodes-legal-amz:accumulated_deforestation_2007", record: "415220fc-3013-4258-bd21-83014865cee5" },
};
const STATE = "RO";
const PAGE = 2000;
// Each layer's catalogue record states its licence; the build refuses to
// go on unless it still reads CC BY-SA 4.0.
const RECORD = (id) => `https://terrabrasilis.dpi.inpe.br/geonetwork/srv/por/csw?service=CSW&version=2.0.2&request=GetRecordById&elementSetName=full&outputSchema=http://www.isotc211.org/2005/gmd&id=${id}`;
const LICENCE = "Creative Commons - Atribuição-CompartilhaIgual 4.0 Internacional";
// The polygons arrive at four decimal places (about 11 m); each is
// simplified by about 55 m for drawing, keeping its topology: a fifth of
// the smallest clearing PRODES maps (6.25 ha, 250 m a side), invisible
// at the zooms the fishbone is seen at, and it cuts what a browser has
// to draw by more than half.
const SIMPLIFY_DEGREES = 0.0005;

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const query = (type, extra) => {
  const params = new URLSearchParams({
    service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: type,
    CQL_FILTER: `state='${STATE}'`, ...extra,
  });
  return `${WFS}?${params}`;
};

const strip = ({ path: p, ...f }) => f;
const fetched = {};
for (const [key, layer] of Object.entries(LAYERS)) {
  const record = await download(downloads, `${key}-record`, RECORD(layer.record), "record.xml");
  const xml = await readFile(record.path, "utf8");
  if (!xml.includes(`<gco:CharacterString>${LICENCE}</gco:CharacterString>`)) {
    throw new Error(`The catalogue record ${layer.record} no longer states ${LICENCE}.`);
  }
  const updated = xml.match(/<gmd:dateStamp>\s*<gco:DateTime>([^<]+)</)?.[1] ?? null;
  const hits = await download(downloads, `${key}-hits`, query(layer.type, { resultType: "hits" }), "hits.xml");
  const matched = Number((await readFile(hits.path, "utf8")).match(/numberMatched="(\d+)"/)?.[1]);
  if (!Number.isInteger(matched) || matched < 1) throw new Error(`${layer.type} matched no features in ${STATE}.`);
  const pages = [];
  for (let start = 0; start < matched; start += PAGE) {
    const page = await download(downloads, `${key}-${start}`, query(layer.type, {
      outputFormat: "application/json", sortBy: "fid", count: String(PAGE), startIndex: String(start),
    }), "page.geojson");
    pages.push(page);
  }
  process.stdout.write(`${key}: ${matched} features in ${pages.length} pages, ${pages.reduce((n, p) => n + p.bytes, 0)} bytes\n`);
  fetched[key] = { record: strip(record), recordUpdated: updated, hits: strip(hits), matched, pages };
}

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'");
  await db.run("SET threads = 4");
  for (const key of Object.keys(LAYERS)) {
    const reads = fetched[key].pages.map((p) => `SELECT * FROM ST_Read(${literal(p.path)})`).join("\n    UNION ALL BY NAME ");
    await db.run(`CREATE TABLE raw_${key} AS ${reads}`);
  }
  // Every page was read whole: the rows equal the features the server
  // counted, and no feature came twice.
  for (const key of Object.keys(LAYERS)) {
    const [{ rows, ids }] = await db.rows(`SELECT count(*)::INTEGER AS rows, count(DISTINCT uuid)::INTEGER AS ids FROM raw_${key}`);
    if (rows !== fetched[key].matched || ids !== rows) throw new Error(`${key}: ${rows} rows, ${ids} distinct, of ${fetched[key].matched} matched.`);
  }

  // Each polygon is made valid, simplified for drawing and kept to its
  // polygonal part: repairing a self-touching outline or simplifying a
  // narrow one can leave stray points and lines, which are not area. A
  // small clearing that simplifying would erase keeps its outline as
  // published instead.
  const drawn = (key, where) => `
    CREATE TABLE drawn_${key} AS
    SELECT *, CASE WHEN ST_IsEmpty(simplified) THEN as_published ELSE simplified END AS shape,
              ST_IsEmpty(simplified) AND NOT ST_IsEmpty(as_published) AS kept_as_published
    FROM (
      SELECT *, ST_CollectionExtract(
                  ST_ReducePrecision(ST_SimplifyPreserveTopology(ST_MakeValid(geom), ${SIMPLIFY_DEGREES}), 0.0001), 3) AS simplified,
                ST_CollectionExtract(ST_MakeValid(geom), 3) AS as_published
      FROM raw_${key} WHERE ${where})`;
  await db.run(drawn("before2008", `state = '${STATE}'`));
  await db.run(drawn("yearly", `state = '${STATE}' AND main_class = 'DESMATAMENTO'`));

  // What is left out is only slivers: pieces of under a hectare, cut at a
  // satellite scene's edge, with no area even as published. Anything
  // larger is refused.
  const [{ kept_as_published }] = await db.rows(`
    SELECT (SELECT count(*) FILTER (WHERE kept_as_published) FROM drawn_before2008)::INTEGER
         + (SELECT count(*) FILTER (WHERE kept_as_published) FROM drawn_yearly)::INTEGER AS kept_as_published`);
  const [slivers] = await db.rows(`
    SELECT count(*)::INTEGER AS polygons, max(area_km) AS largest_km2, round(sum(area_km), 4) AS km2 FROM (
      SELECT area_km, shape FROM drawn_before2008 UNION ALL SELECT area_km, shape FROM drawn_yearly)
    WHERE ST_IsEmpty(shape)`);
  if (slivers.largest_km2 !== null && slivers.largest_km2 >= 0.01) throw new Error(`Simplifying emptied a polygon of ${slivers.largest_km2} km².`);

  // The forest cleared before 2008: PRODES's mask of everything cleared up
  // to its 2007 survey, the fishbone itself.
  await db.run(`
    CREATE TABLE cleared_before_2008 AS
    SELECT round(area_km, 4) AS area_km2, shape AS geom
    FROM drawn_before2008 WHERE NOT ST_IsEmpty(shape)
    ORDER BY area_km2 DESC`);
  // The forest cleared each year since: PRODES's year runs from August to
  // July and is named for the July it ends in; each polygon keeps its
  // year, the date of the satellite image that first showed it cleared,
  // and its area.
  await db.run(`
    CREATE TABLE cleared_by_year AS
    SELECT CAST(year AS SMALLINT) AS prodes_year,
           make_date(CAST(year AS INTEGER), 7, 31) AS year_ending,
           CAST(image_date AS DATE) AS image_date,
           round(area_km, 4) AS area_km2,
           shape AS geom
    FROM drawn_yearly WHERE NOT ST_IsEmpty(shape)
    ORDER BY prodes_year, area_km2 DESC`);

  const [before] = await db.rows(`
    SELECT count(*)::INTEGER AS polygons, round(sum(area_km2), 1) AS km2,
           sum(ST_NPoints(geom))::BIGINT AS vertices,
           (SELECT sum(ST_NPoints(geom))::BIGINT FROM raw_before2008) AS vertices_read
    FROM cleared_before_2008`);
  const [yearly] = await db.rows(`
    SELECT count(*)::INTEGER AS polygons, round(sum(area_km2), 1) AS km2,
           min(prodes_year)::INTEGER AS first_year, max(prodes_year)::INTEGER AS last_year,
           sum(ST_NPoints(geom))::BIGINT AS vertices,
           (SELECT sum(ST_NPoints(geom))::BIGINT FROM raw_yearly) AS vertices_read,
           (SELECT count(*) FROM raw_yearly WHERE main_class <> 'DESMATAMENTO')::INTEGER AS other_class,
           min(ST_XMin(geom)) AS west, max(ST_XMax(geom)) AS east, min(ST_YMin(geom)) AS south, max(ST_YMax(geom)) AS north
    FROM cleared_by_year`);
  const perYear = await db.rows(`
    SELECT prodes_year::INTEGER AS year, count(*)::INTEGER AS polygons, round(sum(area_km2), 1) AS km2
    FROM cleared_by_year GROUP BY prodes_year ORDER BY prodes_year`);
  const kinds = await db.rows(`
    SELECT ST_GeometryType(geom)::VARCHAR AS kind, count(*)::INTEGER AS n FROM (
      SELECT geom FROM cleared_before_2008 UNION ALL SELECT geom FROM cleared_by_year) GROUP BY ALL`);
  if (kinds.some((k) => !["POLYGON", "MULTIPOLYGON"].includes(k.kind))) throw new Error(`Not every shape is a polygon: ${JSON.stringify(kinds)}.`);
  // Rondônia lies between 66.9 and 59.7 west and 7.9 and 13.7 south.
  if (yearly.west < -67 || yearly.east > -59.6 || yearly.south < -13.8 || yearly.north > -7.8) {
    throw new Error(`The polygons fall outside Rondônia: ${JSON.stringify(yearly)}.`);
  }

  const outputs = {};
  for (const [name, rows] of [["cleared_before_2008", before.polygons], ["cleared_by_year", yearly.polygons]]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    outputs[name] = { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
  }

  const record = {
    template: "rondonia-fishbone",
    builtAt: new Date().toISOString(),
    slice: {
      state: STATE,
      before2008: before,
      yearly: { ...yearly, perYear },
      simplifiedByDegrees: SIMPLIFY_DEGREES,
      sliversLeftOut: slivers,
      keptAsPublishedRatherThanErased: kept_as_published,
    },
    sources: Object.fromEntries(Object.entries(fetched).map(([key, f]) => [key, {
      type: LAYERS[key].type,
      record: f.record,
      recordUpdated: f.recordUpdated,
      hits: f.hits,
      matched: f.matched,
      pages: f.pages.map(strip),
    }])),
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`before 2008: ${before.polygons} polygons, ${before.km2} km²; ${yearly.first_year} to ${yearly.last_year}: ${yearly.polygons} polygons, ${yearly.km2} km²\n`);
} finally {
  db.close();
}
// The downloads are deleted once the GeoParquet is built; the build record
// keeps their addresses, sizes and hashes.
await rm(downloads, { recursive: true, force: true });
