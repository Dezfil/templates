// Build "Every tree in Berlin": fetch the city's two tree registers from
// Berlin's geodata infrastructure at pinned addresses (the GRIS register's
// street and park trees, and Grün Berlin GmbH's own park trees), check
// each catalogue record's licence, and prepare the one dataset the map
// reads: every tree, with its genus, species, planting year, size, district
// and street or park, one dataset per register.
//
//   node templates/berlin-trees/build.mjs [work folder]
//
// Writes <work>/berlin-trees/data/{trees,gruen_berlin_trees}.parquet and
// <work>/berlin-trees/build-record.json.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { engine, literal, sha256 } from "../../tools/source.mjs";
import { downloadStream } from "../../tools/stream.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "berlin-trees");

// The registers' catalogue records (each states its licence) and their
// feature services, read whole as GeoPackage (EPSG:25833).
const RECORDS = {
  gris: "https://gdi.berlin.de/geonetwork/srv/api/records/3368004a-d596-336a-8fdf-c4391f3313dd/formatters/xml",
  gruenBerlin: "https://gdi.berlin.de/geonetwork/srv/api/records/558eed2a-2d05-4447-a580-e26e7dccd48a/formatters/xml",
};
const wfs = (service, type) =>
  `https://gdi.berlin.de/services/wfs/${service}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${type}&outputFormat=geopackage`;
const LAYERS = {
  street: wfs("baumbestand", "baumbestand:strassenbaeume"),
  park: wfs("baumbestand", "baumbestand:anlagenbaeume"),
  gruenBerlin: wfs("baumbestand_gruen_berlin", "baumbestand_gruen_berlin:anlagenbaum_gruenberlin"),
};

// English names for the genera a reader meets most; the rest keep their
// botanical name alone.
const GENUS_NAMES = {
  Tilia: "Lime",
  Acer: "Maple",
  Quercus: "Oak",
  Platanus: "Plane",
  Aesculus: "Horse chestnut",
  Robinia: "Black locust",
  Betula: "Birch",
  Carpinus: "Hornbeam",
  Fraxinus: "Ash",
  Populus: "Poplar",
  Pinus: "Pine",
  Prunus: "Cherry and plum",
  Fagus: "Beech",
  Salix: "Willow",
  Ulmus: "Elm",
  Sorbus: "Rowan and whitebeam",
  Crataegus: "Hawthorn",
  Malus: "Apple",
  Pyrus: "Pear",
  Alnus: "Alder",
  Corylus: "Hazel",
  Gleditsia: "Honey locust",
  Sophora: "Pagoda tree",
  Styphnolobium: "Pagoda tree",
  Ginkgo: "Ginkgo",
  Picea: "Spruce",
  Taxus: "Yew",
  Ailanthus: "Tree of heaven",
  Catalpa: "Catalpa",
  Liquidambar: "Sweetgum",
  Celtis: "Hackberry",
  Larix: "Larch",
  Juglans: "Walnut",
  Castanea: "Sweet chestnut",
};

const LICENCES = {
  gris: "Datenlizenz Deutschland - Zero - Version 2.0",
  gruenBerlin: "Datenlizenz Deutschland - Namensnennung - Version 2.0",
};

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const records = {};
for (const [key, url] of Object.entries(RECORDS)) {
  records[key] = await downloadStream(downloads, `record-${key}`, url, `${key}.xml`);
  const text = await readFile(records[key].path, "utf8");
  if (!text.includes(`Für die Nutzung der Daten ist die ${LICENCES[key]} anzuwenden`)) {
    throw new Error(`The ${key} record no longer states "${LICENCES[key]}".`);
  }
  records[key].modified = text.match(/<gmd:dateStamp>\s*<gco:DateTime[^>]*>([^<]+)</)?.[1] ?? null;
}
const layers = {};
for (const [key, url] of Object.entries(LAYERS)) {
  layers[key] = await downloadStream(downloads, key, url, `${key}.gpkg`);
  process.stdout.write(`${key}: ${layers[key].bytes} bytes\n`);
}

