// Build "Napoleon's march": place our reading of Minard's 1869 chart
// (trace.json, beside this script) on the map, and prepare the three
// datasets the map draws: the army's bands, the places and the
// temperatures of the retreat.
//
//   node templates/napoleons-march/build.mjs [work folder]
//
// Fetches the scan the reading was made on (to hold the reading to that
// exact image) and each place's Wikidata item (its coordinate), then pins
// the chart onto the map with a thin-plate spline through the places: each
// place lands on its real coordinate and the bands bend smoothly between
// them, as Minard drew them. Writes <work>/napoleons-march/data/
// {army,places,temperatures}.parquet and the build record.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { USER_AGENT, download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "napoleons-march");
const trace = JSON.parse(await readFile(path.join(here, "trace.json"), "utf8"));

// The Bibliothèque nationale de France's scan (Gallica btv1b52504201x), as
// Wikimedia Commons holds it: Gallica refuses automated readers.
const SCAN_PAGE = "https://commons.wikimedia.org/wiki/File:Carte_figurative_des_pertes_successives_en_hommes_de_l%27arm%C3%A9e_fran%C3%A7aise_dans_la_Campagne_de_Russie_1812-13.jpg";
const SCAN_ADDRESS = "https://upload.wikimedia.org/wikipedia/commons/5/59/Carte_figurative_des_pertes_successives_en_hommes_de_l%27arm%C3%A9e_fran%C3%A7aise_dans_la_Campagne_de_Russie_1812-13.jpg";
const entity = (id) => `https://www.wikidata.org/wiki/Special:EntityData/${id}.json`;

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const scan = await download(downloads, "minard-scan", SCAN_ADDRESS, "minard.jpg");
if (scan.sha256 !== trace.scan.sha256) throw new Error(`The scan answered ${scan.sha256}; the reading was made on ${trace.scan.sha256}.`);

// Each place's coordinate and English name from its Wikidata item.
const places = [];
for (const control of trace.controls) {
  const fetched = await download(downloads, `wikidata-${control.wikidata}`, entity(control.wikidata), `${control.wikidata}.json`);
  const item = JSON.parse(await readFile(fetched.path, "utf8")).entities[control.wikidata];
  const coordinate = (item.claims.P625 ?? []).find((c) => c.rank === "preferred") ?? item.claims.P625?.[0];
  const value = coordinate?.mainsnak?.datavalue?.value;
  if (!value) throw new Error(`${control.wikidata} has no coordinate.`);
  places.push({ ...control, name: item.labels.en.value, lon: value.longitude, lat: value.latitude, revision: item.lastrevid, fetched });
  await new Promise((resolve) => setTimeout(resolve, 200));
}

// A thin-plate spline from the scan's pixels (in thousands, for a
// well-conditioned system) to longitude and to latitude, exact at the places.
function thinPlate(points, values) {
  const n = points.length;
  const U = (r) => (r === 0 ? 0 : r * r * Math.log(r));
  const size = n + 3;
  const A = Array.from({ length: size }, () => new Array(size + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = U(Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]));
    A[i][n] = 1; A[i][n + 1] = points[i][0]; A[i][n + 2] = points[i][1];
    A[n][i] = 1; A[n + 1][i] = points[i][0]; A[n + 2][i] = points[i][1];
    A[i][size] = values[i];
  }
  for (let c = 0; c < size; c++) {
    let pivot = c;
    for (let r = c + 1; r < size; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
    [A[c], A[pivot]] = [A[pivot], A[c]];
    for (let r = 0; r < size; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= size; k++) A[r][k] -= f * A[c][k];
    }
  }
  const w = A.map((row, i) => row[size] / row[i]);
  return ([x, y]) => {
    let v = w[n] + w[n + 1] * x + w[n + 2] * y;
    for (let i = 0; i < n; i++) v += w[i] * U(Math.hypot(x - points[i][0], y - points[i][1]));
    return v;
  };
}
const scaled = (x, y) => [x / 1000, y / 1000];
const controlPoints = places.map((p) => scaled(p.x, p.y));
const toLon = thinPlate(controlPoints, places.map((p) => p.lon));
const toLat = thinPlate(controlPoints, places.map((p) => p.lat));
const place = (x, y) => [toLon(scaled(x, y)), toLat(scaled(x, y))];
const round = (v) => Math.round(v * 1e5) / 1e5;
const wkt = (coords) => coords.map(([lon, lat]) => `${round(lon)} ${round(lat)}`).join(", ");

