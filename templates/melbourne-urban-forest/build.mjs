// Build "Melbourne's urban forest": fetch the City of Melbourne's tree
// inventory ("Trees, with species and dimensions (Urban Forest)") from its
// open data portal at a pinned address, and prepare the one dataset the
// map reads: every tree the city maintains, with its species, where it
// stands, and the useful life the city's arborists expect it to have left.
//
//   node templates/melbourne-urban-forest/build.mjs [work folder]
//
// Writes <work>/melbourne-urban-forest/data/trees.parquet and
// <work>/melbourne-urban-forest/build-record.json.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "melbourne-urban-forest");

// The portal's dataset, its catalogue record (licence, update time, record
// count) and its whole export as Parquet. The export is the dataset as it
// stands when read; the record's update time and the file's hash say which.
const DATASET = "trees-with-species-and-dimensions-urban-forest";
const RECORD_ADDRESS = `https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/${DATASET}`;
const EXPORT_ADDRESS = `https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/${DATASET}/exports/parquet`;

// The inventory's useful life classes, as the city words them, and the
// words the map uses. A tree whose class is empty has not been assessed:
// the export still carries a value of 50 years for it, which the map does
// not take as an assessment.
const LIFE_CLASSES = {
  "< 10 years": { label: "Under 10 years", years: 10 },
  "11 - 20 years": { label: "11 to 20 years", years: 20 },
  "21 - 30 years": { label: "21 to 30 years", years: 30 },
  "31 - 40 years": { label: "31 to 40 years", years: 40 },
  "> 41 years": { label: "Over 40 years", years: 50 },
};
const NOT_ASSESSED = "Not assessed";

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const recordFile = await download(downloads, "record", RECORD_ADDRESS, "record.json");
const exportFile = await download(downloads, "trees", EXPORT_ADDRESS, "trees.parquet");
const catalogue = JSON.parse(await readFile(recordFile.path, "utf8")).metas.default;
if (catalogue.license !== "CC BY" || catalogue.license_url !== "https://creativecommons.org/licenses/by/4.0/legalcode") {
  throw new Error(`The record states the licence ${catalogue.license} (${catalogue.license_url}), not CC BY 4.0.`);
}
process.stdout.write(`record: modified ${catalogue.modified}, ${catalogue.records_count} records; export: ${exportFile.bytes} bytes\n`);

const db = await engine();
try {
  const columns = new Set((await db.rows(`DESCRIBE SELECT * FROM read_parquet(${literal(exportFile.path)})`)).map((c) => c.column_name));
  for (const needed of ["com_id", "common_name", "scientific_name", "genus", "family", "age_description", "useful_life_expectency", "precinct", "located_in", "latitude", "longitude"]) {
    if (!columns.has(needed)) throw new Error(`The export has no ${needed} column.`);
  }
  const classes = Object.entries(LIFE_CLASSES);
  await db.run(`
    CREATE TABLE life (source VARCHAR, label VARCHAR, years TINYINT);
    INSERT INTO life VALUES ${classes.map(([source, { label, years }]) => `(${literal(source)}, ${literal(label)}, ${years})`).join(", ")}`);
  const [unknown] = await db.rows(`
    SELECT count(*)::INTEGER AS n, string_agg(DISTINCT useful_life_expectency, ', ') AS classes
    FROM read_parquet(${literal(exportFile.path)})
    WHERE useful_life_expectency IS NOT NULL AND useful_life_expectency NOT IN (SELECT source FROM life)`);
  if (unknown.n) throw new Error(`${unknown.n} trees carry a life class this build does not know: ${unknown.classes}.`);

  // One row per tree: its id, names, family, where it stands (street or
  // park, precinct), its age, and its useful life left as a class and as
  // the class's years; its place as a point from the inventory's own
  // longitude and latitude. The trunk diameter and the planting year are
  // left out: most diameters are missing and some are impossible (one of
  // 260 metres), and a third of the trees carry 1900 as a stand-in year.
  await db.run(`
    CREATE TABLE trees AS
    SELECT t.com_id AS tree,
           t.common_name,
           t.scientific_name,
           t.genus,
           t.family,
           t.located_in,
           t.precinct,
           t.age_description AS age,
           coalesce(l.label, ${literal(NOT_ASSESSED)}) AS useful_life,
           l.years AS useful_life_years,
           ST_Point(t.longitude, t.latitude) AS geom
    FROM read_parquet(${literal(exportFile.path)}) t
    LEFT JOIN life l ON l.source = t.useful_life_expectency
    WHERE t.longitude IS NOT NULL AND t.latitude IS NOT NULL
    ORDER BY tree`);

  const [tally] = await db.rows(`
    SELECT (SELECT count(*) FROM read_parquet(${literal(exportFile.path)}))::INTEGER AS records,
           count(*)::INTEGER AS trees,
           count(DISTINCT tree)::INTEGER AS ids,
           count(DISTINCT genus)::INTEGER AS genera,
           count(*) FILTER (WHERE useful_life_years <= 10)::INTEGER AS under_10,
           count(*) FILTER (WHERE useful_life_years <= 20)::INTEGER AS under_20,
           count(*) FILTER (WHERE useful_life = ${literal(NOT_ASSESSED)})::INTEGER AS not_assessed,
           min(ST_X(geom)) AS west, max(ST_X(geom)) AS east, min(ST_Y(geom)) AS south, max(ST_Y(geom)) AS north
    FROM trees`);
  if (tally.ids !== tally.trees) throw new Error("A tree id appears twice.");
  if (tally.trees !== catalogue.records_count) throw new Error(`The export holds ${tally.trees} trees; the record states ${catalogue.records_count}.`);
  if (tally.west < 144.85 || tally.east > 145.05 || tally.south < -37.9 || tally.north > -37.75) {
    throw new Error(`The trees lie outside the City of Melbourne: ${JSON.stringify(tally)}.`);
  }

  const outputs = {};
  const file = path.join(data, "trees.parquet");
  await db.run(`COPY trees TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  outputs.trees = { file: path.relative(work, file), rows: tally.trees, sha256: sha256(await readFile(file)) };

  const record = {
    template: "melbourne-urban-forest",
    builtAt: new Date().toISOString(),
    slice: {
      datasetModified: catalogue.modified,
      recordsInExport: tally.records,
      trees: tally.trees,
      genera: tally.genera,
      underTenYears: tally.under_10,
      twentyYearsOrLess: tally.under_20,
      notAssessed: tally.not_assessed,
    },
    sources: {
      record: (({ path: p, ...f }) => f)(recordFile),
      trees: (({ path: p, ...f }) => f)(exportFile),
      licence: { stated: catalogue.license, url: catalogue.license_url },
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`trees: ${tally.trees} (${tally.genera} genera; ${tally.under_20} with 20 years or less, ${tally.not_assessed} not assessed)\n`);
} finally {
  db.close();
}