const db = await engine();
try {
  await db.run("SET memory_limit = '3GB'; SET threads = 4;");
  const read = (key) => `ST_Read(${literal(layers[key].path)})`;
  const year = (column) =>
    `CASE WHEN regexp_full_match(trim(${column}), '\\d{4}') AND trim(${column})::INTEGER BETWEEN 1700 AND year(current_date) THEN trim(${column})::INTEGER END`;
  const positive = (column) => `CASE WHEN ${column} > 0 THEN ${column} END`;
  // A name as the register spells it, tidied: GRIS writes "Tilia", Grün
  // Berlin "TILIA"; one space between words.
  const initcap = (column) => `CASE WHEN trim(${column}) <> '' THEN upper(left(trim(${column}), 1)) || lower(substr(trim(${column}), 2)) END`;
  const tidy = (column) => `nullif(regexp_replace(trim(${column}), '\\s+', ' ', 'g'), '')`;

  // One row per tree from each register, in the registers' own words.
  await db.run(`
    CREATE TABLE raw AS
    SELECT gisid AS tree, 'Street tree' AS register, ${initcap("gattung")} AS genus, ${tidy("art_bot")} AS species,
           ${tidy("art_dtsch")} AS species_de, ${year("pflanzjahr")} AS planted, ${positive("baumhoehe")} AS height_m,
           ${positive("kronedurch")} AS crown_m, ${positive("stammumfg")} AS trunk_cm, ${tidy("bezirk")} AS district,
           ${tidy("strname")} AS place, geom
    FROM ${read("street")}
    UNION ALL
    SELECT gisid, 'Park tree', ${initcap("gattung")}, ${tidy("art_bot")}, ${tidy("art_dtsch")}, ${year("pflanzjahr")},
           ${positive("baumhoehe")}, ${positive("kronedurch")}, ${positive("stammumfg")}, ${tidy("bezirk")},
           ${tidy("namenr")}, geom
    FROM ${read("park")}
    UNION ALL
    SELECT baumid, 'Grün Berlin park tree', ${initcap("gattung_bo")}, ${tidy("baumart_bo")}, ${tidy("baumart_de")},
           ${year("pflanzjahr")}, ${positive("baumhoehe")}, ${positive("kronendurc")}, ${positive("stammumfan")},
           ${tidy("bezirk")}, ${tidy("objektname")}, geom
    FROM ${read("gruenBerlin")}`);

  const genusNames = Object.entries(GENUS_NAMES);
  await db.run(`
    CREATE TABLE names (genus VARCHAR, name VARCHAR);
    INSERT INTO names VALUES ${genusNames.map(([g, n]) => `(${literal(g)}, ${literal(n)})`).join(", ")}`);

  // The botanical species is kept as the register writes it, its case
  // tidied for Grün Berlin's capitals ("FAGUS SYLVATICA" as "Fagus
  // sylvatica"). The place is turned from EPSG:25833 into longitude and
  // latitude.
  await db.run(`
    CREATE TABLE trees AS
    SELECT r.tree,
           r.register,
           r.genus,
           CASE WHEN n.name IS NOT NULL THEN n.name || ' (' || r.genus || ')' ELSE r.genus END AS genus_name,
           CASE WHEN r.register = 'Grün Berlin park tree' THEN upper(left(r.species, 1)) || lower(substr(r.species, 2)) ELSE r.species END AS species,
           r.species_de,
           r.planted,
           r.height_m,
           r.crown_m,
           r.trunk_cm,
           r.district,
           r.place,
           ST_Transform(r.geom, 'EPSG:25833', 'EPSG:4326', always_xy := true) AS geom
    FROM raw r
    LEFT JOIN names n ON n.genus = r.genus
    -- 6,296 entries of the city's register carry an id and a place but
    -- nothing else (no genus, species, district or street): they are left
    -- out as no tree a reader can be told anything about.
    WHERE r.geom IS NOT NULL AND (r.genus IS NOT NULL OR r.species IS NOT NULL OR r.district IS NOT NULL)
    ORDER BY r.district, r.tree`);

  const [tally] = await db.rows(`
    SELECT count(*)::INTEGER AS trees,
           count(DISTINCT tree)::INTEGER AS ids,
           count(*) FILTER (WHERE register = 'Street tree')::INTEGER AS street,
           count(*) FILTER (WHERE register = 'Park tree')::INTEGER AS park,
           count(*) FILTER (WHERE register = 'Grün Berlin park tree')::INTEGER AS gruen_berlin,
           count(*) FILTER (WHERE planted IS NOT NULL)::INTEGER AS with_year,
           count(*) FILTER (WHERE genus IS NULL)::INTEGER AS no_genus,
           count(DISTINCT genus)::INTEGER AS genera,
           min(ST_X(geom)) AS west, max(ST_X(geom)) AS east, min(ST_Y(geom)) AS south, max(ST_Y(geom)) AS north
    FROM trees`);
  if (tally.ids !== tally.trees) {
    const twice = await db.rows("SELECT tree, count(*)::INTEGER AS n, string_agg(DISTINCT register, ', ') AS registers FROM trees GROUP BY tree HAVING count(*) > 1 ORDER BY n DESC LIMIT 5");
    throw new Error(`${tally.trees - tally.ids} tree ids appear twice: ${JSON.stringify(twice)}.`);
  }
  if (tally.west < 13.05 || tally.east > 13.8 || tally.south < 52.3 || tally.north > 52.7) {
    throw new Error(`The trees lie outside Berlin: ${JSON.stringify(tally)}.`);
  }
  const districts = await db.rows(`
    SELECT district, count(*)::INTEGER AS trees, round(avg(planted))::INTEGER AS mean_planted
    FROM trees GROUP BY district ORDER BY trees DESC`);
  const genera = await db.rows(`
    SELECT genus_name, count(*)::INTEGER AS trees FROM trees GROUP BY genus_name ORDER BY trees DESC LIMIT 12`);

  // Two datasets, one per register, as each has its own licence: the
  // city's register (street and park trees) and Grün Berlin's.
  const outputs = {};
  for (const [name, where] of [["trees", "register <> 'Grün Berlin park tree'"], ["gruen_berlin_trees", "register = 'Grün Berlin park tree'"]]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY (SELECT * FROM trees WHERE ${where}) TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`);
    const [{ n }] = await db.rows(`SELECT count(*)::INTEGER AS n FROM read_parquet(${literal(file)})`);
    outputs[name] = { file: path.relative(work, file), rows: n, sha256: sha256(await readFile(file)) };
  }

  const strip = ({ path: p, ...f }) => f;
  const record = {
    template: "berlin-trees",
    builtAt: new Date().toISOString(),
    slice: { ...tally, districts, genera },
    sources: {
      records: Object.fromEntries(Object.entries(records).map(([k, v]) => [k, strip(v)])),
      layers: Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, strip(v)])),
    },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`trees: ${JSON.stringify(tally)}\n${JSON.stringify(districts)}\n${JSON.stringify(genera)}\n`);
} finally {
  db.close();
}
