// Author "Forty years of big earthquakes" on a scratch Dezfil through its
// documented API: the project, both datasets, the map with its two layers,
// their styles, the timeline, the widgets and the credit note.
//
//   node templates/earthquakes/author.mjs http://127.0.0.1:3751 [work folder]
//
// Reads the build's output and writes <work>/earthquakes/authored.json
// (the project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3751");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "earthquakes");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [usgs, plates] = facts.sources;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// Read on light and dark basemaps alike.
const DEPTH = {
  "Shallow, under 70 km": rgb("#E8452C"),
  "Intermediate, 70 to 300 km": rgb("#F2A51A"),
  "Deep, 300 km or more": rgb("#2F7FD8"),
};
const BOUNDARY = { "Subduction zone": rgb("#9B6BD6"), "Other plate boundary": rgb("#8C9099") };

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["earthquakes", "plate_boundaries"]) {
  const file = path.join(work, record.outputs[name].file);
  const table = await api.upload(`${name}.parquet`, await readFile(file), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

// Bottom first: the plate boundaries under the earthquakes.
const platesLayer = await addLayer({ name: "Plate boundaries", sql: "SELECT * FROM plate_boundaries" });
const boundaryPaint = await api.post(`/api/layers/${platesLayer.id}/fill`, { attribute: "boundary_type", method: "categorical", palette: "bold" });
await patchLayer(platesLayer.id, {
  style: {
    ...platesLayer.style,
    strokeBy: { ...boundaryPaint, map: boundaryPaint.map.map((e) => ({ value: e.value, color: BOUNDARY[e.value] })) },
    strokeWidth: 1.4,
    strokeOpacity: 0.9,
  },
  tooltip: ["name", "boundary_type", "plate_a", "plate_b"],
  legendTitle: "Plate boundaries",
});

// Deeper earthquakes draw over shallower ones, so the sinking plates show
// through the shallow belt along every trench.
const quakes = await addLayer({ name: "Earthquakes, magnitude 5 or more", sql: "SELECT * FROM earthquakes ORDER BY depth_km" });
const depthPaint = await api.post(`/api/layers/${quakes.id}/fill`, { attribute: "depth_class", method: "categorical", palette: "bold" });
const sizes = await api.post(`/api/layers/${quakes.id}/scale`, { attribute: "magnitude", range: [0.6, 8] });
await patchLayer(quakes.id, {
  style: {
    ...quakes.style,
    fill: { ...depthPaint, map: Object.entries(DEPTH).map(([value, color]) => ({ value, color })) },
    fillOpacity: 0.6,
    strokeWidth: 0,
    pointRadius: 2,
    pointRadiusBy: sizes,
  },
  tooltip: ["place", "magnitude", "magnitude_type", "depth_km", "time_utc"],
  filters: [{ field: "time_utc", kind: "timerange", min: null, max: null }],
  legendTitle: "Earthquake depth",
});

const widget = (id, type, title, more) => ({
  id, type, layerId: quakes.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: 150, lat: 12, zoom: 1.35, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [quakes.id, platesLayer.id],
  layerOrder: [platesLayer.id, quakes.id],
  timeline: { layerId: quakes.id, field: "time_utc", speed: 1 },
  widgets: [
    widget("widget-count", "formula", "Earthquakes", { note: "Magnitude 5 or more", format: "integer" }),
    widget("widget-magnitude", "histogram", "Magnitude", { field: "magnitude" }),
    widget("widget-depth", "category", "Depth", { field: "depth_class" }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      note: creditNote(facts, {
        [usgs.name]: `Every earthquake of magnitude 5 or more, 1986 to 2025, as the catalogue held them on ${record.sources.usgs[0].fetchedAt.slice(0, 10)}. [earthquake.usgs.gov](https://earthquake.usgs.gov/earthquakes/search/)`,
        [plates.name]: "Bird, P. (2003), An updated digital model of plate boundaries, Geochemistry Geophysics Geosystems 4(3), 1027. [doi:10.1029/2001GC000252](https://doi.org/10.1029/2001GC000252)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { plates: platesLayer.id, quakes: quakes.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
