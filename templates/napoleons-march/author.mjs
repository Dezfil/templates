// Author "Napoleon's march" on a scratch Dezfil through its documented API:
// the project, the three datasets, the map with the army's bands, the
// places and the temperatures, their styles and the credit note.
//
//   node templates/napoleons-march/author.mjs http://127.0.0.1:3801 [work folder]
//
// Reads the build's output and writes <work>/napoleons-march/authored.json
// (the project, map and layer ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3801");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "napoleons-march");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [minard, wikidata] = facts.sources;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// Minard's two inks on a light basemap, as on his paper: the men who go
// into Russia in a pinkish tan, the men who come out in black.
const DIRECTION = { Advance: rgb("#D29C80"), Retreat: rgb("#1E1B18") };

// Where each label sits at the template's camera: a nudge in pixels from
// its point, so that no two texts touch where the retreat crowds them
// between Wilna and Bobr and around Moscou, and none sits on the black band. Labels in different layers do
// not avoid one another, so the placement is set here; every label is
// centred on its nudged point, which keeps the point inside its own box.
// Names go above their point unless named; temperatures below.
const CAMERA = { lng: 30.75, lat: 55.05, zoom: 5.85 };
const PLACE_NUDGES = {
  Smorgoni: [-21, -13],
  Molodezno: [-10, 22],
  Studienska: [-8, 23],
  Bobr: [21, 24],
  Wizma: [-40, -6],
  Tarantino: [45, 0],
  "Malo-jarosewli": [-24, 19],
};
const TEMPERATURE_NUDGES = {
  "0°": [30, 2],
  "−9°": [0, 16],
  "−11°": [6, -19],
  "−20°": [7, -23],
  "−24°": [7, -19],
  "−30°": [14, -18],
  "−26°": [0, 15],
};
// A point moved by dx, dy pixels at the camera's zoom, in Web Mercator.
const nudged = (column, nudges, [dx, dy]) => {
  const perDegree = (512 * 2 ** CAMERA.zoom) / 360;
  const cases = (i) => Object.entries(nudges).map(([text, d]) => `WHEN ${column} = '${text}' THEN ${d[i]}`).join(" ");
  const x = `CASE ${cases(0)} ELSE ${dx} END`;
  const y = `CASE ${cases(1)} ELSE ${dy} END`;
  const mercator = "degrees(ln(tan(pi() / 4 + radians(ST_Y(geom)) / 2)))";
  return `ST_Point(ST_X(geom) + (${x}) / ${perDegree}, degrees(2 * atan(exp(radians(${mercator} - (${y}) / ${perDegree}))) - pi() / 2)) AS geom`;
};

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["army", "places", "temperatures"]) {
  const table = await api.upload(`${name}.parquet`, await readFile(path.join(work, record.outputs[name].file)), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

// The retreat draws over the advance, as Minard inked it.
const army = await addLayer({
  name: "The army, by men present",
  sql: "SELECT part, direction, men, how_read, geom FROM army ORDER BY direction, stretch",
});
const paint = await api.post(`/api/layers/${army.id}/fill`, { attribute: "direction", method: "categorical", palette: "bold" });
await patchLayer(army.id, {
  style: {
    ...army.style,
    // The bands are as wide as the men in them (the build draws them at
    // Minard's scale); a hairline in the same ink keeps the thinnest ones,
    // a few thousand men, visible when zoomed out.
    fill: { ...paint, map: Object.entries(DIRECTION).map(([value, color]) => ({ value, color })) },
    fillOpacity: 1,
    strokeBy: { ...paint, map: Object.entries(DIRECTION).map(([value, color]) => ({ value, color })) },
    strokeWidth: 1,
    strokeOpacity: 1,
  },
  tooltip: ["men", "direction", "part", "how_read"],
  legendTitle: "The army, by men present",
});

const temperatures = await addLayer({
  name: "Temperature on the retreat",
  sql: `SELECT label, day, degrees_reaumur, degrees_celsius, as_printed, ${nudged("label", TEMPERATURE_NUDGES, [0, 8])} FROM temperatures`,
});
await patchLayer(temperatures.id, {
  style: {
    ...temperatures.style,
    // Minard wrote numbers, not dots: the label is the mark (the point
    // stays for the tooltip).
    fill: { type: "constant", color: rgb("#2F6DB5") },
    fillOpacity: 0,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0,
    strokeOpacity: 0,
    pointRadius: 4,
    label: { attribute: "label", size: 13, color: rgb("#1F4F8A"), haloWidth: 1, haloColor: rgb("#FFFFFF", 0.9), weight: "bold", density: 1 },
  },
  tooltip: ["day", "degrees_reaumur", "degrees_celsius", "as_printed"],
  legendTitle: "Temperature (degrees Réaumur)",
});

const places = await addLayer({
  name: "Places, as Minard named them",
  sql: `SELECT name_on_chart, name_today, ${nudged("name_on_chart", PLACE_NUDGES, [0, -9])} FROM places`,
});
await patchLayer(places.id, {
  style: {
    ...places.style,
    fill: { type: "constant", color: rgb("#3A3530") },
    fillOpacity: 0,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0,
    strokeOpacity: 0,
    pointRadius: 4,
    label: { attribute: "name_on_chart", size: 12, color: rgb("#2A2622"), haloWidth: 1, haloColor: rgb("#FFFFFF", 0.9), density: 1 },
  },
  tooltip: ["name_on_chart", "name_today"],
  legendTitle: "Places, as Minard named them",
});

const widget = (id, type, title, more) => ({
  id, type, layerId: army.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { ...CAMERA, pitch: 0, bearing: 0 },
  basemap: "light",
  // Minard's names are the map's names: today's basemap labels would sit
  // on top of them (Minsk, Moscow, Vitebsk).
  basemapLayers: { labels: false },
  legendCorner: "bottom-left",
  legendOrder: [army.id, temperatures.id, places.id],
  layerOrder: [army.id, temperatures.id, places.id],
  widgets: [
    widget("widget-men", "formula", "Most men in one band", { field: "men", agg: "max", format: "integer", note: "422,000 crossed the Niemen; about 10,000 came back" }),
    widget("widget-direction", "category", "Into Russia or out of it", { field: "direction" }),
    widget("widget-legend", "note", "Reading Minard's chart", {
      layerId: null,
      note:
        "Minard's own legend: \"The numbers of men present are represented by the widths of the coloured zones, at one millimetre for ten thousand men; they are also written across the zones. The red designates the men who enter Russia, the black those who leave it.\"\n\n" +
        "His temperatures are in degrees Réaumur below zero: multiply by 1.25 for Celsius. At the left edge of his table: \"The Cossacks gallop across the frozen Niemen.\"",
    }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      note: creditNote(facts, {
        [minard.name]: "Paris, 20 November 1869. Every number is Minard's; where he printed none, it is read from the band's width at his scale. [Gallica, btv1b52504201x](https://gallica.bnf.fr/ark:/12148/btv1b52504201x)",
        [wikidata.name]: `The coordinates of the ${record.slice.places} places, which pin the chart to the map. [wikidata.org](https://www.wikidata.org)`,
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { army: army.id, temperatures: temperatures.id, places: places.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
