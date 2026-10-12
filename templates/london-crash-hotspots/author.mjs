// Author "London's crash hotspots" on a scratch Dezfil through its
// documented API: the project, the collisions, the workflow with its five
// steps and canvas, one whole run, and the result map with its layers,
// widgets and the credit note.
//
//   node templates/london-crash-hotspots/author.mjs http://127.0.0.1:3811 [work folder]
//
// Reads the build's output and writes <work>/london-crash-hotspots/
// authored.json: the project, workflow, map and layer ids, and the results
// pack bundles (one dataset per step, named by the step).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";
import { addStep, createWorkflow, runWorkflow, setLayout } from "../../tools/workflow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3811");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "london-crash-hotspots");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [dft] = facts.sources;

// H3 resolution 9, cells about 350 m across (a few street blocks), with a
// neighbourhood of one ring, about a kilometre: fine enough to point at a
// junction or a high street, wide enough that a cell is compared with the
// streets around it. Resolution 8 (900 m cells) blurred the West End into
// two or three cells.
const RESOLUTION = 9;
const NEIGHBOURS = 1;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// The usual hot spot reading of Gi*: confidence from the z-score.
const SIGNIFICANCE = {
  "Hot spot, 99% confidence": rgb("#C8102E"),
  "Hot spot, 95% confidence": rgb("#F2542D"),
  "Hot spot, 90% confidence": rgb("#F5A25D"),
  "Not significant": rgb("#A7AFBC", 0.3),
  "Cold spot, 90% confidence": rgb("#8DB8E0"),
  "Cold spot, 95% confidence": rgb("#4F8BD9"),
  "Cold spot, 99% confidence": rgb("#2B5BB5"),
};

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
{
  const file = path.join(work, record.outputs.collisions.file);
  const table = await api.upload("collisions.parquet", await readFile(file), project.id);
  if (table.name !== "collisions" || table.rowCount !== record.outputs.collisions.rows) {
    throw new Error(`collisions landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs.collisions.rows}.`);
  }
}

// The workflow, in the order its card draws it.
const workflow = await createWorkflow(api, project.id, facts.title);
const steps = {};
const step = async (key, operation, parameters) => {
  steps[key] = await addStep(api, workflow.id, operation, parameters);
  return steps[key];
};
await step("cells", "h3_cell", { input: "collisions", resolution: RESOLUTION, boundary: false, name: "collision_cells" });
await step("serious", "filter_rows", {
  input: "collision_cells",
  field: "severity",
  comparison: "not_equals",
  value: "Slight",
  name: "serious_collisions",
});
await step("perCell", "group_summarize", {
  input: "serious_collisions",
  group_by: ["h3_cell"],
  aggregates: [{ aggregate: "count" }],
  name: "serious_per_cell",
});
await step("everyCell", "sql_step", {
  sql: [
    "SELECT c.h3_cell,",
    "       count(*) AS collisions,",
    "       coalesce(any_value(s.feature_count), 0) AS serious_or_fatal,",
    "       ST_Point(h3_cell_to_lng(c.h3_cell), h3_cell_to_lat(c.h3_cell)) AS geom",
    "FROM collision_cells AS c",
    "LEFT JOIN serious_per_cell AS s ON s.h3_cell = c.h3_cell",
    "GROUP BY c.h3_cell",
  ].join("\n"),
  name: "serious_by_cell",
});
await step("hotspots", "hotspot", {
  input: "serious_by_cell",
  resolution: RESOLUTION,
  value: "sum",
  field: "serious_or_fatal",
  neighbours: NEIGHBOURS,
  name: "crash_hotspots",
});

await setLayout(api, workflow.id, {
  sources: { collisions: { x: 20, y: 120 } },
  steps: {
    [steps.cells.id]: { x: 300, y: 120 },
    [steps.serious.id]: { x: 580, y: 40 },
    [steps.perCell.id]: { x: 860, y: 40 },
    [steps.everyCell.id]: { x: 1140, y: 120 },
    [steps.hotspots.id]: { x: 1420, y: 120 },
  },
  notes: [
    {
      id: "note-zeros",
      x: 860, y: 260, w: 300, h: 150, color: "yellow",
      text:
        "Every cell where anyone was hurt in 2025 is kept, with a zero where no one was killed or seriously injured. " +
        "Leaving those cells out would compare the dangerous streets only with each other.",
    },
    {
      id: "note-reading",
      x: 1260, y: 260, w: 300, h: 150, color: "blue",
      text:
        "Gi* compares each cell and the six around it with every scored cell in London. " +
        "A z-score above 1.65, 1.96 or 2.58 marks a hot spot at 90, 95 or 99% confidence.",
    },
  ],
});

