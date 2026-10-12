// Build "Which pump?": place our reading of John Snow's Map 1 (1855)
// (trace.json, beside this script) on the ground, and prepare the two
// datasets the workflow starts from: the deaths, one point per bar Snow
// drew, and the 13 pumps on his map.
//
//   node templates/which-pump/build.mjs [work folder]
//
// Fetches the Wellcome Collection's scan the reading was made on (to hold
// the reading to that exact image) and the catalogue record that marks it
// Public Domain, and the OpenStreetMap nodes of the street junctions the
// map is matched to. Fits one affine transform from the scan's pixels to
// the ground through those junctions (least squares; every residual goes
// into the build record), and checks the Broad Street pump against the
// red granite kerbstone that marks its site today. Writes
// <work>/which-pump/data/{deaths,pumps}.parquet and the build record.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { USER_AGENT, download, engine, literal, sha256 } from "../../tools/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] ?? path.join(here, "../../work"), "which-pump");
const trace = JSON.parse(await readFile(path.join(here, "trace.json"), "utf8"));

const CATALOGUE = "https://api.wellcomecollection.org/catalogue/v2/works/uqa27qrt?include=items";
// The kerbstone that marks the original pump's site, and the replica pump
// a few metres from it.
const KERBSTONE = 5776590973;
const REPLICA = 5718464949;

const downloads = path.join(work, "downloads");
const data = path.join(work, "data");
await rm(downloads, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });

const scan = await download(downloads, "snow-map-1", trace.scan.image, "map1.jpg");
if (scan.sha256 !== trace.scan.sha256) throw new Error(`The scan answered ${scan.sha256}; the reading was made on ${trace.scan.sha256}.`);

const catalogue = await download(downloads, "wellcome-work", CATALOGUE, "work.json");
const workRecord = JSON.parse(await readFile(catalogue.path, "utf8"));
const licences = workRecord.items.flatMap((item) => item.locations).map((l) => l.license?.id).filter(Boolean);
if (!licences.length || licences.some((id) => id !== "pdm")) throw new Error(`The Wellcome record's licences are ${licences.join(", ") || "none"}; the template needs the Public Domain Mark.`);

// The junctions' nodes, the kerbstone and the replica, as OpenStreetMap has them.
const controls = trace.controls.filter((c) => c.px);
const ids = [...new Set([...controls.flatMap((c) => c.osm), KERBSTONE, REPLICA])];
const osm = await download(downloads, "osm-nodes", `https://api.openstreetmap.org/api/0.6/nodes.json?nodes=${ids.join(",")}`, "nodes.json");
const nodes = new Map(JSON.parse(await readFile(osm.path, "utf8")).elements.map((n) => [n.id, n]));
for (const id of ids) if (!nodes.has(id)) throw new Error(`OpenStreetMap has no node ${id}.`);

// A local metric frame on the kerbstone: metres east and north.
const kerb = nodes.get(KERBSTONE);
const MX = 111320 * Math.cos((kerb.lat * Math.PI) / 180);
const MY = 110574;
const toMetres = (lon, lat) => [(lon - kerb.lon) * MX, (lat - kerb.lat) * MY];
const toDegrees = ([e, n]) => [kerb.lon + e / MX, kerb.lat + n / MY];
const ground = (c) => {
  const ns = c.osm.map((id) => nodes.get(id));
  return toMetres(ns.reduce((s, n) => s + n.lon, 0) / ns.length, ns.reduce((s, n) => s + n.lat, 0) / ns.length);
};

