// Author "Melbourne's urban forest" on a scratch Dezfil through its
// documented API: the project, the trees, the map with its forest of
// raised hexagons and its icons for the trees nearest their end, their
// styles, the widgets and the credit note.
//
//   node templates/melbourne-urban-forest/author.mjs http://127.0.0.1:3811 [work folder]
//
// Reads the build's output and writes <work>/melbourne-urban-forest/
// authored.json (the project, map, layer and widget ids pack and pictures
// need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3811");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "melbourne-urban-forest");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [melbourne] = facts.sources;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });

// Hexagons with 60 m edges, about a city block's width of park or street:
// a street of planes or a corner of a park is one column. Each rises with
// its trees and takes its colour from the average useful life its assessed
// trees have left. The height scale runs from no trees to the densest
// hexagon, 719 trees in Docklands, while the median hexagon holds 13 and
// nine in ten hold under 50: 2,500 m at the top lets an ordinary hexagon
// stand about 45 m tall and a busy park corner about 170 m, instead of
// lying flat under one dense planting.
const CELL_KM = 0.06;
const TALLEST_M = 2500;

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
{
  const file = path.join(work, record.outputs.trees.file);
  const table = await api.upload("trees.parquet", await readFile(file), project.id);
  if (table.name !== "trees" || table.rowCount !== record.outputs.trees.rows) {
    throw new Error(`trees landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs.trees.rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

// The forest: every tree, binned. The two shortest life classes are one
// for the widget, which shows five classes: under ten years alone would
// fall into its "Other".
const forest = await addLayer({
  name: "The urban forest",
  sql: [
    "SELECT genus,",
    "       CASE WHEN useful_life_years <= 20 THEN '20 years or less' ELSE useful_life END AS useful_life_left,",
    "       useful_life_years,",
    "       geom",
    "FROM trees",
  ].join("\n"),
});
const binned = {
  type: "hexbin",
  cellKm: CELL_KM,
  aggregate: { fn: "avg", attribute: "useful_life_years" },
  elevation: { aggregate: { fn: "count" }, height: TALLEST_M },
};
await patchLayer(forest.id, { viz: binned });
// Viridis: purple where the trees are nearest their end, through green to
// yellow where they have decades; it stays legible on both basemaps,
// where a red-to-blue ramp turned muddy under the columns' shading.
const lifePaint = await api.post(`/api/layers/${forest.id}/fill`, { attribute: "value", method: "continuous", palette: "viridis" });
{
  const now = await api.get(`/api/maps/${map.id}`);
  const layer = now.layers.find((l) => l.id === forest.id);
  await patchLayer(forest.id, {
    viz: { ...layer.viz, fill: lifePaint },
    style: { ...layer.style, fillOpacity: 0.9, strokeWidth: 0, strokeOpacity: 0 },
    tooltip: [],
    legendTitle: "Useful life left, years (the cell's average)",
  });
}

// The trees nearest their end, one icon each, for reading street by
// street. The layer opens switched off: under the raised forest its icons
// would stand inside the columns, and the image export of a pitched map
// with both never finishes.
const ending = await addLayer({
  name: "Trees with 20 years or less to live",
  sql: [
    "SELECT common_name, scientific_name, useful_life, located_in, precinct, geom",
    "FROM trees",
    "WHERE useful_life_years <= 20",
    "ORDER BY useful_life_years DESC",
  ].join("\n"),
});
const endingPaint = await api.post(`/api/layers/${ending.id}/fill`, { attribute: "useful_life", method: "categorical", palette: "bold" });
const ENDING = { "Under 10 years": rgb("#B3001B"), "11 to 20 years": rgb("#F08A24") };
await patchLayer(ending.id, {
  viz: { type: "icon", glyph: "park" },
  visible: false,
  style: {
    ...ending.style,
    fill: { ...endingPaint, map: endingPaint.map.map((e) => ({ ...e, color: ENDING[e.value] ?? e.color })) },
    fillOpacity: 1,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0,
    strokeOpacity: 0,
    pointRadius: 5,
  },
  tooltip: ["common_name", "scientific_name", "useful_life", "located_in", "precinct"],
  legendTitle: "A tree with 20 years or less to live",
});

const widget = (id, type, title, more) => ({
  id, type, layerId: forest.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  // Over Southbank toward the city grid, the Fitzroy and Carlton Gardens
  // to the right and Royal Park beyond.
  viewport: { lng: 144.9625, lat: -37.8135, zoom: 14.1, pitch: 55, bearing: -20 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [ending.id, forest.id],
  layerOrder: [forest.id, ending.id],
  widgets: [
    widget("widget-trees", "formula", "Trees", { format: "integer", unit: "trees", note: "Maintained by the City of Melbourne" }),
    widget("widget-life", "category", "Useful life left", { field: "useful_life_left" }),
    widget("widget-genus", "category", "Genus", { field: "genus" }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      note: creditNote(facts, {
        [melbourne.name]:
          `The city's tree inventory as updated on ${record.slice.datasetModified.slice(0, 10)}, read on ${record.sources.trees.fetchedAt.slice(0, 10)}. ` +
          "Modified: names, place, age and useful life kept; trees binned into hexagons in the map. " +
          "[data.melbourne.vic.gov.au](https://data.melbourne.vic.gov.au/explore/dataset/trees-with-species-and-dimensions-urban-forest/)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { forest: forest.id, ending: ending.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
