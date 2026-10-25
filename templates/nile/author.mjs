// Author "The Nile" on a scratch Dezfil through its documented API: the
// project, the four datasets, the workflow with its steps and canvas, one
// whole run, and the result map with its layers, widgets and the credit
// note.
//
//   node templates/nile/author.mjs http://127.0.0.1:3821 [work folder]
//
// Reads the build's output and writes <work>/nile/authored.json: the
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
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3821");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "nile");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [kontur, naturalEarth] = facts.sources;

// Ten kilometres either side of the river: a couple of hours' walk, and
// about as far as the green of the valley reaches in Upper Egypt.
const BAND_METRES = 10000;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
const VALLEY = "#1B9E8A";
const DESERT = "#D9A35B";

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["population_cells", "nile", "nile_delta", "egypt"]) {
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
await step("simplify", "simplify", { input: "nile", tolerance: 250, name: "nile_simplified" });
await step("buffer", "buffer", { input: "nile_simplified", distance: BAND_METRES, name: "nile_10km" });
await step("withDelta", "union", { left: "nile_10km", right: "nile_delta", name: "nile_10km_and_delta" });
await step("dissolve", "dissolve", { input: "nile_10km_and_delta", name: "valley_whole" });
await step("clip", "clip", { input: "valley_whole", clip: "egypt", name: "valley" });
await step("desert", "difference", { input: "egypt", erase: "valley", name: "beyond_the_valley" });
await step("valleyArea", "measure_columns", { input: "valley", measures: ["area"], name: "valley_area" });
await step("desertArea", "measure_columns", { input: "beyond_the_valley", measures: ["area"], name: "beyond_the_valley_area" });
await step("cells", "filter_by_location", { input: "population_cells", mask: "valley", relation: "intersects", name: "cells_in_the_valley" });
await step("people", "group_summarize", {
  input: "cells_in_the_valley",
  aggregates: [{ aggregate: "sum", field: "population" }, { aggregate: "count" }],
  name: "people_in_the_valley",
});
await step("share", "sql_step", {
  sql: [
    "SELECT p.sum_population AS people_in_the_valley,",
    "       (SELECT sum(population) FROM population_cells) AS people_in_egypt,",
    "       round(100.0 * p.sum_population / (SELECT sum(population) FROM population_cells), 1) AS share_of_people,",
    "       round(v.area_m2 / 1e6) AS valley_km2,",
    "       round((v.area_m2 + d.area_m2) / 1e6) AS egypt_km2,",
    "       round(100.0 * v.area_m2 / (v.area_m2 + d.area_m2), 1) AS share_of_land,",
    "       v.geom",
    "FROM people_in_the_valley AS p, valley_area AS v, beyond_the_valley_area AS d",
  ].join("\n"),
  name: "the_valley_in_numbers",
});

// The canvas in sections, as canvas.mjs lays it out.
await setCanvas(api, workflow.id, canvas(facts));

const run = await runWorkflow(api, workflow.id);

// The result map: Egypt's people as columns, coloured by how much of each
// column lives in the valley; the valley outlined; the desert beyond it.
const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

const desert = await addLayer({ name: "Beyond the valley", sql: "SELECT round(area_m2 / 1e6) AS km2, geom FROM beyond_the_valley_area" });
await patchLayer(desert.id, {
  style: {
    ...desert.style,
    fill: { type: "constant", color: rgb(DESERT) },
    fillOpacity: 0.1,
    stroke: rgb(DESERT),
    strokeWidth: 0,
    strokeOpacity: 0,
  },
  tooltip: ["km2"],
  legendTitle: "Beyond the valley",
});

// Where Egypt's people live: Kontur's hexagons summed into hexagons 4 km a
// side, coloured on a logarithmic scale from a few people (pale, faint) to
// the cities (deep red), one ramp that reads on either basemap.
const people = await addLayer({
  name: "People",
  sql: "SELECT population, ST_Centroid(geom) AS geom FROM population_cells",
});
const hexbin = { type: "hexbin", cellKm: 4, aggregate: { fn: "sum", attribute: "population" } };
await patchLayer(people.id, { viz: hexbin });
const peoplePaint = await api.post(`/api/layers/${people.id}/fill`, { attribute: "value", method: "continuous", palette: "reds" });
const PEOPLE_STOPS = [["#FFD166", 0.3], ["#F4A259", 0.6], ["#E76F51", 0.9], ["#C1121F", 1]];
await patchLayer(people.id, {
  viz: { ...hexbin, fill: { ...peoplePaint, log: true, clamp: [20, 200000], stops: PEOPLE_STOPS.map(([hex, a]) => rgb(hex, a)) } },
  style: { ...people.style, fillOpacity: 1, strokeWidth: 0 },
  legendTitle: "People in hexagons 4 km a side",
});

const valley = await addLayer({
  name: "The valley",
  sql: "SELECT people_in_the_valley, share_of_people, valley_km2, share_of_land, geom FROM the_valley_in_numbers",
});
await patchLayer(valley.id, {
  style: {
    ...valley.style,
    fill: { type: "constant", color: rgb(VALLEY, 0) },
    fillOpacity: 0,
    stroke: rgb(VALLEY),
    strokeWidth: 1.4,
    strokeOpacity: 0.95,
  },
  tooltip: ["people_in_the_valley", "share_of_people", "valley_km2", "share_of_land"],
  legendTitle: "The valley: 10 km either side of the Nile, and the Delta",
});

const widget = (id, type, title, layerId, more) => ({
  id, type, layerId, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: 30.6, lat: 26.6, zoom: 5.35, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  layerOrder: [desert.id, people.id, valley.id],
  legendOrder: [people.id, valley.id, desert.id],
  widgets: [
    widget("widget-people", "formula", "People in the valley", valley.id, { field: "people_in_the_valley", agg: "sum", format: "integer" }),
    widget("widget-share", "formula", "Share of Egypt's people", valley.id, { field: "share_of_people", agg: "max", unit: "%" }),
    widget("widget-land", "formula", "Share of Egypt's land", valley.id, { field: "share_of_land", agg: "max", unit: "%" }),
    widget("widget-sources", "note", "Sources", null, {
      note: creditNote(facts, {
        [kontur.name]: "Release 2023-11-01. [data.humdata.org](https://data.humdata.org/dataset/kontur-population-egypt)",
        [naturalEarth.name]: "Rivers and lake centre lines, geographic regions, countries. [naturalearthdata.com](https://www.naturalearthdata.com)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const results = {
  [steps.simplify.id]: "nile_simplified",
  [steps.buffer.id]: "nile_10km",
  [steps.withDelta.id]: "nile_10km_and_delta",
  [steps.dissolve.id]: "valley_whole",
  [steps.clip.id]: "valley",
  [steps.desert.id]: "beyond_the_valley",
  [steps.valleyArea.id]: "valley_area",
  [steps.desertArea.id]: "beyond_the_valley_area",
  [steps.cells.id]: "cells_in_the_valley",
  [steps.people.id]: "people_in_the_valley",
  [steps.share.id]: "the_valley_in_numbers",
};
const authored = {
  base: api.origin,
  projectId: project.id,
  workflowId: workflow.id,
  runId: run.id,
  mapId: map.id,
  layers: { desert: desert.id, people: people.id, valley: valley.id },
  steps: Object.fromEntries(Object.entries(steps).map(([key, s]) => [key, s.id])),
  results,
  // The SQL step's reads, which its query names; the other steps read
  // their named inputs.
  reads: {
    [steps.share.id]: ["people_in_the_valley", "population_cells", "valley_area", "beyond_the_valley_area"],
  },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, workflow ${workflow.id} (run ${run.id}), map ${map.id}\n`);
