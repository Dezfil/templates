// Build "Valencia's 2024 flood footprint": fetch the Copernicus Emergency
// Management Service's grading map of l'Horta Sud (activation EMSR773,
// area of interest 3, version 2) and the municipalities Overture Maps
// holds in that area, each from its publisher at a pinned address, and
// prepare the four datasets the map reads: the flood's footprint, the
// buildings the service graded, the area it mapped, and the towns.
//
//   node templates/valencia-flood/build.mjs [work folder]
//
// Writes <work>/valencia-flood/data/{flood,graded_buildings,area_mapped,towns}.parquet
// and <work>/valencia-flood/build-record.json.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";
import { downloadStream } from "../../tools/stream.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "valencia-flood");

// The activation's record in the service's public dashboard, the terms
// that state the licence, and the citation guidelines that set the credit.
const ACTIVATION = "https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?code=EMSR773";
const TERMS = "https://mapping.emergency.copernicus.eu/terms-and-conditions/";
const CITATION = "https://mapping.emergency.copernicus.eu/about/citation-guidelines/";
const TERMS_WORDS = [
  "users are granted free access to the data of CEMS On-Demand Mapping for the following purposes",
  "(d) adaptation, modification and combination with other data and information",
  "Where the user communicates to the public or distributes data of the CEMS On-Demand Mapping, he/she shall inform the recipients of the source of that data",
];
const CITATION_WORDS = [
  "For a specific Copernicus EMS map and/or geospatial dataset",
  "Copernicus Emergency Management Service (© activation_year European Union), [Activation ID] Name of the Area of Interest (AOI): Product Type",
];
// The grading map of area 3, Horta Sud, version 2 (delivered 6 November
// 2024, from a GeoEye-1 image of 31 October): the observed flood, its
// traces, and every building the analysts saw damaged.
const PRODUCT = { aoi: 3, type: "GRA", version: 2 };
const PRODUCT_ZIP = "https://rapidmapping.emergency.copernicus.eu/backend/EMSR773/AOI03/GRA_PRODUCT/EMSR773_AOI03_GRA_PRODUCT_v2.zip";
const LAYER = (name) => `EMSR773_AOI03_GRA_PRODUCT_${name}_v2.json`;
// Overture Maps, release 2026-09-23.1: the towns from the divisions, with
// the attribution page that states their licence.
const OVERTURE_RELEASE = "2026-09-23.1";
const DIVISIONS = `s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=divisions/type=division_area/*.parquet`;
const OVERTURE_ATTRIBUTION = "https://docs.overturemaps.org/attribution/";
const OVERTURE_WORDS = ["Divisions License for theme: ODbL © OpenStreetMap contributors. Available under the Open Database License"];

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

// A page's text, tags dropped and entities and spaces evened out, to find
// a sentence in.
const pageText = async (file) =>
  (await readFile(file, "utf8"))
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/[​ ]/g, " ")
    .replace(/\s+/g, " ");
const requireWords = async (file, words, what) => {
  const text = await pageText(file);
  for (const w of words) if (!text.includes(w)) throw new Error(`${what} no longer says: "${w}".`);
};

const activation = await download(downloads, "activation", ACTIVATION, "activation.json");
const record = JSON.parse(await readFile(activation.path, "utf8")).results?.[0];
if (record?.code !== "EMSR773" || record.sensitive) throw new Error("The activation's record is not the open EMSR773.");
const aoi = record.aois.find((a) => a.number === PRODUCT.aoi);
const product = aoi?.products.find((p) => p.type === PRODUCT.type && p.version?.number === PRODUCT.version);
if (!product || product.downloadPath !== PRODUCT_ZIP) throw new Error(`The record no longer lists ${PRODUCT_ZIP} as area ${PRODUCT.aoi}'s grading map, version ${PRODUCT.version}.`);
const image = product.images?.[0];

const terms = await download(downloads, "terms", TERMS, "terms.html");
await requireWords(terms.path, TERMS_WORDS, "The service's terms");
const citation = await download(downloads, "citation", CITATION, "citation.html");
await requireWords(citation.path, CITATION_WORDS, "The citation guidelines");
const attribution = await download(downloads, "overture-attribution", OVERTURE_ATTRIBUTION, "attribution.html");
await requireWords(attribution.path, OVERTURE_WORDS, "Overture's attribution page");

