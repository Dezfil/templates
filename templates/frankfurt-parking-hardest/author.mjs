// Author "Where is parking hardest in Frankfurt?" on a scratch Dezfil
// through its documented API: the project, both datasets, the workflow
// with its six steps and canvas, one whole run, and the result map with
// its layers, widgets and the credit note.
//
//   node templates/frankfurt-parking-hardest/author.mjs http://127.0.0.1:3761 [work folder]
//
// Reads the build's output and writes <work>/frankfurt-parking-hardest/
// authored.json: the project, workflow, map and layer ids, and the
// results pack bundles (one dataset per step, named by the step).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";
import { addStep, createWorkflow, runWorkflow, setLayout } from "../../tools/workflow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3761");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "frankfurt-parking-hardest");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [trips, supply] = facts.sources;

// H3 resolution 10, cells about 150 m across (a street block or two), and
// a neighbourhood of two rings around each, about 300 m: fine enough that
// the map stays at street level, wide enough that a cell is compared with
// the streets a driver circles. Resolution 9 scored 29 cells; this 86.
const RESOLUTION = 10;
const NEIGHBOURS = 2;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// The usual hot spot reading of Gi*: confidence from the z-score.
const SIGNIFICANCE = {
  "Hot spot, 99% confidence": rgb("#C8102E"),
  "Hot spot, 95% confidence": rgb("#F2542D"),
  "Hot spot, 90% confidence": rgb("#F5A25D"),
  "Not significant": rgb("#A7AFBC", 0.4),
  "Cold spot, 90% confidence": rgb("#8DB8E0"),
  "Cold spot, 95% confidence": rgb("#4F8BD9"),
  "Cold spot, 99% confidence": rgb("#2B5BB5"),
};

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["search_points", "parking_spaces"]) {
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
await step("searchCells", "h3_cell", { input: "search_points", resolution: RESOLUTION, boundary: false, name: "search_cells" });
await step("searchMinutes", "group_summarize", {
  input: "search_cells",
  group_by: ["h3_cell"],
  aggregates: [{ aggregate: "sum", field: "search_minutes" }, { aggregate: "count" }],
  name: "search_minutes_per_cell",
});
await step("spaceCells", "h3_cell", { input: "parking_spaces", resolution: RESOLUTION, boundary: false, name: "space_cells" });
await step("spaces", "group_summarize", {
  input: "space_cells",
  group_by: ["h3_cell"],
  aggregates: [{ aggregate: "count" }],
  name: "spaces_per_cell",
});
await step("perSpace", "sql_step", {
  sql: [
    "SELECT s.h3_cell,",
    "       round(s.sum_search_minutes, 2) AS search_minutes,",
    "       p.feature_count AS spaces,",
    "       s.sum_search_minutes / p.feature_count AS minutes_per_space,",
    "       ST_Point(h3_cell_to_lng(s.h3_cell), h3_cell_to_lat(s.h3_cell)) AS geom",
    "FROM search_minutes_per_cell AS s",
    "JOIN spaces_per_cell AS p ON p.h3_cell = s.h3_cell",
    "WHERE s.sum_search_minutes > 0",
  ].join("\n"),
  name: "search_per_space",
});
await step("hotspots", "hotspot", {
  input: "search_per_space",
  resolution: RESOLUTION,
  value: "sum",
  field: "minutes_per_space",
  neighbours: NEIGHBOURS,
  name: "parking_hotspots",
});

await setLayout(api, workflow.id, {
  sources: { search_points: { x: 20, y: 40 }, parking_spaces: { x: 20, y: 300 } },
  steps: {
    [steps.searchCells.id]: { x: 300, y: 40 },
    [steps.searchMinutes.id]: { x: 580, y: 40 },
    [steps.spaceCells.id]: { x: 300, y: 300 },
    [steps.spaces.id]: { x: 580, y: 300 },
    [steps.perSpace.id]: { x: 860, y: 170 },
    [steps.hotspots.id]: { x: 1140, y: 170 },
  },
  notes: [
    {
      id: "note-question",
      x: 860, y: 380, w: 300, h: 150, color: "yellow",
      text:
        "Searching is measured in minutes: each waypoint the app marked as searching counts the time until the next one. " +
        "Dividing by the parking spaces in the same cell asks where the hunt is long for the supply there.",
    },
    {
      id: "note-reading",
      x: 1140, y: 380, w: 300, h: 150, color: "blue",
      text:
        "Gi* compares each cell and the cells within two rings of it with every searched cell. " +
        "A z-score above 1.65, 1.96 or 2.58 marks a hot spot at 90, 95 or 99% confidence.",
    },
  ],
});

const run = await runWorkflow(api, workflow.id);

// The result map: the hot spots over the searching and the supply.
const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

const spaces = await addLayer({ name: "Parking spaces", sql: "SELECT geom FROM parking_spaces" });
await patchLayer(spaces.id, {
  style: { ...spaces.style, fill: { type: "constant", color: rgb("#7F8FA6") }, fillOpacity: 0.45, strokeWidth: 0, pointRadius: 0.8 },
  tooltip: [],
  legendTitle: "One parking space",
});

const hotspots = await addLayer({
  name: "Where parking is hardest (Gi*)",
  sql: [
    "SELECT round(gi_star, 2) AS gi_star,",
    "       CASE",
    "         WHEN gi_star >= 2.58 THEN 'Hot spot, 99% confidence'",
    "         WHEN gi_star >= 1.96 THEN 'Hot spot, 95% confidence'",
    "         WHEN gi_star >= 1.65 THEN 'Hot spot, 90% confidence'",
    "         WHEN gi_star <= -2.58 THEN 'Cold spot, 99% confidence'",
    "         WHEN gi_star <= -1.96 THEN 'Cold spot, 95% confidence'",
    "         WHEN gi_star <= -1.65 THEN 'Cold spot, 90% confidence'",
    "         ELSE 'Not significant'",
    "       END AS significance,",
    "       round(value * 100, 1) AS search_minutes_per_100_spaces,",
    "       neighbour_count,",
    "       geom",
    "FROM parking_hotspots",
    "WHERE gi_star IS NOT NULL",
    "ORDER BY abs(gi_star)",
  ].join("\n"),
});
const significance = await api.post(`/api/layers/${hotspots.id}/fill`, { attribute: "significance", method: "categorical", palette: "bold" });
await patchLayer(hotspots.id, {
  style: {
    ...hotspots.style,
    fill: { ...significance, map: Object.entries(SIGNIFICANCE).map(([value, color]) => ({ value, color })) },
    fillOpacity: 0.7,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0.8,
    strokeOpacity: 0.5,
  },
  tooltip: ["significance", "gi_star", "search_minutes_per_100_spaces", "neighbour_count"],
  legendTitle: "Where parking is hardest",
});

const searching = await addLayer({ name: "Searching for parking", sql: "SELECT trip, time, round(search_minutes, 2) AS search_minutes, geom FROM search_points" });
await patchLayer(searching.id, {
  style: {
    ...searching.style,
    fill: { type: "constant", color: rgb("#1D1F24") },
    fillOpacity: 0.85,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0.6,
    strokeOpacity: 0.9,
    pointRadius: 2.2,
  },
  tooltip: ["trip", "time", "search_minutes"],
  legendTitle: "A waypoint while searching",
});

const widget = (id, type, title, layerId, more) => ({
  id, type, layerId, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: 8.6795, lat: 50.1195, zoom: 14.15, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [hotspots.id, searching.id, spaces.id],
  layerOrder: [spaces.id, hotspots.id, searching.id],
  widgets: [
    widget("widget-cells", "category", "Searched cells", hotspots.id, { field: "significance" }),
    widget("widget-minutes", "formula", "Searching", searching.id, {
      field: "search_minutes", agg: "sum", format: "integer", unit: "min", note: "On the trips that end in Frankfurt",
    }),
    widget("widget-sources", "note", "Sources", null, {
      note: creditNote(facts, {
        [trips.name]:
          "The searching waypoints of the start2park Park-and-Visit trips that end in Frankfurt. " +
          "[github.com/ReLUT/parking-search-prediction](https://github.com/ReLUT/parking-search-prediction)",
        [supply.name]:
          "Processed from OpenStreetMap with the OSM Parkraum processing; " +
          "[mobilithek.info, offer 886571101635461120](https://mobilithek.info/offers/886571101635461120)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const results = {
  [steps.searchCells.id]: "search_cells",
  [steps.searchMinutes.id]: "search_minutes_per_cell",
  [steps.spaceCells.id]: "space_cells",
  [steps.spaces.id]: "spaces_per_cell",
  [steps.perSpace.id]: "search_per_space",
  [steps.hotspots.id]: "parking_hotspots",
};
const authored = {
  base: api.origin,
  projectId: project.id,
  workflowId: workflow.id,
  runId: run.id,
  mapId: map.id,
  layers: { spaces: spaces.id, hotspots: hotspots.id, searching: searching.id },
  steps: Object.fromEntries(Object.entries(steps).map(([key, s]) => [key, s.id])),
  results,
  // The SQL step's reads, which its query names; the other steps read
  // their named inputs.
  reads: { [steps.perSpace.id]: ["search_minutes_per_cell", "spaces_per_cell"] },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, workflow ${workflow.id} (run ${run.id}), map ${map.id}\n`);
