// Author "Rondônia's fishbone" on a scratch Dezfil through its documented
// API: the project, the two datasets, the map with the forest cleared
// before 2008 and the forest cleared each year since, the hexagons in 3D
// (switched off), their styles, the timeline, the widgets and the credit
// note.
//
//   node templates/rondonia-fishbone/author.mjs http://127.0.0.1:3811 [work folder]
//
// Reads the build's output and writes <work>/rondonia-fishbone/authored.json
// (the project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3811");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "rondonia-fishbone");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [yearlySource, maskSource] = facts.sources;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// The forest cleared before 2008 in one quiet earth colour, so the
// fishbone reads as a whole and the years since stand out on it.
const BEFORE_2008 = rgb("#AD9068");

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["cleared_before_2008", "cleared_by_year"]) {
  const file = path.join(work, record.outputs[name].file);
  const table = await api.upload(`${name}.parquet`, await readFile(file), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

const before = await addLayer({ name: "Forest cleared before 2008", sql: "SELECT area_km2, geom FROM cleared_before_2008" });
await patchLayer(before.id, {
  style: { ...before.style, fill: { type: "constant", color: BEFORE_2008 }, fillOpacity: 0.9, strokeWidth: 0, strokeOpacity: 0 },
  tooltip: ["area_km2"],
  legendTitle: "Cleared before 2008",
});

const yearly = await addLayer({
  name: "Forest cleared each year since 2008",
  sql: "SELECT prodes_year, year_ending, image_date, area_km2, geom FROM cleared_by_year ORDER BY prodes_year",
});
const yearPaint = await api.post(`/api/layers/${yearly.id}/fill`, { attribute: "prodes_year", method: "continuous", palette: "plasma" });
await patchLayer(yearly.id, {
  style: { ...yearly.style, fill: yearPaint, fillOpacity: 1, strokeWidth: 0, strokeOpacity: 0 },
  tooltip: ["prodes_year", "image_date", "area_km2"],
  filters: [{ field: "year_ending", kind: "timerange", min: null, max: null }],
  legendTitle: "Year cleared (PRODES year, August to July)",
});

// The same clearings counted into hexagons with 5 km sides, raised and
// coloured by the area cleared in each since 2008: where the frontier
// moved most. Off when the map opens; switch it on and tilt the map.
const hexes = await addLayer({
  name: "Cleared since 2008, per hexagon, in 3D",
  sql: "SELECT year_ending, area_km2, ST_Centroid(geom) AS geom FROM cleared_by_year",
});
const binned = {
  type: "hexbin",
  cellKm: 5,
  aggregate: { fn: "sum", attribute: "area_km2" },
  elevation: { aggregate: { fn: "sum", attribute: "area_km2" }, height: 20000 },
};
await patchLayer(hexes.id, { viz: binned, visible: false, legendTitle: "Forest cleared since 2008, km² per hexagon" });
const hexPaint = await api.post(`/api/layers/${hexes.id}/fill`, { attribute: "value", method: "continuous", palette: "ylorrd" });
await patchLayer(hexes.id, {
  viz: { ...binned, fill: hexPaint },
  style: { ...hexes.style, fill: hexPaint, fillOpacity: 0.9, strokeWidth: 0, strokeOpacity: 0 },
});

const widget = (id, type, title, more) => ({
  id, type, layerId: yearly.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
const read = record.builtAt.slice(0, 10);
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: -62.8, lat: -10.05, zoom: 7.7, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [yearly.id, before.id, hexes.id],
  layerOrder: [before.id, yearly.id, hexes.id],
  timeline: { layerId: yearly.id, field: "year_ending", speed: 1 },
  widgets: [
    widget("widget-cleared", "formula", "Forest cleared since 2008", { agg: "sum", field: "area_km2", unit: "km²", format: "integer", note: "In the years the timeline shows" }),
    widget("widget-years", "category", "The years most was cleared, km²", { field: "prodes_year", agg: "sum", aggField: "area_km2" }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      note: creditNote(facts, {
        [yearlySource.name]: `The yearly increments for the state of Rondônia, ${record.slice.yearly.first_year} to ${record.slice.yearly.last_year}, read from TerraBrasilis on ${read}.`,
        [maskSource.name]:
          `The state's mask of forest cleared up to 2007, read on ${read}. Both: Brazilian biomes monitoring program of NATIONAL INSTITUTE FOR SPACE RESEARCH. COORDINATION-GENERAL OFFICE OF EARTH SCIENCES. Modified: cut to Rondônia on the server; outlines simplified by about 55 m; slivers with no area left out. This template's data stays under CC BY-SA 4.0. ` +
          "[TerraBrasilis](https://terrabrasilis.dpi.inpe.br/en/citations-and-use-licence/)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { before: before.id, yearly: yearly.id, hexes: hexes.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
