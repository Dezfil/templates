// Author "The world's air routes" on a scratch Dezfil through its documented
// API: the project, both datasets, the map with its arc and airport layers,
// their styles, the widgets and the credit note.
//
//   node templates/air-routes/author.mjs http://127.0.0.1:3771 [work folder]
//
// Reads the build's output and writes <work>/air-routes/authored.json
// (the project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3771");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "air-routes");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [openflights] = facts.sources;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// Read on light and dark basemaps alike.
const BUSIER_END = rgb("#F08A0C");
const OTHER_END = rgb("#2272DA");
const AIRPORT = rgb("#FFFFFF");
const AIRPORT_RIM = rgb("#1B1F27");

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["air_routes", "airports"]) {
  const file = path.join(work, record.outputs[name].file);
  const table = await api.upload(`${name}.parquet`, await readFile(file), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

// The arcs: both ends as points, the second one moved by a whole turn when
// the pair is more than half the world apart, so the arc crosses the date
// line instead of the whole map. The busiest pairs last, so they draw on top.
const ROUTES_SQL = `SELECT
  busier_airport, other_airport, airlines, airline_band, distance_km, haul, scope,
  ST_Point(busier_lon, busier_lat) AS busier_end,
  ST_Point(
    CASE
      WHEN other_lon - busier_lon > 180 THEN other_lon - 360
      WHEN other_lon - busier_lon < -180 THEN other_lon + 360
      ELSE other_lon
    END,
    other_lat
  ) AS other_end
FROM air_routes
ORDER BY airlines, distance_km`;
const routes = await addLayer({ name: "Air routes, June 2014", sql: ROUTES_SQL });
const widths = await api.post(`/api/layers/${routes.id}/scale`, { attribute: "airlines", range: [0.5, 3.5] });
await patchLayer(routes.id, {
  viz: {
    type: "arc",
    origin: { kind: "geometry", field: "busier_end" },
    dest: { kind: "geometry", field: "other_end" },
    height: 0.5,
    targetColor: OTHER_END,
  },
  style: {
    ...routes.style,
    stroke: BUSIER_END,
    strokeOpacity: 0.38,
    strokeWidth: 0.5,
    strokeWidthBy: widths,
  },
  tooltip: ["busier_airport", "other_airport", "airlines", "distance_km", "scope"],
  legendTitle: "Air routes, June 2014",
  legendLabels: ["busier airport", "other airport", null],
  legendAttrs: { stroke: "airport pair", width: "airlines" },
});

// The airports over the arcs, sized by how many airports they reach.
const airports = await addLayer({ name: "Airports", sql: "SELECT iata, name, city, country, destinations, geom FROM airports ORDER BY destinations" });
const sizes = await api.post(`/api/layers/${airports.id}/scale`, { attribute: "destinations", range: [0.8, 6] });
await patchLayer(airports.id, {
  style: {
    ...airports.style,
    fill: { type: "constant", color: AIRPORT },
    fillOpacity: 0.9,
    stroke: AIRPORT_RIM,
    strokeOpacity: 0.6,
    strokeWidth: 0.5,
    pointRadius: 1,
    pointRadiusBy: sizes,
  },
  tooltip: ["iata", "name", "city", "country", "destinations"],
  legendTitle: "Airports",
  legendAttrs: { radius: "airports reached" },
});

const widget = (id, type, title, more) => ({
  id, type, layerId: routes.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: 15, lat: 28, zoom: 1.35, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [routes.id, airports.id],
  layerOrder: [routes.id, airports.id],
  widgets: [
    widget("widget-pairs", "formula", "Airport pairs", { note: "Joined by a nonstop route, June 2014", format: "integer" }),
    widget("widget-airlines", "category", "Airlines flying the pair", { field: "airline_band" }),
    widget("widget-haul", "category", "Haul, by great-circle distance", { field: "haul" }),
    widget("widget-scope", "category", "Domestic or international", { field: "scope" }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      note: creditNote(facts, {
        [openflights.name]: `The route database as it stood in June 2014, when its third-party source stopped; airports as revised to 2019. Read from the publisher's repository on ${record.sources.routes.fetchedAt.slice(0, 10)}. [openflights.org/data](https://openflights.org/data)`,
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { routes: routes.id, airports: airports.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
