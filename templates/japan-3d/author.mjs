// Author "Japan in 3D" on a scratch Dezfil through its documented API: the
// project, Chiyoda's buildings, the map with every building raised to its
// measured height and coloured by it, the widgets and the credit note.
//
//   node templates/japan-3d/author.mjs http://127.0.0.1:3811 [work folder]
//
// Reads the build's output and writes <work>/japan-3d/authored.json (the
// project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3811");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "japan-3d");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [plateau] = facts.sources;

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
{
  const file = path.join(work, record.outputs.buildings.file);
  const table = await api.upload("buildings.parquet", await readFile(file), project.id);
  if (table.name !== "buildings" || table.rowCount !== record.outputs.buildings.rows) {
    throw new Error(`buildings landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs.buildings.rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

const buildings = await addLayer({
  name: "Buildings of Chiyoda",
  sql: "SELECT name, height_m, height_band, geom FROM buildings ORDER BY height_m",
});
// Every building stands at its measured height: the height scale maps the
// heights onto themselves, metre for metre.
const scale = await api.post(`/api/layers/${buildings.id}/scale`, { attribute: "height_m", range: [0, record.slice.tallestMetres], unit: "m" });
const heightBy = { ...scale, range: [...scale.domain] };
// Colour by height on a log ramp, so the streets of five-storey blocks and
// the towers of Marunouchi both find their colours.
const heightPaint = await api.post(`/api/layers/${buildings.id}/fill`, { attribute: "height_m", method: "continuous", palette: "plasma" });
await patchLayer(buildings.id, {
  style: {
    ...buildings.style,
    fill: { ...heightPaint, log: true },
    fillOpacity: 1,
    strokeWidth: 0,
    strokeOpacity: 0,
    heightBy,
  },
  tooltip: ["name", "height_m", "height_band"],
  legendTitle: "Measured height, m",
});

const widget = (id, type, title, more) => ({
  id, type, layerId: buildings.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  // From above Tokyo Station looking west: the towers of Marunouchi and
  // Otemachi in front, the Imperial Palace's gardens behind them. (At a
  // pitch of 60 and at some nearby centres the server's image export of
  // this view does not finish within its time limit; this one does.)
  viewport: { lng: 139.7605, lat: 35.684, zoom: 14.9, pitch: 50, bearing: -75 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [buildings.id],
  layerOrder: [buildings.id],
  widgets: [
    widget("widget-count", "formula", "Buildings", { format: "integer", unit: "buildings", note: "In Chiyoda, surveyed in 2016" }),
    widget("widget-tallest", "formula", "Tallest", { agg: "max", field: "height_m", unit: "m", note: "The highest measured point of a building" }),
    widget("widget-band", "category", "Height", { field: "height_band" }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      note: creditNote(facts, {
        [plateau.name]:
          `The ward's ${record.slice.buildings.toLocaleString("en")} building models (LOD0 roof outlines and measured heights), read on ${record.builtAt.slice(0, 10)}. ` +
          "[Project PLATEAU on G-spatial](https://www.geospatial.jp/ckan/dataset/plateau-tokyo23ku)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { buildings: buildings.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
