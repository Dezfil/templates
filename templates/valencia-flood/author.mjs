// Author "Valencia's 2024 flood footprint" on a scratch Dezfil through its
// documented API: the project, the four datasets, the map with the flood's
// footprint, the buildings the Copernicus service graded and the area it
// mapped, their styles, the widgets and the credit note.
//
//   node templates/valencia-flood/author.mjs http://127.0.0.1:3801 [work folder]
//
// Reads the build's output and writes <work>/valencia-flood/authored.json
// (the project, map and layer ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3801");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "valencia-flood");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [ems, overture] = facts.sources;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// Water blue where it still stood when the satellite passed, mud brown
// where it had gone and left its traces.
const SEEN = { "Standing water": rgb("#2C7BB6"), "Flood traces": rgb("#A8784A") };
const GRADE = { Destroyed: rgb("#B2182B"), Damaged: rgb("#EF6C2F"), "Possibly damaged": rgb("#F6C342") };

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["flood", "graded_buildings", "area_mapped", "towns"]) {
  const file = path.join(work, record.outputs[name].file);
  const table = await api.upload(`${name}.parquet`, await readFile(file), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

const area = await addLayer({ name: "Area Copernicus EMS mapped", sql: "SELECT area, area_km2, geom FROM area_mapped" });
await patchLayer(area.id, {
  style: {
    ...area.style,
    fill: { type: "constant", color: rgb("#FFFFFF", 0) },
    fillOpacity: 0,
    stroke: rgb("#7A8494"),
    strokeWidth: 1.5,
    strokeOpacity: 0.9,
  },
  tooltip: ["area", "area_km2"],
  legendTitle: "Area mapped",
});

const flood = await addLayer({ name: "Flood footprint", sql: "SELECT seen, area_km2, geom FROM flood" });
const seenPaint = await api.post(`/api/layers/${flood.id}/fill`, { attribute: "seen", method: "categorical", palette: "bold" });
await patchLayer(flood.id, {
  style: {
    ...flood.style,
    fill: { ...seenPaint, map: Object.entries(SEEN).map(([value, color]) => ({ value, color })) },
    fillOpacity: 0.65,
    strokeWidth: 0,
    strokeOpacity: 0,
  },
  tooltip: ["seen", "area_km2"],
  legendTitle: "Seen from the satellite on 31 October",
});

// Each graded building with the town it stands in, by a spatial join in
// the layer's SQL; the worst grades drawn last, on top.
const graded = await addLayer({
  name: "Buildings graded from the image",
  sql: [
    "SELECT g.grade, g.kind, g.name, t.town, g.geom",
    "FROM graded_buildings AS g",
    "LEFT JOIN towns AS t ON ST_Contains(t.geom, g.geom)",
    "ORDER BY CASE g.grade WHEN 'Destroyed' THEN 3 WHEN 'Damaged' THEN 2 ELSE 1 END, g.point",
  ].join("\n"),
});
const gradePaint = await api.post(`/api/layers/${graded.id}/fill`, { attribute: "grade", method: "categorical", palette: "bold" });
await patchLayer(graded.id, {
  style: {
    ...graded.style,
    fill: { ...gradePaint, map: Object.entries(GRADE).map(([value, color]) => ({ value, color })) },
    fillOpacity: 0.95,
    // Small and unrimmed: in the worst-hit towns the points stand side by
    // side, and a rim would turn them into one white blot.
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0,
    strokeOpacity: 0,
    pointRadius: 1.5,
  },
  tooltip: ["grade", "town", "kind", "name"],
  legendTitle: "Damage seen from the image",
});

const widget = (id, type, title, layerId, more) => ({
  id, type, layerId, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: -0.497, lat: 39.425, zoom: 11.45, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [graded.id, flood.id, area.id],
  layerOrder: [area.id, flood.id, graded.id],
  widgets: [
    widget("widget-area", "formula", "Footprint", flood.id, { field: "area_km2", agg: "sum", format: "decimal1", unit: "km²", note: "Standing water and flood traces, in the area mapped" }),
    widget("widget-graded", "formula", "Buildings graded damaged", graded.id, { format: "integer", note: "Destroyed, damaged or possibly damaged, as seen from above" }),
    widget("widget-grades", "category", "Damage grade", graded.id, { field: "grade" }),
    widget("widget-towns", "category", "Graded buildings by municipality", graded.id, { field: "town" }),
    widget("widget-sources", "note", "Sources", null, {
      note: creditNote(facts, {
        [ems.name]: "Activation EMSR773, flood in the Valencia region; grading map version 2 of 6 November 2024, from a GeoEye-1 image of 31 October 2024. Modified: classes named in English, areas in km². [mapping.emergency.copernicus.eu](https://mapping.emergency.copernicus.eu/activations/EMSR773/)",
        [overture.name]: `Release ${record.sources.overture.release}; the municipalities the area takes in. [overturemaps.org](https://overturemaps.org)`,
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { area: area.id, flood: flood.id, graded: graded.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
