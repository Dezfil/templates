// Author "Living with volcanoes" on a scratch Dezfil through its documented
// API: the project, the four datasets, the workflow with its steps and
// canvas, one whole run, and the result map with its layers, widgets and
// the credit note.
//
//   node templates/living-with-volcanoes/author.mjs http://127.0.0.1:3821 [work folder]
//
// Reads the build's output and writes <work>/living-with-volcanoes/
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
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3821");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "living-with-volcanoes");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [ncei, kontur, naturalEarth] = facts.sources;

// Thirty kilometres around each volcano: the reach the question asks about.
const RADIUS_METRES = 30000;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// The last known eruption, recent in red to oldest in brown.
const LAST = {
  "1964 or later": rgb("#C1121F"),
  "1900 to 1963": rgb("#F77F00"),
  "1800 to 1899": rgb("#FCBF49"),
  "1500 to 1699": rgb("#C9A66B"),
  "AD 1 to 1499": rgb("#9C8A74"),
};

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["volcanoes", "significant_eruptions", "population_cells", "philippines"]) {
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
await step("historical", "filter_rows", { input: "volcanoes", field: "status", comparison: "equals", value: "Historical", name: "historical_volcanoes" });
await step("buffer", "buffer", { input: "historical_volcanoes", distance: RADIUS_METRES, name: "within_30km" });
await step("land", "clip", { input: "within_30km", clip: "philippines", name: "within_30km_on_land" });
await step("centres", "centroid", { input: "population_cells", name: "cell_centres" });
await step("perVolcano", "spatial_join", {
  left: "within_30km_on_land",
  right: "cell_centres",
  predicate: "contains",
  carry: [{ aggregate: "sum", field: "population", as: "people" }],
  name: "people_per_volcano",
});
await step("eruptions", "group_summarize", {
  input: "significant_eruptions",
  group_by: ["volcano_id"],
  aggregates: [{ aggregate: "count" }, { aggregate: "max", field: "year" }],
  name: "eruptions_per_volcano",
});
await step("story", "join_by_key", {
  left: "people_per_volcano",
  right: "eruptions_per_volcano",
  left_key: "volcano_id",
  right_key: "volcano_id",
  carry: ["feature_count", "max_year"],
  name: "volcanoes_in_numbers",
});
await step("together", "dissolve", { input: "within_30km_on_land", name: "near_a_volcano" });
await step("near", "filter_by_location", { input: "cell_centres", mask: "near_a_volcano", relation: "within", name: "centres_near_a_volcano" });
await step("people", "group_summarize", {
  input: "centres_near_a_volcano",
  aggregates: [{ aggregate: "sum", field: "population" }],
  name: "people_near_a_volcano",
});
await step("share", "sql_step", {
  sql: [
    "SELECT p.sum_population AS people_near_a_volcano,",
    "       (SELECT sum(population) FROM population_cells) AS people_in_the_philippines,",
    "       round(100.0 * p.sum_population / (SELECT sum(population) FROM population_cells), 1) AS share_of_people,",
    "       n.geom",
    "FROM people_near_a_volcano AS p, near_a_volcano AS n",
  ].join("\n"),
  name: "the_philippines_in_numbers",
});

await setLayout(api, workflow.id, {
  sources: {
    volcanoes: { x: 20, y: 40 },
    philippines: { x: 20, y: 260 },
    population_cells: { x: 20, y: 480 },
    significant_eruptions: { x: 20, y: 700 },
  },
  steps: {
    [steps.historical.id]: { x: 300, y: 40 },
    [steps.buffer.id]: { x: 580, y: 40 },
    [steps.land.id]: { x: 860, y: 150 },
    [steps.centres.id]: { x: 300, y: 480 },
    [steps.perVolcano.id]: { x: 1140, y: 300 },
    [steps.eruptions.id]: { x: 300, y: 700 },
    [steps.story.id]: { x: 1420, y: 480 },
    [steps.together.id]: { x: 1140, y: 40 },
    [steps.near.id]: { x: 1420, y: 150 },
    [steps.people.id]: { x: 1700, y: 150 },
    [steps.share.id]: { x: 1980, y: 150 },
  },
  notes: [
    {
      id: "note-historical",
      x: 300, y: 200, w: 300, h: 110, color: "yellow",
      text: "\"Historical\" is NCEI's status for a volcano with an eruption in recorded history: 18 of the Philippines' 49.",
    },
    {
      id: "note-overlap",
      x: 1420, y: 640, w: 300, h: 130, color: "blue",
      text:
        "Someone within 30 km of two volcanoes counts for each of them here; the total near any volcano counts them once, " +
        "from the circles merged into one shape.",
    },
  ],
});

const run = await runWorkflow(api, workflow.id);

// The result map.
const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

// The people within 30 km, summed into hexagons 2 km a side on a
// logarithmic ramp, faint for a few people and deep red for the towns.
const people = await addLayer({ name: "People within 30 km of a volcano", sql: "SELECT population, geom FROM centres_near_a_volcano" });
const hexbin = { type: "hexbin", cellKm: 2, aggregate: { fn: "sum", attribute: "population" } };
await patchLayer(people.id, { viz: hexbin });
const peoplePaint = await api.post(`/api/layers/${people.id}/fill`, { attribute: "value", method: "continuous", palette: "reds" });
const PEOPLE_STOPS = [["#FFE08A", 0.45], ["#F4A259", 0.7], ["#E76F51", 0.9], ["#C1121F", 1]];
await patchLayer(people.id, {
  viz: { ...hexbin, fill: { ...peoplePaint, log: true, clamp: [20, 100000], stops: PEOPLE_STOPS.map(([hex, a]) => rgb(hex, a)) } },
  style: { ...people.style, fillOpacity: 0.9, strokeWidth: 0 },
  legendTitle: "People in hexagons 2 km a side",
});

// The land within 30 km of any of them, merged: the workflow's last step.
const area = await addLayer({ name: "Within 30 km of a volcano", sql: "SELECT people_near_a_volcano, share_of_people, geom FROM the_philippines_in_numbers" });
await patchLayer(area.id, {
  style: {
    ...area.style,
    fill: { type: "constant", color: rgb("#7A5C3E") },
    fillOpacity: 0.08,
    stroke: rgb("#8C6A48"),
    strokeWidth: 1.2,
    strokeOpacity: 0.9,
  },
  tooltip: ["people_near_a_volcano", "share_of_people"],
  legendTitle: "Land within 30 km of a volcano with a historical eruption",
});

const others = await addLayer({
  name: "Other volcanoes",
  sql: "SELECT name, status, last_known_eruption, geom FROM volcanoes WHERE status <> 'Historical'",
});
await patchLayer(others.id, {
  style: {
    ...others.style,
    fill: { type: "constant", color: rgb("#8A8F98") },
    fillOpacity: 0.85,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0.6,
    strokeOpacity: 0.8,
    pointRadius: 2.5,
  },
  tooltip: ["name", "status", "last_known_eruption"],
  legendTitle: "Other volcanoes, no eruption in recorded history",
});

const historical = await addLayer({
  name: "Volcanoes with a historical eruption",
  sql: [
    "SELECT n.name,",
    "       n.last_known_eruption,",
    "       n.people AS people_within_30km,",
    "       coalesce(n.feature_count, 0) AS significant_eruptions,",
    "       n.max_year AS last_significant_eruption,",
    "       n.name || ' · ' || CASE WHEN n.people >= 1e6 THEN round(n.people / 1e6, 1) || ' million'",
    "                               ELSE CAST(round(n.people / 1e3) AS INTEGER) || ' thousand' END AS label,",
    "       v.geom",
    "FROM volcanoes_in_numbers AS n",
    "JOIN historical_volcanoes AS v USING (volcano_id)",
    "ORDER BY n.people DESC",
  ].join("\n"),
});
const maxPeople = (await api.post("/api/query", { sql: "SELECT max(people) AS m FROM volcanoes_in_numbers" })).preview[0].m;
const lastPaint = await api.post(`/api/layers/${historical.id}/fill`, { attribute: "last_known_eruption", method: "categorical", palette: "bold" });
await patchLayer(historical.id, {
  style: {
    ...historical.style,
    fill: { ...lastPaint, map: Object.entries(LAST).map(([value, color]) => ({ value, color })) },
    fillOpacity: 0.75,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 1,
    strokeOpacity: 0.95,
    pointRadiusBy: { attribute: "people_within_30km", domain: [0, Number(maxPeople)], range: [3, 24] },
    label: {
      attribute: "label",
      size: 12,
      color: rgb("#FFFFFF"),
      haloWidth: 1,
      haloColor: rgb("#1D1F24"),
      weight: "bold",
      anchor: "right",
      offsetX: 6,
      priorityField: "people_within_30km",
    },
  },
  tooltip: ["name", "last_known_eruption", "people_within_30km", "significant_eruptions", "last_significant_eruption"],
  legendTitle: "Volcanoes with a historical eruption, by the last one; size, the people within 30 km",
});

const widget = (id, type, title, layerId, more) => ({
  id, type, layerId, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  // The camera holds southern Luzon, where five of the eighteen stand and
  // the most people live near them; the rest are a pan away.
  viewport: { lng: 122.45, lat: 13.95, zoom: 7.35, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  layerOrder: [area.id, people.id, others.id, historical.id],
  legendOrder: [historical.id, others.id, people.id, area.id],
  widgets: [
    widget("widget-people", "formula", "People within 30 km of a volcano", area.id, {
      field: "people_near_a_volcano", agg: "sum", format: "integer", note: "Of a volcano with a historical eruption, counted once",
    }),
    widget("widget-share", "formula", "Share of the Philippines' people", area.id, { field: "share_of_people", agg: "max", unit: "%" }),
    widget("widget-volcanoes", "category", "People within 30 km, by volcano", historical.id, { field: "name", agg: "sum", aggField: "people_within_30km" }),
    widget("widget-sources", "note", "Sources", null, {
      note: creditNote(facts, {
        [ncei.name]: "[ncei.noaa.gov, volcanoes](https://www.ncei.noaa.gov/products/natural-hazards/tsunamis-earthquakes-volcanoes/volcanoes); the list descends from the Smithsonian's Global Volcanism Program.",
        [kontur.name]: "Release 2023-11-01. [data.humdata.org](https://data.humdata.org/dataset/kontur-population-philippines)",
        [naturalEarth.name]: "[naturalearthdata.com](https://www.naturalearthdata.com)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const results = {
  [steps.historical.id]: "historical_volcanoes",
  [steps.buffer.id]: "within_30km",
  [steps.land.id]: "within_30km_on_land",
  [steps.centres.id]: "cell_centres",
  [steps.perVolcano.id]: "people_per_volcano",
  [steps.eruptions.id]: "eruptions_per_volcano",
  [steps.story.id]: "volcanoes_in_numbers",
  [steps.together.id]: "near_a_volcano",
  [steps.near.id]: "centres_near_a_volcano",
  [steps.people.id]: "people_near_a_volcano",
  [steps.share.id]: "the_philippines_in_numbers",
};
const authored = {
  base: api.origin,
  projectId: project.id,
  workflowId: workflow.id,
  runId: run.id,
  mapId: map.id,
  layers: { area: area.id, people: people.id, others: others.id, historical: historical.id },
  steps: Object.fromEntries(Object.entries(steps).map(([key, s]) => [key, s.id])),
  results,
  // The SQL step's reads, which its query names; the other steps read
  // their named inputs.
  reads: {
    [steps.share.id]: ["people_near_a_volcano", "population_cells", "near_a_volcano"],
  },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, workflow ${workflow.id} (run ${run.id}), map ${map.id}\n`);
