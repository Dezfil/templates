// Author "Health access in Rwanda" on a scratch Dezfil through its
// documented API: the project, the three datasets, the workflow with its
// six steps and canvas, one whole run, and the result map with its
// layers, widgets and the credit note.
//
//   node templates/rwanda-health-access/author.mjs http://127.0.0.1:3761 [work folder]
//
// Reads the build's output and writes <work>/rwanda-health-access/
// authored.json: the project, workflow, map and layer ids, and the results
// pack bundles (one dataset per step, named by the step).

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
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "rwanda-health-access");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [kontur, maina, geoboundaries] = facts.sources;

// Five kilometres, about an hour's walk: the threshold the question asks.
const FAR_METRES = 5000;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// Near is calm, far is alarm; each band reads on light and dark alike.
const DISTANCE = {
  "Under 2 km": rgb("#7FC8B4"),
  "2 to 5 km": rgb("#E8C35A"),
  "5 to 10 km": rgb("#EE7D3B"),
  "10 km or more": rgb("#C8102E"),
};

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["population_cells", "health_facilities", "districts"]) {
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
// The nearest facility to each hexagon's middle, measured on the WGS84
// ellipsoid in a SQL step. The nearest join would be the natural tool, but
// it measures in one UTM zone and Rwanda straddles two (the zone edge is
// 30° E, through Kigali), so it refuses the country as a whole.
await step("nearest", "sql_step", {
  sql: [
    "SELECT c.h3,",
    "       c.population,",
    "       n.facility_name,",
    "       n.facility_type,",
    "       round(n.distance_m) AS nearest_distance_m,",
    "       c.geom",
    "FROM cell_centres AS c",
    "CROSS JOIN LATERAL (",
    "  SELECT f.facility_name,",
    "         f.facility_type,",
    "         ST_Distance_Spheroid(ST_Point2D(ST_Y(c.geom), ST_X(c.geom)), ST_Point2D(ST_Y(f.geom), ST_X(f.geom))) AS distance_m",
    "  FROM health_facilities AS f",
    "  ORDER BY distance_m",
    "  LIMIT 1",
    ") AS n",
  ].join("\n"),
  name: "nearest_facility",
});
await step("far", "filter_rows", {
  input: "nearest_facility",
  field: "nearest_distance_m",
  comparison: "greater_than",
  value: String(FAR_METRES),
  name: "beyond_5km",
});
await step("districtPeople", "spatial_join", {
  left: "districts",
  right: "cell_centres",
  predicate: "contains",
  carry: [{ aggregate: "sum", field: "population", as: "people" }],
  name: "district_people",
});
await step("districtFar", "spatial_join", {
  left: "district_people",
  right: "beyond_5km",
  predicate: "contains",
  carry: [{ aggregate: "sum", field: "population", as: "people_beyond_5km" }],
  name: "district_access",
});
await step("share", "sql_step", {
  sql: [
    "SELECT district,",
    "       people,",
    "       coalesce(people_beyond_5km, 0) AS people_beyond_5km,",
    "       round(100.0 * coalesce(people_beyond_5km, 0) / people, 1) AS share_beyond_5km,",
    "       geom",
    "FROM district_access",
    "ORDER BY share_beyond_5km DESC",
  ].join("\n"),
  name: "district_share",
});

// The canvas in sections, as canvas.mjs lays it out.
await setCanvas(api, workflow.id, canvas(facts));

const run = await runWorkflow(api, workflow.id);

// The result map: the hexagons by distance, the districts with their
// share, the facilities.
const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

const cells = await addLayer({
  name: "People by distance to the nearest facility",
  sql: [
    "SELECT CASE",
    "         WHEN n.nearest_distance_m < 2000 THEN 'Under 2 km'",
    "         WHEN n.nearest_distance_m < 5000 THEN '2 to 5 km'",
    "         WHEN n.nearest_distance_m < 10000 THEN '5 to 10 km'",
    "         ELSE '10 km or more'",
    "       END AS distance,",
    "       round(n.nearest_distance_m / 1000, 1) AS km_to_facility,",
    "       c.population,",
    "       n.facility_name AS nearest_facility,",
    "       c.geom",
    "FROM population_cells AS c",
    "JOIN nearest_facility AS n ON n.h3 = c.h3",
  ].join("\n"),
});
const distancePaint = await api.post(`/api/layers/${cells.id}/fill`, { attribute: "distance", method: "categorical", palette: "bold" });
await patchLayer(cells.id, {
  style: {
    ...cells.style,
    fill: { ...distancePaint, map: Object.entries(DISTANCE).map(([value, color]) => ({ value, color })) },
    fillOpacity: 0.85,
    strokeWidth: 0,
  },
  tooltip: ["distance", "km_to_facility", "population", "nearest_facility"],
  legendTitle: "Straight-line distance to a public health facility",
});

const districtLayer = await addLayer({
  name: "Districts, share more than 5 km away",
  // The name over its share, on two lines: narrow enough that 27 of the
  // 30 districts keep a label at the template's camera (Kigali's two small
  // inner districts and Ngororero show from the next zoom in).
  sql: "SELECT district, people, people_beyond_5km, share_beyond_5km, district || chr(10) || share_beyond_5km || '%' AS label, geom FROM district_share",
});
await patchLayer(districtLayer.id, {
  style: {
    ...districtLayer.style,
    fill: { type: "constant", color: rgb("#FFFFFF", 0) },
    fillOpacity: 0,
    stroke: rgb("#5C6370"),
    strokeWidth: 1.2,
    strokeOpacity: 0.9,
    // White on a dark rim reads over the hexagons on either theme; the
    // districts with the largest share win a label first.
    label: {
      attribute: "label",
      size: 9,
      color: rgb("#FFFFFF"),
      haloWidth: 1,
      haloColor: rgb("#1D1F24", 0.85),
      weight: "bold",
      density: 0.75,
      priorityField: "share_beyond_5km",
    },
  },
  tooltip: ["district", "people", "people_beyond_5km", "share_beyond_5km"],
  legendTitle: "Districts",
});

const facilities = await addLayer({ name: "Public health facilities", sql: "SELECT facility_name, facility_type, ownership, geom FROM health_facilities" });
await patchLayer(facilities.id, {
  style: {
    ...facilities.style,
    fill: { type: "constant", color: rgb("#1D1F24") },
    fillOpacity: 0.9,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0.5,
    strokeOpacity: 0.9,
    pointRadius: 1.5,
  },
  tooltip: ["facility_name", "facility_type", "ownership"],
  legendTitle: "Public health facility",
});

const widget = (id, type, title, layerId, more) => ({
  id, type, layerId, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: 29.88, lat: -1.94, zoom: 8.1, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [cells.id, facilities.id, districtLayer.id],
  // The districts above the facilities, so no facility's dot covers a
  // district's label (a layer's labels draw in its own place in the stack).
  layerOrder: [cells.id, facilities.id, districtLayer.id],
  widgets: [
    widget("widget-distance", "category", "People by distance", cells.id, { field: "distance", agg: "sum", aggField: "population" }),
    widget("widget-far", "formula", "More than 5 km away", districtLayer.id, {
      field: "people_beyond_5km", agg: "sum", format: "integer", note: "People, straight-line distance",
    }),
    widget("widget-facilities", "formula", "Public health facilities", facilities.id, { format: "integer" }),
    widget("widget-sources", "note", "Sources", null, {
      note: creditNote(facts, {
        [kontur.name]: "Release 2023-11-01. [data.humdata.org](https://data.humdata.org/dataset/kontur-population-rwanda)",
        [maina.name]: "[doi:10.1038/s41597-019-0142-2](https://doi.org/10.1038/s41597-019-0142-2)",
        [geoboundaries.name]: "[www.geoboundaries.org](https://www.geoboundaries.org)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const results = {
  [steps.centres.id]: "cell_centres",
  [steps.nearest.id]: "nearest_facility",
  [steps.far.id]: "beyond_5km",
  [steps.districtPeople.id]: "district_people",
  [steps.districtFar.id]: "district_access",
  [steps.share.id]: "district_share",
};
const authored = {
  base: api.origin,
  projectId: project.id,
  workflowId: workflow.id,
  runId: run.id,
  mapId: map.id,
  layers: { cells: cells.id, districts: districtLayer.id, facilities: facilities.id },
  steps: Object.fromEntries(Object.entries(steps).map(([key, s]) => [key, s.id])),
  results,
  // The SQL steps' reads, which their queries name; the other steps read
  // their named inputs.
  reads: {
    [steps.nearest.id]: ["cell_centres", "health_facilities"],
    [steps.share.id]: ["district_access"],
  },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, workflow ${workflow.id} (run ${run.id}), map ${map.id}\n`);