const run = await runWorkflow(api, workflow.id);

// The result map: the hot spots, and the collisions behind them.
const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

const hotspots = await addLayer({
  name: "Crash hot spots (Gi*)",
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
    "       CAST(value AS INTEGER) AS serious_or_fatal,",
    "       neighbour_count,",
    "       geom",
    "FROM crash_hotspots",
    "WHERE gi_star IS NOT NULL",
    "ORDER BY gi_star",
  ].join("\n"),
});
const significance = await api.post(`/api/layers/${hotspots.id}/fill`, { attribute: "significance", method: "categorical", palette: "bold" });
await patchLayer(hotspots.id, {
  style: {
    ...hotspots.style,
    fill: { ...significance, map: Object.entries(SIGNIFICANCE).map(([value, color]) => ({ value, color })) },
    fillOpacity: 0.7,
    // No outlines: thousands of cells drawn edge to edge read as a mesh,
    // most of all on the dark basemap.
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0,
    strokeOpacity: 0,
  },
  tooltip: ["significance", "gi_star", "serious_or_fatal", "neighbour_count"],
  legendTitle: "Where collisions cluster",
});

const collisions = await addLayer({
  name: "Collisions that killed or seriously injured",
  sql: "SELECT date, time, severity, road_type, speed_limit, light, geom FROM serious_collisions ORDER BY severity DESC",
});
await patchLayer(collisions.id, {
  style: {
    ...collisions.style,
    fill: { type: "constant", color: rgb("#1D1F24") },
    fillOpacity: 0.85,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0.4,
    strokeOpacity: 0.85,
    pointRadius: 1.7,
  },
  tooltip: ["date", "time", "severity", "road_type", "speed_limit", "light"],
  legendTitle: "A collision that killed or seriously injured",
});

const widget = (id, type, title, layerId, more) => ({
  id, type, layerId, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: -0.115, lat: 51.507, zoom: 11.4, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [hotspots.id, collisions.id],
  layerOrder: [hotspots.id, collisions.id],
  widgets: [
    widget("widget-count", "formula", "Killed or seriously injured", collisions.id, {
      format: "integer", unit: "collisions", note: "Reported to the police in London in 2025",
    }),
    widget("widget-severity", "category", "Severity", collisions.id, { field: "severity" }),
    widget("widget-road", "category", "Type of road", collisions.id, { field: "road_type" }),
    widget("widget-cells", "category", "Cells by confidence", hotspots.id, { field: "significance" }),
    widget("widget-sources", "note", "Sources", null, {
      note: creditNote(facts, {
        [dft.name]:
          "The collisions the Metropolitan Police and the City of London Police recorded in 2025; modified: only the date, time, severity, road type, speed limit and light kept. " +
          "[Road safety open data](https://www.gov.uk/government/statistical-data-sets/road-safety-open-data)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const results = {
  [steps.cells.id]: "collision_cells",
  [steps.serious.id]: "serious_collisions",
  [steps.perCell.id]: "serious_per_cell",
  [steps.everyCell.id]: "serious_by_cell",
  [steps.hotspots.id]: "crash_hotspots",
};
const authored = {
  base: api.origin,
  projectId: project.id,
  workflowId: workflow.id,
  runId: run.id,
  mapId: map.id,
  layers: { hotspots: hotspots.id, collisions: collisions.id },
  steps: Object.fromEntries(Object.entries(steps).map(([key, s]) => [key, s.id])),
  results,
  // The SQL step's reads, which its query names; the other steps read
  // their named inputs.
  reads: { [steps.everyCell.id]: ["collision_cells", "serious_per_cell"] },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, workflow ${workflow.id} (run ${run.id}), map ${map.id}\n`);
