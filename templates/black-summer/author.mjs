// Author "Black Summer fires" on a scratch Dezfil through its documented
// API: the project, the two datasets, the workflow with its steps and
// canvas, one whole run, and the result map with its layers, timeline,
// widgets and the credit note.
//
//   node templates/black-summer/author.mjs http://127.0.0.1:3821 [work folder]
//
// Reads the build's output and writes <work>/black-summer/authored.json:
// the project, workflow, map and layer ids, and the results pack bundles
// (one dataset per step, named by the step).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";
import { addStep, createWorkflow, runWorkflow, setCanvas } from "../../tools/workflow.mjs";
import canvas from "./canvas.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3821");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "black-summer");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [firms, naturalEarth] = facts.sources;

// Detections FIRMS rates 80 or more out of 100.
const CONFIDENT_ABOVE = 79;
// H3 resolution 6: cells of about 36 km², whose middles stand about 6.5 km
// from their neighbours' and 11 km or more from the next ring's; 9 km joins
// neighbouring cells and no further.
const CELL_RESOLUTION = 6;
const NEIGHBOURS_METRES = 9000;
// The timeline's window opens on the week of New Year's Eve 2019.
const WINDOW = ["2019-12-28", "2020-01-04"];

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
const SIZE = {
  "Under 10 km²": rgb("#FED976"),
  "10 to 100 km²": rgb("#FD8D3C"),
  "100 to 1,000 km²": rgb("#E31A1C"),
  "1,000 km² or more": rgb("#99000D"),
};

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["fire_detections", "states"]) {
  const file = path.join(work, record.outputs[name].file);
  const table = await api.upload(`${name}.parquet`, await readFile(file), project.id);
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
await step("confident", "filter_rows", {
  input: "fire_detections", field: "confidence", comparison: "greater_than", value: String(CONFIDENT_ABOVE), name: "confident_detections",
});
await step("cells", "h3_cell", { input: "confident_detections", resolution: CELL_RESOLUTION, boundary: false, name: "detections_in_cells" });
await step("perCell", "group_summarize", {
  input: "detections_in_cells",
  group_by: ["h3_cell"],
  aggregates: [{ aggregate: "count" }, { aggregate: "sum", field: "frp" }],
  name: "burning_cells",
});
await step("cellPoints", "sql_step", {
  sql: [
    "SELECT h3_cell,",
    "       feature_count AS detections,",
    "       sum_frp,",
    "       ST_Point(h3_cell_to_lng(h3_cell), h3_cell_to_lat(h3_cell)) AS geom",
    "FROM burning_cells",
  ].join("\n"),
  name: "burning_cell_middles",
});
await step("cluster", "cluster_by_distance", { input: "burning_cell_middles", distance: NEIGHBOURS_METRES, name: "cells_by_fire" });
await step("byFire", "join_by_key", {
  left: "detections_in_cells",
  right: "cells_by_fire",
  left_key: "h3_cell",
  right_key: "h3_cell",
  carry: ["cluster_id"],
  name: "detections_by_fire",
});
await step("hulls", "convex_hull", { input: "detections_by_fire", group_by: ["cluster_id"], name: "fire_hulls" });
await step("land", "clip", { input: "fire_hulls", clip: "states", name: "fire_outlines" });
await step("area", "measure_columns", { input: "fire_outlines", measures: ["area"], name: "fire_areas" });
await step("power", "group_summarize", {
  input: "detections_by_fire",
  group_by: ["cluster_id"],
  aggregates: [{ aggregate: "sum", field: "frp" }, { aggregate: "max", field: "frp" }],
  name: "fire_power",
});
await step("fires", "join_by_key", {
  left: "fire_areas",
  right: "fire_power",
  left_key: "cluster_id",
  right_key: "cluster_id",
  carry: ["sum_frp", "max_frp"],
  name: "fires",
});

// The canvas in sections, as canvas.mjs lays it out.
await setCanvas(api, workflow.id, canvas(facts));

const run = await runWorkflow(api, workflow.id);

// The result map.
const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

const fires = await addLayer({
  name: "Fires, the season's outlines",
  sql: [
    "SELECT round(area_m2 / 1e6, 1) AS area_km2,",
    "       feature_count AS detections,",
    "       round(sum_frp) AS fire_radiative_power_mw,",
    "       CASE WHEN area_m2 < 1e7 THEN 'Under 10 km²'",
    "            WHEN area_m2 < 1e8 THEN '10 to 100 km²'",
    "            WHEN area_m2 < 1e9 THEN '100 to 1,000 km²'",
    "            ELSE '1,000 km² or more' END AS size,",
    "       CASE WHEN area_m2 >= 1e9 THEN format('{:,} km²', CAST(round(area_m2 / 1e6) AS BIGINT)) END AS label,",
    "       geom",
    "FROM fires",
  ].join("\n"),
});
const sizePaint = await api.post(`/api/layers/${fires.id}/fill`, { attribute: "size", method: "categorical", palette: "bold" });
await patchLayer(fires.id, {
  style: {
    ...fires.style,
    fill: { ...sizePaint, map: Object.entries(SIZE).map(([value, color]) => ({ value, color })) },
    fillOpacity: 0.3,
    stroke: rgb("#99000D"),
    strokeWidth: 1,
    strokeOpacity: 0.9,
    pointRadius: 2,
    label: {
      attribute: "label",
      size: 12,
      color: rgb("#FFFFFF"),
      haloWidth: 1,
      haloColor: rgb("#1D1F24"),
      weight: "bold",
      priorityField: "area_km2",
    },
  },
  tooltip: ["size", "area_km2", "detections", "fire_radiative_power_mw"],
  legendTitle: "Fires over the season, by the area of their outline",
});

const detections = await addLayer({ name: "Fire detections", sql: "SELECT acq_date, frp, geom FROM confident_detections" });
await patchLayer(detections.id, {
  viz: { type: "heatmap", radiusPx: 18, intensity: 1, weight: "frp" },
  filters: [{ field: "acq_date", kind: "timerange", min: WINDOW[0], max: WINDOW[1] }],
  legendTitle: "Fire detections in the timeline's window, weighted by fire radiative power",
});

const widget = (id, type, title, layerId, more) => ({
  id, type, layerId, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: 149.6, lat: -33.2, zoom: 5.6, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  layerOrder: [detections.id, fires.id],
  legendOrder: [fires.id, detections.id],
  timeline: { layerId: detections.id, field: "acq_date", speed: 1 },
  widgets: [
    widget("widget-detections", "formula", "Detections in the window", detections.id, { format: "integer", note: "Confidence 80 or more" }),
    widget("widget-fires", "category", "Fires by size", fires.id, { field: "size" }),
    widget("widget-largest", "formula", "The largest outline", fires.id, { field: "area_km2", agg: "max", format: "integer", unit: "km²" }),
    widget("widget-sources", "note", "Sources", null, {
      note: creditNote(facts, {
        [firms.name]: "[firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/country/), the yearly country files.",
        [naturalEarth.name]: "[naturalearthdata.com](https://www.naturalearthdata.com)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const results = {
  [steps.confident.id]: "confident_detections",
  [steps.cells.id]: "detections_in_cells",
  [steps.perCell.id]: "burning_cells",
  [steps.cellPoints.id]: "burning_cell_middles",
  [steps.cluster.id]: "cells_by_fire",
  [steps.byFire.id]: "detections_by_fire",
  [steps.hulls.id]: "fire_hulls",
  [steps.land.id]: "fire_outlines",
  [steps.area.id]: "fire_areas",
  [steps.power.id]: "fire_power",
  [steps.fires.id]: "fires",
};
const authored = {
  base: api.origin,
  projectId: project.id,
  workflowId: workflow.id,
  runId: run.id,
  mapId: map.id,
  layers: { fires: fires.id, detections: detections.id },
  steps: Object.fromEntries(Object.entries(steps).map(([key, s]) => [key, s.id])),
  results,
  // The SQL step's reads, which its query names; the other steps read
  // their named inputs.
  reads: {
    [steps.cellPoints.id]: ["burning_cells"],
  },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, workflow ${workflow.id} (run ${run.id}), map ${map.id}\n`);