// Least squares: east and north each as a + b·x + c·y of the pixel (in
// thousands, for a well-conditioned system).
function fit(points) {
  const solve = (k) => {
    const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (const p of points) {
      const f = [1, p.px[0] / 1000, p.px[1] / 1000];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) A[i][j] += f[i] * f[j];
        A[i][3] += f[i] * p.ground[k];
      }
    }
    for (let c = 0; c < 3; c++) {
      let pivot = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
      [A[c], A[pivot]] = [A[pivot], A[c]];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const m = A[r][c] / A[c][c];
        for (let j = c; j < 4; j++) A[r][j] -= m * A[c][j];
      }
    }
    return A.map((row, i) => row[3] / row[i]);
  };
  const [e, n] = [solve(0), solve(1)];
  return ([x, y]) => [e[0] + (e[1] * x) / 1000 + (e[2] * y) / 1000, n[0] + (n[1] * x) / 1000 + (n[2] * y) / 1000];
}
const points = controls.map((c) => ({ name: c.today, px: c.px, ground: ground(c) }));
const place = fit(points);
const metres = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const residuals = points.map((p) => ({ junction: p.name, metres: Math.round(metres(place(p.px), p.ground) * 10) / 10 }));
const rms = (values) => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
const leaveOneOut = points.map((p, i) => metres(fit(points.filter((_, j) => j !== i))(p.px), p.ground));
const broad = trace.detected.pumps.find((p) => p.name === "Broad Street");
const broadOnGround = place([broad.x, broad.y]);
const check = {
  kerbstoneMetres: Math.round(metres(broadOnGround, [0, 0]) * 10) / 10,
  replicaMetres: Math.round(metres(broadOnGround, toMetres(nodes.get(REPLICA).lon, nodes.get(REPLICA).lat)) * 10) / 10,
};
const fitRecord = {
  method: "affine, least squares over the junctions",
  junctions: points.length,
  rmsMetres: Math.round(rms(residuals.map((r) => r.metres)) * 10) / 10,
  leaveOneOutRmsMetres: Math.round(rms(leaveOneOut) * 10) / 10,
  residuals,
  broadStreetPump: check,
};
if (fitRecord.rmsMetres > 8 || check.kerbstoneMetres > 10) throw new Error(`The fit is off: ${JSON.stringify(fitRecord)}`);

const round = (v) => Math.round(v * 1e6) / 1e6;
const lonLat = (x, y) => toDegrees(place([x, y])).map(round);
const bars = trace.detected.bars;
const perStack = new Map();
for (const [, , stack] of bars) perStack.set(stack, (perStack.get(stack) ?? 0) + 1);

const db = await engine();
try {
  await db.run(`
    CREATE TABLE deaths AS
    SELECT * FROM (VALUES ${bars.map(([x, y, stack], i) => {
      const [lon, lat] = lonLat(x, y);
      return `(${i + 1}, ${stack}, ${perStack.get(stack)}, ST_Point(${lon}, ${lat}))`;
    }).join(",\n")})
      AS t(death, stack, deaths_in_stack, geom)`);
  await db.run(`
    CREATE TABLE pumps AS
    SELECT * FROM (VALUES ${trace.detected.pumps.map((p) => {
      const [lon, lat] = lonLat(p.x, p.y);
      return `(${literal(p.name)}, ST_Point(${lon}, ${lat}))`;
    }).join(",\n")})
      AS t(pump, geom)`);

  const outputs = {};
  for (const name of ["deaths", "pumps"]) {
    const file = path.join(data, `${name}.parquet`);
    await db.run(`COPY ${name} TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    const [{ rows }] = await db.rows(`SELECT count(*)::INTEGER AS rows FROM ${name}`);
    outputs[name] = { file: path.relative(work, file), rows, sha256: sha256(await readFile(file)) };
  }

  const strip = ({ path: _p, ...rest }) => rest;
  const record = {
    template: "which-pump",
    builtAt: new Date().toISOString(),
    slice: { bars: bars.length, stacks: perStack.size, pumps: trace.detected.pumps.length, traceSha256: sha256(await readFile(path.join(here, "trace.json"))) },
    fit: fitRecord,
    sources: {
      scan: strip(scan),
      catalogue: { ...strip(catalogue), licences: [...new Set(licences)] },
      openStreetMap: {
        ...strip(osm),
        nodes: ids.map((id) => ({ id, lon: nodes.get(id).lon, lat: nodes.get(id).lat, version: nodes.get(id).version, timestamp: nodes.get(id).timestamp })),
      },
    },
    userAgent: USER_AGENT,
    outputs,
  };
  await writeFile(path.join(work, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`deaths: ${bars.length} in ${perStack.size} stacks; pumps: ${trace.detected.pumps.length}; fit rms ${fitRecord.rmsMetres} m over ${points.length} junctions; Broad Street pump ${check.kerbstoneMetres} m from the kerbstone\n`);
} finally {
  db.close();
}