// The bands as stretches: consecutive vertices of one number of men make
// one line, each stretch starting where the one before ends.
const HOW = {
  printed: "Printed on the chart",
  width: "Read from the band's width",
  difference: "Printed numbers' difference",
};
const stretches = [];
for (const band of trace.bands) {
  const v = band.vertices;
  let start = 0;
  for (let i = 1; i < v.length; i++) {
    const last = i === v.length - 1;
    if (last || v[i][2] !== v[start][2] || v[i][3] !== v[start][3]) {
      const coords = v.slice(start, i + 1).map(([x, y]) => place(x, y));
      stretches.push({ part: band.part, direction: band.direction, men: v[start][2], read: HOW[v[start][3]], order: stretches.length, coords });
      start = i;
    }
  }
}
// A temperature sits on the main retreat at the x Minard aligned it with.
const retreat = trace.bands.find((b) => b.part === "Main army" && b.direction === "Retreat").vertices;
const onRetreat = (x) => {
  for (let i = 0; i + 1 < retreat.length; i++) {
    const [xa, ya] = retreat[i];
    const [xb, yb] = retreat[i + 1];
    if ((x - xa) * (x - xb) <= 0) return ya + ((yb - ya) * (x - xa)) / (xb - xa || 1);
  }
  throw new Error(`No stretch of the retreat at x ${x}.`);
};
// Minard's scale on the ground: 1 mm on his chart for 10,000 men, and a
// millimetre of his chart (15.75 pixels of the scan at 400 dpi) is about
// 1.7 km where the chart is pinned to the map.
const METRES_PER_MAN = 1700 / 10000;
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const db = await engine();
try {
  // Each stretch as a band as wide as its men at Minard's own scale: one
  // millimetre for 10,000 men on his chart is about 1.7 km on the ground
  // here, so 422,000 men make a band about 72 km wide. Drawn in a metric
  // projection (ETRS89 LAEA) with flat ends, so the stretches meet edge to
  // edge and the band steps down where the men fall away, as on the chart.
  await db.run(`
    CREATE TABLE centrelines AS
    SELECT * FROM (VALUES ${stretches.map((s) => `(${literal(s.part)}, ${literal(s.direction)}, ${s.men}, ${literal(s.read)}, ${s.order}, ST_GeomFromText(${literal(`LINESTRING(${wkt(s.coords)})`)}))`).join(",\n")})
      AS t(part, direction, men, how_read, stretch, geom)`);
  await db.run(`
    CREATE TABLE army AS
    SELECT part, direction, men, how_read, stretch,
           ST_Transform(
             ST_Buffer(ST_Transform(geom, 'EPSG:4326', 'EPSG:3035', always_xy := true), men * ${METRES_PER_MAN} / 2, 8, 'CAP_FLAT', 'JOIN_MITRE', 3),
             'EPSG:3035', 'EPSG:4326', always_xy := true) AS geom
    FROM centrelines
    ORDER BY stretch`);
  await db.run(`
    CREATE TABLE places AS
    SELECT * FROM (VALUES ${places.map((p) => `(${literal(p.chart)}, ${literal(p.name)}, ${literal(p.wikidata)}, ST_Point(${p.lon}, ${p.lat}))`).join(",\n")})
      AS t(name_on_chart, name_today, wikidata, geom)`);
  await db.run(`
    CREATE TABLE temperatures AS
    SELECT * FROM (VALUES ${trace.temperatures.map((t) => {
      const [lon, lat] = place(t.x, onRetreat(t.x));
      const day = t.date ? `${Number(t.date.slice(8))} ${MONTH[Number(t.date.slice(5, 7)) - 1]}` : null;
      const label = `${t.reaumur === 0 ? "0" : `−${-t.reaumur}`}°`;
      return `(${t.date ? `DATE ${literal(t.date)}` : "CAST(NULL AS DATE)"}, ${literal(day ?? "no date printed")}, ${t.reaumur}, CAST(${t.reaumur * 1.25} AS DOUBLE), ${literal(label)}, ${literal(t.printed)}, ST_Point(${round(lon)}, ${round(lat)}))`;
    }).join(",\n")})
      AS t(date, day, degrees_reaumur, degrees_celsius, label, as_printed, geom)`);

  const outputs = {};
  for (const name of ["army", "places", "temperatures"]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    const [{ rows }] = await db.rows(`SELECT count(*)::INTEGER AS rows FROM ${name}`);
    outputs[name] = { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
  }

  const record = {
    template: "napoleons-march",
    builtAt: new Date().toISOString(),
    slice: { stretches: stretches.length, places: places.length, temperatures: trace.temperatures.length, traceSha256: sha256(await readFile(path.join(here, "trace.json"))) },
    sources: {
      scan: { page: SCAN_PAGE, ...(({ path: _p, ...rest }) => rest)(scan) },
      wikidata: places.map(({ wikidata, name, lon, lat, revision, fetched }) => ({ item: wikidata, name, lon, lat, revision, fetchedAt: fetched.fetchedAt, url: fetched.url, sha256: fetched.sha256 })),
    },
    userAgent: USER_AGENT,
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`army: ${stretches.length} stretches; places: ${places.length}; temperatures: ${trace.temperatures.length}\n`);
} finally {
  db.close();
}
