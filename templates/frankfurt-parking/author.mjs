// Author "Hunting for a parking spot in Frankfurt" on a scratch Dezfil
// through its documented API: the project, the three datasets, the map
// with its three layers and their styles, the widgets and the credit note.
//
//   node templates/frankfurt-parking/author.mjs http://127.0.0.1:3761 [work folder]
//
// Reads the build's output and writes <work>/frankfurt-parking/authored.json
// (the project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";
import { readLicence } from "./sources.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3761");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "frankfurt-parking");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [trips, supply] = facts.sources;
// The trips are under BSD-3-Clause: its notice, word for word, travels in
// the map's note beside their credit.
const licence = await readLicence(work, record);

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// Read on light and dark basemaps alike: driving recedes, searching burns.
const ACTIVITY = {
  Driving: rgb("#8A94A6"),
  Searching: rgb("#F2542D"),
  Walking: rgb("#12A889"),
};
// Spaces per 100 m of kerb: none (a faint grey), thin, parallel parking,
// mixed, angled or perpendicular parking. Breaks at the supply's own steps;
// blue to violet keeps clear of the trips' red and green on either theme.
const DENSITY_BREAKS = [1, 15, 20, 30];
const DENSITY = [rgb("#8C93A0", 0.35), rgb("#8FB3DE"), rgb("#4F8BD9"), rgb("#6A5FD3"), rgb("#9B45C9")];

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["trip_phases", "parking_spaces", "parking_segments"]) {
  const file = path.join(work, record.outputs[name].file);
  const table = await api.upload(`${name}.parquet`, await readFile(file), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

// Bottom first: the spaces along the kerbs, the street segments over them
// (so the overview reads by density, and the spaces show as the streets
// widen when zoomed in), then the trips.
const segments = await addLayer({
  name: "Street parking, spaces per 100 m",
  sql: "SELECT street, spaces, length_m, spaces_per_100m, geom FROM parking_segments WHERE spaces_per_100m IS NOT NULL ORDER BY spaces_per_100m",
});
const density = await api.post(`/api/layers/${segments.id}/fill`, { attribute: "spaces_per_100m", method: "natural", classes: 5 });
await patchLayer(segments.id, {
  style: {
    ...segments.style,
    strokeBy: { ...density, method: "custom", baseMethod: "natural", breaks: DENSITY_BREAKS, colors: DENSITY },
    strokeWidth: 2.6,
    strokeOpacity: 0.9,
  },
  tooltip: ["street", "spaces", "length_m", "spaces_per_100m"],
  legendTitle: "Street parking, spaces per 100 m",
});

const spaces = await addLayer({ name: "Parking spaces", sql: "SELECT street, orientation, position, geom FROM parking_spaces" });
await patchLayer(spaces.id, {
  style: {
    ...spaces.style,
    fill: { type: "constant", color: rgb("#7F8FA6") },
    fillOpacity: 0.6,
    strokeWidth: 0,
    pointRadius: 1,
  },
  tooltip: ["street", "orientation", "position"],
  legendTitle: "One parking space",
});

// Searching draws over walking over driving, so the hunt is never hidden.
const tripsLayer = await addLayer({
  name: "Trips, by what the driver was doing",
  sql:
    "SELECT activity, started, minutes, search_minutes, search_time, parked, cost, trips, geom FROM trip_phases " +
    "ORDER BY CASE activity WHEN 'Driving' THEN 0 WHEN 'Walking' THEN 1 ELSE 2 END",
});
const activityPaint = await api.post(`/api/layers/${tripsLayer.id}/fill`, { attribute: "activity", method: "categorical", palette: "bold" });
await patchLayer(tripsLayer.id, {
  style: {
    ...tripsLayer.style,
    strokeBy: { ...activityPaint, map: Object.entries(ACTIVITY).map(([value, color]) => ({ value, color })) },
    strokeWidth: 3,
    strokeOpacity: 0.95,
  },
  tooltip: ["activity", "minutes", "started", "search_minutes", "parked", "cost"],
  legendTitle: "What the driver was doing",
});

const widget = (id, type, title, more) => ({
  id, type, layerId: tripsLayer.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
// Each widget counts trips: one stretch of every trip carries trips = 1.
const byTrips = { agg: "sum", aggField: "trips" };
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: 8.6795, lat: 50.1195, zoom: 14.15, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [tripsLayer.id, segments.id, spaces.id],
  layerOrder: [spaces.id, segments.id, tripsLayer.id],
  widgets: [
    widget("widget-trips", "formula", "Trips", { field: "trips", agg: "sum", format: "integer", note: "Driven to a destination in Frankfurt" }),
    widget("widget-search-time", "category", "Search time", { field: "search_time", ...byTrips }),
    widget("widget-parked", "category", "Parked", { field: "parked", ...byTrips }),
    widget("widget-cost", "category", "Parking was", { field: "cost", ...byTrips }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      // A note holds 2,000 characters and the notice takes 1,492 of them,
      // so the links stay short.
      note: creditNote(facts, {
        [trips.name]: `[ReLUT on GitHub](https://github.com/ReLUT/parking-search-prediction)\n\n${licence.trim()}`,
        [supply.name]: "[Mobilithek](https://mobilithek.info/offers/886571101635461120)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { segments: segments.id, spaces: spaces.id, trips: tripsLayer.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
