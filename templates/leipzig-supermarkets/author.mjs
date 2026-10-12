// Author "Supermarket access in Leipzig" on a scratch Dezfil through its
// documented API: the project, the three datasets, the workflow with its
// four steps and canvas, one whole run, and the result map with its
// layers, widgets and the credit note.
//
//   node templates/leipzig-supermarkets/author.mjs http://127.0.0.1:3801 [work folder]
//
// Reads the build's output and writes <work>/leipzig-supermarkets/
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
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3801");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "leipzig-supermarkets");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [zensus, osm, leipzig] = facts.sources;

// A kilometre in a straight line: about fifteen minutes on foot once the
// streets bend, carrying the shopping home.
const FAR_METRES = 1000;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// Near is calm, far is alarm; each band reads on light and dark alike.
const DISTANCE = {
  "Under 500 m": rgb("#7FC8B4"),
  "500 m to 1 km": rgb("#E8C35A"),
  "1 to 1.5 km": rgb("#EE7D3B"),
  "1.5 km or more": rgb("#C8102E"),
};

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["population_cells", "supermarkets", "districts"]) {
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
await step("centres", "centroid", { input: "population_cells", name: "cell_centres" });
await step("nearest", "nearest_join", {
  left: "cell_centres",
  right: "supermarkets",
  carry: ["name", "brand"],
  name: "nearest_supermarket",
});
await step("district", "spatial_join", {
  left: "nearest_supermarket",
  right: "districts",
  // A cell's middle on a boundary between two districts meets both, and
  // counts in one of them.
  predicate: "intersects",
  carry: [{ aggregate: "any", field: "district", as: "district" }],
  name: "cells_by_district",
});
await step("summary", "sql_step", {
  sql: [
    "SELECT d.district,",
    "       sum(c.population)::INTEGER AS people,",
    `       coalesce(sum(c.population) FILTER (WHERE c.nearest_distance_m > ${FAR_METRES}), 0)::INTEGER AS people_beyond_1km,`,
    `       round(100.0 * coalesce(sum(c.population) FILTER (WHERE c.nearest_distance_m > ${FAR_METRES}), 0) / sum(c.population), 1) AS share_beyond_1km,`,
    "       round(sum(c.population * c.nearest_distance_m) / sum(c.population))::INTEGER AS average_metres,",
    "       any_value(d.geom) AS geom",
    "FROM districts AS d",
    "JOIN cells_by_district AS c ON c.district = d.district",
    "GROUP BY d.district",
    "ORDER BY share_beyond_1km DESC",
  ].join("\n"),
  name: "district_access",
});

await setLayout(api, workflow.id, {
  sources: {
    population_cells: { x: 20, y: 40 },
    supermarkets: { x: 20, y: 240 },
    districts: { x: 20, y: 440 },
  },
  steps: {
    [steps.centres.id]: { x: 300, y: 40 },
    [steps.nearest.id]: { x: 580, y: 140 },
    [steps.district.id]: { x: 860, y: 300 },
    [steps.summary.id]: { x: 1140, y: 300 },
  },
  notes: [
    {
      id: "note-distance",
      x: 580, y: -60, w: 300, h: 150, color: "yellow",
      text:
        "The distance runs in a straight line from the middle of each 100 m census cell to the nearest supermarket, in metres on the ground. " +
        "Streets, rivers and railways make the walk longer.",
    },
    {
      id: "note-summary",
      x: 1140, y: 460, w: 300, h: 150, color: "blue",
      text:
        "Per district: its people, those more than 1 km from a supermarket and their share, and the average distance, each cell weighted by the people in it.",
    },
  ],
});

const run = await runWorkflow(api, workflow.id);

// The result map: the cells by distance, the districts with their share,
// the supermarkets.
const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

const cells = await addLayer({
  name: "People by distance to the nearest supermarket",
  sql: [
    "SELECT CASE",
    "         WHEN n.nearest_distance_m < 500 THEN 'Under 500 m'",
    "         WHEN n.nearest_distance_m < 1000 THEN '500 m to 1 km'",
    "         WHEN n.nearest_distance_m < 1500 THEN '1 to 1.5 km'",
    "         ELSE '1.5 km or more'",
    "       END AS distance,",
    "       round(n.nearest_distance_m)::INTEGER AS metres_to_supermarket,",
    "       c.population,",
    "       n.name AS nearest_supermarket,",
    "       c.geom",
    "FROM population_cells AS c",
    "JOIN nearest_supermarket AS n ON n.cell = c.cell",
  ].join("\n"),
});
const distancePaint = await api.post(`/api/layers/${cells.id}/fill`, { attribute: "distance", method: "categorical", palette: "bold" });
await patchLayer(cells.id, {
  style: {
    ...cells.style,
    fill: { ...distancePaint, map: Object.entries(DISTANCE).map(([value, color]) => ({ value, color })) },
    fillOpacity: 0.8,
    strokeWidth: 0,
    strokeOpacity: 0,
  },
  tooltip: ["distance", "metres_to_supermarket", "population", "nearest_supermarket"],
  legendTitle: "Straight-line distance to the nearest supermarket",
});

const districtLayer = await addLayer({
  name: "Districts, share more than 1 km away",
  sql: [
    "SELECT district, people, people_beyond_1km, share_beyond_1km, average_metres,",
    // Only the districts where at least one person in ten lives that far
    // away carry a label; the rest would crowd the middle of the city.
    "       CASE WHEN share_beyond_1km >= 10 THEN district || ' · ' || share_beyond_1km || '%' END AS label,",
    "       geom",
    "FROM district_access",
  ].join("\n"),
});
await patchLayer(districtLayer.id, {
  style: {
    ...districtLayer.style,
    fill: { type: "constant", color: rgb("#FFFFFF", 0) },
    fillOpacity: 0,
    stroke: rgb("#5C6370"),
    strokeWidth: 1,
    strokeOpacity: 0.9,
    // White on a dark rim reads over the cells on either theme (dark on
    // a white rim vanishes on the dark one); the districts with the
    // largest share win a label first.
    label: {
      attribute: "label",
      size: 11,
      color: rgb("#FFFFFF"),
      haloWidth: 1,
      haloColor: rgb("#1D1F24", 0.9),
      weight: "bold",
      density: 1,
      priorityField: "share_beyond_1km",
    },
  },
  tooltip: ["district", "people", "people_beyond_1km", "share_beyond_1km", "average_metres"],
  legendTitle: "Districts",
});

const shops = await addLayer({ name: "Supermarkets", sql: "SELECT name, brand, geom FROM supermarkets" });
await patchLayer(shops.id, {
  viz: { type: "icon", glyph: "grocery" },
  style: {
    ...shops.style,
    fill: { type: "constant", color: rgb("#3A63D8") },
    fillOpacity: 1,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0,
    strokeOpacity: 0,
    pointRadius: 4,
  },
  tooltip: ["name", "brand"],
  legendTitle: "Supermarket",
});

const widget = (id, type, title, layerId, more) => ({
  id, type, layerId, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: 12.372, lat: 51.334, zoom: 10.78, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [cells.id, shops.id, districtLayer.id],
  layerOrder: [cells.id, districtLayer.id, shops.id],
  widgets: [
    widget("widget-distance", "category", "People by distance", cells.id, { field: "distance", agg: "sum", aggField: "population" }),
    widget("widget-far", "formula", "More than 1 km away", districtLayer.id, {
      field: "people_beyond_1km", agg: "sum", format: "integer", note: "People, straight-line distance",
    }),
    widget("widget-shops", "formula", "Supermarkets", shops.id, { format: "integer", note: "In OpenStreetMap, in and around the city" }),
    widget("widget-sources", "note", "Sources", null, {
      note: creditNote(facts, {
        [zensus.name]: "Population per 100 m cell, Zensus 2022; modified: the city's cells only, as squares in longitude and latitude. [zensus2022.de](https://www.zensus2022.de/DE/Ergebnisse-des-Zensus/gitterzellen.html)",
        [osm.name]: `Supermarkets as mapped on ${record.sources.overpass.osmBase.slice(0, 10)}. [openstreetmap.org/copyright](https://www.openstreetmap.org/copyright)`,
        [leipzig.name]: "The 63 districts (Ortsteile); modified: outlines in longitude and latitude. [opendata.leipzig.de](https://opendata.leipzig.de/dataset/geodaten-ortsteile-leipzig)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const results = {
  [steps.centres.id]: "cell_centres",
  [steps.nearest.id]: "nearest_supermarket",
  [steps.district.id]: "cells_by_district",
  [steps.summary.id]: "district_access",
};
const authored = {
  base: api.origin,
  projectId: project.id,
  workflowId: workflow.id,
  runId: run.id,
  mapId: map.id,
  layers: { cells: cells.id, districts: districtLayer.id, shops: shops.id },
  steps: Object.fromEntries(Object.entries(steps).map(([key, s]) => [key, s.id])),
  results,
  // The SQL step's reads, which its query names; the other steps read
  // their named inputs.
  reads: { [steps.summary.id]: ["districts", "cells_by_district"] },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, workflow ${workflow.id} (run ${run.id}), map ${map.id}\n`);
