// Author "Which pump?" on a scratch Dezfil through its documented API: the
// project, both datasets, the workflow with its seven steps and canvas,
// one whole run, and the result map with its layers, widgets and the
// credit note.
//
//   node templates/which-pump/author.mjs http://127.0.0.1:3761 [work folder]
//
// Reads the build's output and writes <work>/which-pump/authored.json: the
// project, workflow, map and layer ids, and the results pack bundles (one
// dataset per step, named by the step).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";
import { addStep, createWorkflow, runWorkflow, setCanvas } from "../../tools/workflow.mjs";
import canvas from "./canvas.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3761");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "which-pump");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [snow, osm] = facts.sources;

// About a minute's walk: the ring the question is asked with.
const RING_METRES = 100;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// Broad Street in red; every other pump in a quieter colour of its own.
const PUMP_COLOURS = {
  "Broad Street": "#C8102E",
  "Little Marlborough Street": "#3E7CB1",
  "Upper Rupert Street": "#4E9A6F",
  "Brewer Street": "#D9A21B",
  "Newman Street": "#8E6BB8",
  "Warwick Street": "#3FA7A0",
  "Oxford Street at Berners Street": "#B8794A",
  "Vigo Street": "#7F8FA6",
  "Marlborough Mews": "#9AA544",
  "Tichborne Street": "#C9759B",
  "Castle Street East": "#6A8CC2",
  "King Street": "#8C8C8C",
  "Oxford Market": "#6E6E6E",
};

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["deaths", "pumps"]) {
  const table = await api.upload(`${name}.parquet`, await readFile(path.join(work, record.outputs[name].file)), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

// The workflow, in the order its card draws it.
const workflow = await createWorkflow(api, project.id, facts.title);
const steps = {};
const step = async (key, operation, parameters) => {
  steps[key] = await addStep(api, workflow.id, operation, parameters);
  return steps[key];
};
await step("nearest", "nearest_join", { left: "deaths", right: "pumps", carry: ["pump"], name: "deaths_nearest_pump" });
await step("perPump", "group_summarize", {
  input: "deaths_nearest_pump",
  group_by: ["pump"],
  aggregates: [{ aggregate: "count" }, { aggregate: "mean", field: "nearest_distance_m" }],
  name: "deaths_per_pump",
});
await step("pumpsCounted", "join_by_key", {
  left: "pumps",
  right: "deaths_per_pump",
  left_key: "pump",
  right_key: "pump",
  carry: ["feature_count"],
  name: "pumps_with_deaths",
});
await step("broad", "filter_rows", { input: "pumps", field: "pump", comparison: "equals", value: "Broad Street", name: "broad_street_pump" });
await step("ring", "buffer", { input: "broad_street_pump", distance: RING_METRES, name: "within_100_m" });
await step("inRing", "filter_by_location", { input: "deaths", mask: "within_100_m", relation: "within", name: "deaths_within_100_m" });
await step("share", "sql_step", {
  sql: [
    "SELECT (SELECT count(*) FROM deaths_within_100_m) AS deaths_within_100_m,",
    "       (SELECT count(*) FROM deaths) AS deaths_on_the_map,",
    "       round(100.0 * (SELECT count(*) FROM deaths_within_100_m) / (SELECT count(*) FROM deaths), 1) AS share_percent,",
    "       r.geom",
    "FROM within_100_m AS r",
  ].join("\n"),
  name: "share_within_100_m",
});

// The canvas in sections, as canvas.mjs lays it out.
await setCanvas(api, workflow.id, canvas(facts));

const run = await runWorkflow(api, workflow.id);

// The result map: the deaths coloured by their nearest pump, the pumps
// with their counts, and the ring around Broad Street.
const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

const ring = await addLayer({ name: "Within 100 m of the Broad Street pump", sql: "SELECT deaths_within_100_m, deaths_on_the_map, share_percent, geom FROM share_within_100_m" });
await patchLayer(ring.id, {
  style: { ...ring.style, fill: { type: "constant", color: rgb("#C8102E") }, fillOpacity: 0.08, stroke: rgb("#C8102E"), strokeWidth: 1.6, strokeOpacity: 0.9 },
  tooltip: ["share_percent", "deaths_within_100_m", "deaths_on_the_map"],
  legendTitle: "Within 100 m of the Broad Street pump",
});

const deaths = await addLayer({
  name: "Deaths, by nearest pump",
  sql: "SELECT death, pump AS nearest_pump, round(nearest_distance_m) AS metres_to_it, deaths_in_stack, geom FROM deaths_nearest_pump ORDER BY pump = 'Broad Street', death",
});
const nearest = await api.post(`/api/layers/${deaths.id}/fill`, { attribute: "nearest_pump", method: "categorical", palette: "bold" });
await patchLayer(deaths.id, {
  style: {
    ...deaths.style,
    fill: { ...nearest, map: Object.entries(PUMP_COLOURS).map(([value, hex]) => ({ value, color: rgb(hex) })) },
    fillOpacity: 0.9,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0.5,
    strokeOpacity: 0.8,
    pointRadius: 2.6,
  },
  tooltip: ["nearest_pump", "metres_to_it", "deaths_in_stack"],
  legendTitle: "A death, by its nearest pump",
});

const pumps = await addLayer({
  name: "Pumps",
  sql: "SELECT pump, coalesce(feature_count, 0) AS deaths_nearest, geom FROM pumps_with_deaths",
});
await patchLayer(pumps.id, {
  style: {
    ...pumps.style,
    fill: { type: "constant", color: rgb("#1D1F24") },
    fillOpacity: 1,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 1.6,
    strokeOpacity: 1,
    pointRadius: 5,
    // The name to the right of its pump, clear of the dot.
    label: { attribute: "pump", size: 12, color: rgb("#1D1F24"), haloWidth: 1, haloColor: rgb("#FFFFFF", 0.92), weight: "bold", anchor: "right", offsetX: 8, density: 1 },
  },
  tooltip: ["pump", "deaths_nearest"],
  legendTitle: "A pump on Snow's map",
});

const widget = (id, type, title, layerId, more) => ({
  id, type, layerId, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: -0.1362, lat: 51.5133, zoom: 15.6, pitch: 0, bearing: 0 },
  // Light in either theme, like Snow's paper: the pumps' dark names need it.
  basemap: "light",
  legendCorner: "bottom-left",
  legendOrder: [deaths.id, pumps.id, ring.id],
  layerOrder: [ring.id, deaths.id, pumps.id],
  widgets: [
    widget("widget-deaths", "formula", "Deaths on Snow's map", deaths.id, { format: "integer", note: "One for each bar he drew" }),
    widget("widget-share", "formula", "Within 100 m of the Broad Street pump", ring.id, {
      field: "share_percent", agg: "max", format: "decimal1", unit: "%", note: "Of all the deaths; a straight 100 m is about a minute's walk",
    }),
    widget("widget-nearest", "category", "Nearest pump", deaths.id, { field: "nearest_pump" }),
    widget("widget-story", "note", "Snow's map", null, {
      note:
        "Cholera killed more than 500 people in these streets in ten days from 31 August 1854. " +
        "John Snow, who held that cholera spread in water rather than in bad air, drew a black bar for each death at its house, and marked the street pumps the households drew their water from. " +
        "On his evidence the parish removed the handle of the Broad Street pump on 8 September 1854.",
    }),
    widget("widget-sources", "note", "Sources", null, {
      note: creditNote(facts, {
        [snow.name]:
          `Our reading: ${record.slice.bars} bars in ${record.slice.stacks} stacks and ${record.slice.pumps} pumps. ` +
          "[Wellcome Collection, b28985266](https://wellcomecollection.org/works/uqa27qrt)",
        [osm.name]: `The ${record.fit.junctions} street junctions that place the map on the ground. [openstreetmap.org/copyright](https://www.openstreetmap.org/copyright)`,
      }),
    }),
  ],
  widgetsPublished: true,
});

const results = {
  [steps.nearest.id]: "deaths_nearest_pump",
  [steps.perPump.id]: "deaths_per_pump",
  [steps.pumpsCounted.id]: "pumps_with_deaths",
  [steps.broad.id]: "broad_street_pump",
  [steps.ring.id]: "within_100_m",
  [steps.inRing.id]: "deaths_within_100_m",
  [steps.share.id]: "share_within_100_m",
};
const authored = {
  base: api.origin,
  projectId: project.id,
  workflowId: workflow.id,
  runId: run.id,
  mapId: map.id,
  layers: { ring: ring.id, deaths: deaths.id, pumps: pumps.id },
  steps: Object.fromEntries(Object.entries(steps).map(([key, s]) => [key, s.id])),
  results,
  // The SQL step's reads, which its query names; the other steps read
  // their named inputs.
  reads: { [steps.share.id]: ["deaths_within_100_m", "deaths", "within_100_m"] },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, workflow ${workflow.id} (run ${run.id}), map ${map.id}\n`);
