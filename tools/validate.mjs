// Validate a release through a second scratch instance, the product's own
// admission being the gate: write the folder catalogue the instance reads
// (DEZFIL_TEMPLATES_CATALOGUE names it), then through the API: the list
// shows each template, the read of one answers, the download is admitted,
// the template's map opens read-only and draws, a copy lands, and the
// copy's layers draw what the template's do.
//
//   node tools/validate.mjs <validation instance> <dist folder> <catalogue folder>
//
// The catalogue folder must be the one the instance was started with, and
// empty or missing: validation writes it. Exits non-zero on any failure and
// prints what it checked.

import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { connect, ApiError } from "./client.mjs";

export async function writeCatalogue(dist, folder) {
  await mkdir(folder, { recursive: true });
  if ((await readdir(folder)).length) throw new Error(`${folder} is not empty; validation writes a fresh catalogue.`);
  const index = JSON.parse(await readFile(path.join(dist, "index.json"), "utf8"));
  const files = ["index.json", ...index.templates.flatMap((t) => [t.archive, t.pictures.light, t.pictures.dark])];
  for (const file of files) await copyFile(path.join(dist, file), path.join(folder, file));
  return index;
}

async function draws(api, layerId) {
  const render = await api.get(`/api/layers/${layerId}/render`);
  if (!render.ok) throw new Error(`Layer ${layerId} answered a render that is not ok: ${JSON.stringify(render).slice(0, 200)}`);
  return { mode: render.mode, features: render.featureCount, geometry: render.geometryType };
}

export async function validate(base, dist, folder) {
  const index = await writeCatalogue(dist, folder);
  const api = await connect(base);
  const report = { instance: api.origin, templates: [] };

  const refreshed = await api.post("/api/templates/refresh", {});
  report.catalogue = refreshed.catalogue ?? refreshed;
  if (report.catalogue.state !== "listed") throw new Error(`The catalogue reads as ${report.catalogue.state}: ${JSON.stringify(report.catalogue)}`);

  for (const entry of index.templates) {
    const { id, version } = entry.facts;
    const checks = { id, version };
    report.templates.push(checks);

    // The list shows it.
    const list = await api.get("/api/templates");
    const card = (list.templates ?? list).find((t) => t.id === id);
    if (!card) throw new Error(`The list does not show ${id}.`);
    if (card.listed !== version) throw new Error(`The list shows ${id} at version ${card.listed}, not ${version}.`);
    checks.listed = { origin: card.origin, listed: card.listed, size: card.size, picture: card.picture, title: card.title };

    // The read of one answers, and its pictures are the release's.
    const before = await api.get(`/api/templates/${id}`);
    checks.readBeforeFetch = { title: before.title, contents: before.contents };
    for (const theme of ["light", "dark"]) {
      const served = Buffer.from(await (await api.raw("GET", `/api/templates/${id}/picture?theme=${theme}`)).arrayBuffer());
      const ours = await readFile(path.join(dist, entry.pictures[theme]));
      if (!served.equals(ours)) throw new Error(`The ${theme} picture served for ${id} is not the release's.`);
    }
    checks.pictures = "served as released";

    // The product's admission: the download is unpacked and admitted whole.
    const fetched = await api.post(`/api/templates/${id}/fetch`, { version });
    checks.fetched = fetched;
    const read = await api.get(`/api/templates/${id}?version=${version}`);
    if (!read.contents?.mapId) throw new Error(`${id} read after its download names no map.`);
    checks.contents = { mapId: read.contents.mapId, datasets: read.contents.datasets, workflow: read.contents.workflow ? read.contents.workflow.steps?.length ?? true : null };

    // The template's map opens read-only, and every layer draws.
    const map = await api.get(`/api/maps/${read.contents.mapId}`);
    checks.map = { name: map.name, owner: map.owner, layers: {}, widgets: map.widgets.map((w) => w.type) };
    for (const layer of map.layers) checks.map.layers[layer.name] = await draws(api, layer.id);
    try {
      await api.patch(`/api/maps/${map.id}`, { name: "changed" }, map.editRevision ? { "x-edit-revision": map.editRevision } : {});
      throw new Error(`${id}'s map took a write.`);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      checks.map.writeRefused = `${error.status} ${error.code}`;
    }
    const values = await api.post(`/api/maps/${map.id}/widget-values`, {});
    checks.map.widgetValues = values.widgets.map((w) => ({ id: w.id, type: w.type, ...(w.value !== undefined ? { value: w.value } : {}), ...(w.categories ? { categories: w.categories.length } : {}), ...(w.bins ? { bins: w.bins.length } : {}) }));

    // A copy lands, and its layers draw what the template's do.
    const copy = await api.post(`/api/templates/${id}/copy`, { version });
    const copiedMap = copy.members.maps?.[0] ?? (await api.get(`/api/projects/${copy.project.id}/members`)).maps[0];
    const copied = await api.get(`/api/maps/${copiedMap.id}`);
    checks.copy = { project: copy.project.name, note: copy.project.note, map: copied.name, owner: copied.owner, layers: {}, datasets: [] };
    for (const layer of copied.layers) {
      checks.copy.layers[layer.name] = await draws(api, layer.id);
      if (checks.copy.layers[layer.name].features !== checks.map.layers[layer.name]?.features) {
        throw new Error(`The copy's ${layer.name} draws ${checks.copy.layers[layer.name].features} features; the template's draws ${checks.map.layers[layer.name]?.features}.`);
      }
    }
    const tables = (await api.get(`/api/projects/${copy.project.id}/members`)).tables;
    for (const table of tables) checks.copy.datasets.push({ name: table.name, rows: table.rowCount, source: table.source });
    const copiedValues = await api.post(`/api/maps/${copied.id}/widget-values`, {});
    checks.copy.widgetValues = copiedValues.widgets.filter((w) => w.value !== undefined).map((w) => ({ id: w.id, value: w.value }));
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base, dist, folder] = process.argv.slice(2);
  if (!folder) throw new Error("Usage: node tools/validate.mjs <validation instance> <dist folder> <catalogue folder>");
  try {
    console.log(JSON.stringify(await validate(base, path.resolve(dist), path.resolve(folder)), null, 2));
  } catch (error) {
    console.error(`VALIDATION FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
