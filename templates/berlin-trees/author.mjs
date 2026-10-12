// Author "Every tree in Berlin" on a scratch Dezfil through its documented
// API: the project, the trees, the map with the city's trees in hexagons
// and one district tree by tree, their styles, the widgets and the credit
// note.
//
//   node templates/berlin-trees/author.mjs http://127.0.0.1:3801 [work folder]
//
// Reads the build's output and writes <work>/berlin-trees/authored.json
// (the project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3801");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "berlin-trees");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [gris, gruenBerlin] = facts.sources;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });

// The district drawn tree by tree: Friedrichshain-Kreuzberg, the smallest
// and densest, 46,039 trees, its street trees lining the blocks. Every
// tree of all twelve districts together, 982,266, is four times the
// render cap, so the rest of the city is drawn as hexagons, which the
// server counts from the trees themselves.
const DISTRICT = "Friedrichshain-Kreuzberg";
// Hexagons with 0.1 km edges on the web map, about 60 m on the ground at
// Berlin's latitude: a block of street trees, or a corner of a park.
const CELL_KM = 0.1;
// The planting years the hexagons' colours span: most trees were planted
// between the 1950s and the 2000s, and a cell's average falls in between;
// earlier or later averages take the ends' colours.
const OLDEST = 1950;
const YOUNGEST = 2010;
const AGE_RAMP = ["#0B3D2E", "#1F6F4A", "#4FA55A", "#A9CF54", "#F2E85C"];

// The district's genera: the eight it has most of, by name, and the rest
// together. Colours a reader can tell apart on either basemap.
const GENERA = {
  "Lime (Tilia)": "#2E9E5B",
  "Maple (Acer)": "#E8792B",
  "Black locust (Robinia)": "#C9B11E",
  "Poplar (Populus)": "#8FB8DE",
  "Oak (Quercus)": "#8C5A2B",
  "Plane (Platanus)": "#D04E8C",
  "Hornbeam (Carpinus)": "#2C6FB7",
  "Horse chestnut (Aesculus)": "#B23A3A",
};
const OTHER = { label: "Another genus", color: "#9AA3AE" };

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["trees", "gruen_berlin_trees"]) {
  const file = path.join(work, record.outputs[name].file);
  const table = await api.upload(`${name}.parquet`, await readFile(file), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}
// Both registers, one tree a row: the city's and Grün Berlin's.
const EVERY_TREE = (columns) => [
  "WITH every_tree AS (",
  `  SELECT ${columns} FROM trees`,
  "  UNION ALL",
  `  SELECT ${columns} FROM gruen_berlin_trees`,
  ")",
];

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);
const layerNow = async (id) => (await api.get(`/api/maps/${map.id}`)).layers.find((l) => l.id === id);

// The city: every tree outside the district, binned. Each hexagon takes
// its colour from the average planting year of its trees with a known
// year; the widgets read the trees themselves.
const city = await addLayer({
  name: "Berlin's trees in hexagons",
  sql: [
    ...EVERY_TREE("genus_name, planted, district, geom"),
    "SELECT genus_name AS genus, planted, geom",
    "FROM every_tree",
    `WHERE district IS DISTINCT FROM '${DISTRICT}'`,
  ].join("\n"),
});
await patchLayer(city.id, {
  viz: { type: "hexbin", cellKm: CELL_KM, aggregate: { fn: "avg", attribute: "planted" } },
});
const agePaint = await api.post(`/api/layers/${city.id}/fill`, { attribute: "value", method: "continuous", palette: "greens" });
{
  const layer = await layerNow(city.id);
  const n = AGE_RAMP.length;
  await patchLayer(city.id, {
    viz: {
      ...layer.viz,
      fill: {
        ...agePaint,
        domain: [OLDEST, YOUNGEST],
        clamp: [OLDEST, YOUNGEST],
        stops: AGE_RAMP.map((hex) => rgb(hex)),
        positions: AGE_RAMP.map((_, i) => i / (n - 1)),
      },
    },
    style: { ...layer.style, fillOpacity: 0.75, strokeWidth: 0, strokeOpacity: 0 },
    tooltip: [],
    legendTitle: "Average planting year in the hexagon",
  });
}

// The district: every tree, one point each, by genus.
const genera = Object.keys(GENERA).map((g) => `'${g.replace(/'/g, "''")}'`).join(", ");
const district = await addLayer({
  name: `${DISTRICT}, tree by tree`,
  sql: [
    ...EVERY_TREE("genus_name, species, species_de, planted, height_m, register, place, district, geom"),
    `SELECT CASE WHEN genus_name IN (${genera}) THEN genus_name ELSE '${OTHER.label}' END AS genus,`,
    "       species, species_de, planted, height_m, register, place, geom",
    "FROM every_tree",
    `WHERE district = '${DISTRICT}'`,
    // Drawn last, the named genera stay on top of the rest.
    `ORDER BY genus = '${OTHER.label}' DESC`,
  ].join("\n"),
});
const genusPaint = await api.post(`/api/layers/${district.id}/fill`, { attribute: "genus", method: "categorical", palette: "bold" });
await patchLayer(district.id, {
  style: {
    ...district.style,
    fill: {
      ...genusPaint,
      map: [...Object.entries(GENERA).map(([value, hex]) => ({ value, color: rgb(hex) })), { value: OTHER.label, color: rgb(OTHER.color) }],
    },
    fillOpacity: 0.95,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0,
    strokeOpacity: 0,
    pointRadius: 1.6,
  },
  tooltip: ["genus", "species", "species_de", "planted", "height_m", "place", "register"],
  legendTitle: `A tree in ${DISTRICT}, by genus`,
});

const widget = (id, type, title, layerId, more) => ({
  id, type, layerId, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
const total = record.slice.trees.toLocaleString("en-GB");
const asOf = record.sources.layers.street.fetchedAt.slice(0, 10);
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  // Friedrichshain-Kreuzberg in the middle, from Mitte on the left to
  // Lichtenberg on the right, Neukölln below.
  viewport: { lng: 13.425, lat: 52.505, zoom: 12.55, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [district.id, city.id],
  layerOrder: [city.id, district.id],
  widgets: [
    widget("widget-district", "formula", `Trees in ${DISTRICT}`, district.id, { format: "integer", unit: "trees", note: "Drawn one by one" }),
    widget("widget-city", "formula", "Trees in the other eleven districts", city.id, { format: "integer", unit: "trees", note: `Of ${total} in the registers, in hexagons` }),
    widget("widget-genus", "category", "Genus, other eleven districts", city.id, { field: "genus" }),
    widget("widget-planted", "histogram", "Planted, other eleven districts", city.id, { field: "planted" }),
    widget("widget-sources", "note", "Sources", null, {
      note: creditNote(facts, {
        [gris.name]:
          `Street and park trees as the register held them on ${record.sources.layers.street.fetchedAt.slice(0, 10)}. ` +
          "Modified: genus, species, planting year, size, district and street or park kept; places turned to longitude and latitude. " +
          "[gdi.berlin.de](https://gdi.berlin.de/geonetwork/srv/ger/catalog.search#/metadata/3368004a-d596-336a-8fdf-c4391f3313dd)",
        [gruenBerlin.name]:
          `As held on ${record.sources.layers.gruenBerlin.fetchedAt.slice(0, 10)}; modified as above. ` +
          "[Datenlizenz Deutschland, Namensnennung 2.0](https://www.govdata.de/dl-de/by-2-0)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { city: city.id, district: district.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
