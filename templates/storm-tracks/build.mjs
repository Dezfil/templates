// Build "Storm tracks since 1980": fetch NOAA's International Best Track
// Archive for Climate Stewardship (IBTrACS) from its publisher and prepare
// the one dataset the map draws: every track point of every storm that
// formed from 1980 to 2025.
//
//   node templates/storm-tracks/build.mjs [work folder]
//
// Writes <work>/storm-tracks/data/storm_track_points.parquet and
// <work>/storm-tracks/build-record.json (the address, when it was read, its
// bytes and SHA-256, and the rows that came out).

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { download, engine, literal, sha256 } from "../../tools/source.mjs";
import { readFile } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "storm-tracks");

// IBTrACS v04r01, the "since1980" subset as one CSV: the modern era of
// satellite observation. NCEI updates the file three times a week and keeps
// no dated copies, so the build record keeps its bytes and SHA-256.
const VERSION = "v04r01";
const ADDRESS = `https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/${VERSION}/access/csv/ibtracs.since1980.list.${VERSION}.csv`;

// The slice: every storm whose first point falls in a whole calendar year
// from 1980 to 2025, so the newest, still provisional season stays out.
const FIRST_YEAR = 1980;
const LAST_YEAR = 2025;

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const csv = await download(downloads, "ibtracs-since1980", ADDRESS, "ibtracs.since1980.csv");
process.stdout.write(`ibtracs: ${csv.bytes} bytes\n`);

const db = await engine();
try {
  // The file has a second header row with the units; every column is read
  // as text (so "NA", the North Atlantic, stays a basin and never a
  // missing value) and the units row is dropped where ISO_TIME is not a time.
  await db.run(`
    CREATE TABLE raw AS
    SELECT SID, SEASON, BASIN, NAME, ISO_TIME, NATURE, LAT, LON, USA_WIND, USA_SSHS, WMO_WIND, TRACK_TYPE, DIST2LAND
    FROM read_csv(${literal(csv.path)}, header = true, all_varchar = true, nullstr = '', quote = '"')
    WHERE try_cast(ISO_TIME AS TIMESTAMP) IS NOT NULL`);
  const [{ rows, storms, spur }] = await db.rows(`
    SELECT count(*)::INTEGER AS rows, count(DISTINCT SID)::INTEGER AS storms,
           count(*) FILTER (WHERE TRACK_TYPE <> 'main')::INTEGER AS spur
    FROM raw`);

  // Spur tracks are alternative positions kept for storms that merged or
  // split; only each storm's main track is kept.
  await db.run(`
    CREATE TABLE main AS
    SELECT * FROM raw WHERE TRACK_TYPE = 'main'`);
  await db.run(`
    CREATE TABLE kept AS
    SELECT SID FROM main GROUP BY SID
    HAVING year(min(CAST(ISO_TIME AS TIMESTAMP))) BETWEEN ${FIRST_YEAR} AND ${LAST_YEAR}`);

  // The Saffir-Simpson category from the US agencies' one-minute winds
  // (NHC and JTWC between them track every basin), as IBTrACS gives it in
  // USA_SSHS; below a tropical storm, everything weaker or not tropical.
  await db.run(`
    CREATE TABLE storm_track_points AS
    SELECT
      m.SID AS storm_id,
      CASE WHEN m.NAME IN ('NOT_NAMED', 'UNNAMED') THEN NULL ELSE m.NAME END AS name,
      CAST(m.SEASON AS INTEGER) AS season,
      CASE m.BASIN
        WHEN 'NA' THEN 'North Atlantic'
        WHEN 'EP' THEN 'Eastern Pacific'
        WHEN 'WP' THEN 'Western Pacific'
        WHEN 'NI' THEN 'North Indian'
        WHEN 'SI' THEN 'South Indian'
        WHEN 'SP' THEN 'South Pacific'
        WHEN 'SA' THEN 'South Atlantic'
        ELSE 'Unknown'
      END AS basin,
      CAST(m.ISO_TIME AS TIMESTAMP) AS time_utc,
      CAST(try_cast(m.USA_WIND AS INTEGER) AS INTEGER) AS wind_kt,
      CAST(coalesce(try_cast(m.USA_SSHS AS INTEGER), -5) AS INTEGER) AS category_rank,
      CASE
        WHEN try_cast(m.USA_SSHS AS INTEGER) >= 1 THEN 'Category ' || m.USA_SSHS
        WHEN try_cast(m.USA_SSHS AS INTEGER) = 0 THEN 'Tropical storm'
        ELSE 'Weaker or not tropical'
      END AS category,
      CAST(try_cast(m.DIST2LAND AS INTEGER) AS INTEGER) AS distance_to_land_km,
      -- IBTrACS keeps a storm's longitudes continuous across the
      -- antimeridian (a Pacific track can run on past 180°); every point is
      -- brought back to -180 to 180, and the map's SQL breaks a track where
      -- it crosses.
      ST_Point(round(((CAST(m.LON AS DOUBLE) + 540) % 360) - 180, 2), round(CAST(m.LAT AS DOUBLE), 2)) AS geom
    FROM main m JOIN kept USING (SID)
    ORDER BY storm_id, time_utc`);
  const [{ points, kept_storms, first, last, lon_min, lon_max, cat5 }] = await db.rows(`
    SELECT count(*)::INTEGER AS points, count(DISTINCT storm_id)::INTEGER AS kept_storms,
           min(time_utc)::VARCHAR AS first, max(time_utc)::VARCHAR AS last,
           min(ST_X(geom)) AS lon_min, max(ST_X(geom)) AS lon_max,
           count(DISTINCT storm_id) FILTER (WHERE category_rank = 5)::INTEGER AS cat5
    FROM storm_track_points`);
  const [{ wrapped }] = await db.rows(`SELECT count(*)::INTEGER AS wrapped FROM main JOIN kept USING (SID) WHERE CAST(LON AS DOUBLE) > 180 OR CAST(LON AS DOUBLE) < -180`);
  const [{ dupes }] = await db.rows(`
    SELECT count(*)::INTEGER AS dupes FROM (
      SELECT storm_id, time_utc FROM storm_track_points GROUP BY ALL HAVING count(*) > 1)`);
  if (dupes) throw new Error(`${dupes} storm times appear twice on a main track.`);
  if (lon_min < -180 || lon_max > 180) throw new Error(`Longitudes run ${lon_min} to ${lon_max}.`);

  const file = path.join(data, "storm_track_points.parquet");
  await db.run(`COPY storm_track_points TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  const outputs = { storm_track_points: { file: path.relative(work, file), rows: points, sha256: sha256(await readFile(file)) } };

  const { path: _p, ...source } = csv;
  const record = {
    template: "storm-tracks",
    builtAt: new Date().toISOString(),
    slice: {
      years: [FIRST_YEAR, LAST_YEAR],
      fileRows: rows,
      fileStorms: storms,
      spurRows: spur,
      storms: kept_storms,
      points,
      first,
      last,
      category5Storms: cat5,
      pointsBroughtBackFromPast180: wrapped,
    },
    sources: { ibtracs: source },
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`storm_track_points: ${points} points of ${kept_storms} storms, ${first} to ${last} (file: ${rows} rows, ${storms} storms, ${spur} spur rows)\n`);
} finally {
  db.close();
}