// The product's archive, and the three layers the map uses taken out of
// it into a folder of their own.
const zip = await downloadStream(downloads, "product", PRODUCT_ZIP, "EMSR773_AOI03_GRA_PRODUCT_v2.zip");
const unpacked = await mkdtemp(path.join(downloads, "product-unpacked-"));
for (const name of ["observedEventA", "builtUpP", "areaOfInterestA"]) {
  await run("unzip", ["-j", "-o", zip.path, LAYER(name), "-d", unpacked]);
}
process.stdout.write(`product: ${zip.bytes} bytes; image ${image?.sensorName} ${image?.acquisitionTime}\n`);

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'; SET threads = 4;");
  await db.run("INSTALL httpfs; LOAD httpfs; SET s3_region = 'us-west-2';");

  // The area the service mapped, the flood seen in it and the graded
  // buildings; the product's area is in hectares. Every geometry is kept
  // in longitude and latitude without a stated CRS, so the service's
  // layers (EPSG:4326) and Overture's (OGC:CRS84) meet.
  await db.run(`
    CREATE TABLE area_mapped AS
    SELECT 'Horta Sud (AOI03)' AS area, round(ST_Area_Spheroid(ST_FlipCoordinates(geom)) / 1e6, 1) AS area_km2, geom::GEOMETRY AS geom
    FROM ST_Read(${literal(path.join(unpacked, LAYER("areaOfInterestA")))})`);
  await db.run(`
    CREATE TABLE flood AS
    SELECT row_number() OVER (ORDER BY notation, OGC_FID)::INTEGER AS patch,
           CASE notation WHEN 'Flooded area' THEN 'Standing water' WHEN 'Flood trace' THEN 'Flood traces' END AS seen,
           round(area / 100, 4) AS area_km2,
           geom::GEOMETRY AS geom
    FROM ST_Read(${literal(path.join(unpacked, LAYER("observedEventA")))})
    ORDER BY patch`);
  await db.run(`
    CREATE TABLE graded_buildings AS
    SELECT row_number() OVER (ORDER BY OGC_FID)::INTEGER AS point,
           damage_gra AS grade,
           CASE obj_type WHEN '11-Residential Buildings' THEN 'Residential' WHEN '12-Non-residential Buildings' THEN 'Non-residential' ELSE 'Unclassified' END AS kind,
           nullif(name, 'Unknown') AS name,
           geom::GEOMETRY AS geom
    FROM ST_Read(${literal(path.join(unpacked, LAYER("builtUpP")))})
    ORDER BY point`);
  const [seen] = await db.rows(`
    SELECT (SELECT count(*) FROM flood WHERE seen IS NULL)::INTEGER AS unnamed,
           (SELECT count(*) FROM graded_buildings WHERE grade NOT IN ('Destroyed', 'Damaged', 'Possibly damaged'))::INTEGER AS ungraded`);
  if (seen.unnamed || seen.ungraded) throw new Error(`The product's classes changed: ${JSON.stringify(seen)}.`);
  const [box] = await db.rows("SELECT ST_XMin(geom) AS x0, ST_XMax(geom) AS x1, ST_YMin(geom) AS y0, ST_YMax(geom) AS y1 FROM area_mapped");

  // The towns: Overture's localities in the area, outline and name from
  // OpenStreetMap. The comarcas are localities too, each holding several
  // towns, so a locality that holds a smaller one is left out; the
  // comarca of València has the city's own outline and gives way to it.
  await db.run(`
    CREATE TABLE localities AS
    SELECT id, names.primary AS town, geometry::GEOMETRY AS geom, ST_Area_Spheroid(ST_FlipCoordinates(geometry)) AS m2, sources
    FROM read_parquet(${literal(DIVISIONS)})
    WHERE country = 'ES' AND subtype = 'locality' AND class = 'land'
      AND bbox.xmax > ${box.x0} AND bbox.xmin < ${box.x1} AND bbox.ymax > ${box.y0} AND bbox.ymin < ${box.y1}`);
  await db.run(`
    CREATE TABLE towns AS
    SELECT a.id AS division, a.town, a.geom
    FROM localities a, area_mapped m
    WHERE ST_Intersects(a.geom, m.geom)
      AND NOT EXISTS (
        SELECT 1 FROM localities b
        WHERE b.id <> a.id AND ST_Contains(a.geom, ST_PointOnSurface(b.geom))
          AND (b.m2 < 0.99 * a.m2 OR (abs(b.m2 - a.m2) <= 0.01 * a.m2 AND length(b.town) < length(a.town))))
    ORDER BY a.town`);
  const townSources = await db.rows(`
    WITH s AS (SELECT unnest(sources) AS source FROM localities WHERE id IN (SELECT division FROM towns))
    SELECT source.dataset AS dataset, count(*)::INTEGER AS n
    FROM s WHERE source.property IN ('', '/geometry', '/properties/names/primary')
    GROUP BY ALL`);
  if (townSources.some((s) => s.dataset !== "OpenStreetMap")) {
    throw new Error(`A town's outline or name comes from ${JSON.stringify(townSources)}, not OpenStreetMap alone.`);
  }

  const [tally] = await db.rows(`
    SELECT (SELECT area_km2 FROM area_mapped) AS area_mapped_km2,
           (SELECT count(*) FROM flood)::INTEGER AS flood_patches,
           (SELECT round(sum(area_km2), 2) FROM flood WHERE seen = 'Standing water') AS standing_water_km2,
           (SELECT round(sum(area_km2), 2) FROM flood WHERE seen = 'Flood traces') AS flood_traces_km2,
           (SELECT count(*) FROM graded_buildings)::INTEGER AS graded,
           (SELECT count(*) FROM graded_buildings WHERE grade = 'Destroyed')::INTEGER AS destroyed,
           (SELECT count(*) FROM graded_buildings WHERE grade = 'Damaged')::INTEGER AS damaged,
           (SELECT count(*) FROM graded_buildings WHERE grade = 'Possibly damaged')::INTEGER AS possibly_damaged,
           (SELECT count(*) FROM towns)::INTEGER AS towns,
           (SELECT string_agg(town, ', ' ORDER BY town) FROM towns) AS town_names`);

  const outputs = {};
  for (const name of ["flood", "graded_buildings", "area_mapped", "towns"]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    const [{ n }] = await db.rows(`SELECT count(*)::INTEGER AS n FROM ${name}`);
    outputs[name] = { file: path.relative(work, file), rows: n, sha256: sha256(await readFile(file)) };
  }

  const strip = ({ path: p, ...f }) => f;
  const built = {
    template: "valencia-flood",
    builtAt: new Date().toISOString(),
    slice: tally,
    sources: {
      activation: { ...strip(activation), product: { id: product.id, aoi: aoi.name, type: product.type, version: product.version, image } },
      terms: strip(terms),
      citation: strip(citation),
      product: strip(zip),
      overtureAttribution: strip(attribution),
      overture: { release: OVERTURE_RELEASE, divisions: DIVISIONS, readAt: new Date().toISOString(), townSources },
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(built, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(tally)}\n`);
} finally {
  db.close();
}
