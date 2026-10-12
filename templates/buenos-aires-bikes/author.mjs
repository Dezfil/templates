// Author "Buenos Aires by shared bike" on a scratch Dezfil through its
// documented API: the project, both datasets, the map with its lines,
// whose SQL aggregates the nine months' trips, and its stations, their styles,
// the widgets and the credit note.
//
//   node templates/buenos-aires-bikes/author.mjs http://127.0.0.1:3811 [work folder]
//
// Reads the build's output and writes <work>/buenos-aires-bikes/authored.json
// (the project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3811");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "buenos-aires-bikes");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [ecobici] = facts.sources;

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["trips", "stations"]) {
  const file = path.join(work, record.outputs[name].file);
  const table = await api.upload(`${name}.parquet`, await readFile(file), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

// The lines: 2.2 million trips counted between every pair of stations,
// both ways together, in five parts of the day, on weekdays and at
// weekends, then drawn between the two stations. A pair is drawn when it
// saw at least 100 trips in the nine months, about one every three days;
// each line carries the median ride of all the pair's trips.
const LINES_SQL = [
  "WITH rides AS (",
  "  SELECT least(from_station, to_station) AS a,",
  "         greatest(from_station, to_station) AS b,",
  "         CASE",
  "           WHEN hour(started) < 6 THEN 'Night, 0 to 6'",
  "           WHEN hour(started) < 10 THEN 'Morning, 6 to 10'",
  "           WHEN hour(started) < 16 THEN 'Midday, 10 to 16'",
  "           WHEN hour(started) < 20 THEN 'Evening, 16 to 20'",
  "           ELSE 'Late evening, 20 to 24'",
  "         END AS time_of_day,",
  "         CASE WHEN dayofweek(started) IN (0, 6) THEN 'Weekend' ELSE 'Weekday' END AS day_type,",
  "         minutes",
  "  FROM trips",
  "  WHERE from_station <> to_station",
  "),",
  "busy AS (",
  "  SELECT a, b, median(minutes) AS typical_minutes",
  "  FROM rides GROUP BY a, b HAVING count(*) >= 100",
  "),",
  "slots AS (",
  "  SELECT a, b, time_of_day, day_type, count(*) AS trips, any_value(typical_minutes) AS typical_minutes",
  "  FROM rides JOIN busy USING (a, b)",
  "  GROUP BY a, b, time_of_day, day_type",
  ")",
  "SELECT sa.name AS one_end,",
  "       sb.name AS other_end,",
  "       s.time_of_day,",
  "       s.day_type,",
  "       s.trips,",
  "       round(s.typical_minutes, 1) AS typical_minutes,",
  "       sa.geom AS one_end_station,",
  "       sb.geom AS other_end_station",
  "FROM slots s",
  "JOIN stations sa ON sa.station_id = s.a",
  "JOIN stations sb ON sb.station_id = s.b",
  "ORDER BY s.trips",
].join("\n");

// The stations, sized by the trips that start there and coloured by what a
// weekday morning does to them: from 6 to 10, how many more bikes arrive
// than leave (blue) or leave than arrive (red).
const STATIONS_SQL = [
  "WITH departures AS (",
  "  SELECT from_station AS station_id, count(*) AS departures,",
  "         count(*) FILTER (WHERE hour(started) BETWEEN 6 AND 9 AND dayofweek(started) NOT IN (0, 6)) AS morning_out",
  "  FROM trips GROUP BY ALL",
  "),",
  "arrivals AS (",
  "  SELECT to_station AS station_id, count(*) AS arrivals,",
  "         count(*) FILTER (WHERE hour(started) BETWEEN 6 AND 9 AND dayofweek(started) NOT IN (0, 6)) AS morning_in",
  "  FROM trips GROUP BY ALL",
  ")",
  "SELECT s.name,",
  "       coalesce(d.departures, 0) AS departures,",
  "       coalesce(a.arrivals, 0) AS arrivals,",
  "       coalesce(a.morning_in, 0) - coalesce(d.morning_out, 0) AS morning_gain,",
  "       s.geom",
  "FROM stations s",
  "LEFT JOIN departures d USING (station_id)",
  "LEFT JOIN arrivals a USING (station_id)",
  "ORDER BY departures",
].join("\n");

const stations = await addLayer({ name: "Stations, by the weekday morning", sql: STATIONS_SQL });
const gain = await api.post(`/api/layers/${stations.id}/fill`, { attribute: "morning_gain", method: "continuous", palette: "rdbu" });
const sizes = await api.post(`/api/layers/${stations.id}/scale`, { attribute: "departures", range: [1.5, 6] });
await patchLayer(stations.id, {
  style: {
    ...stations.style,
    fill: { ...gain, center: 0 },
    fillOpacity: 0.95,
    stroke: { r: 40, g: 44, b: 52, a: 1 },
    strokeOpacity: 0.6,
    strokeWidth: 0.5,
    pointRadiusBy: sizes,
  },
  tooltip: ["name", "departures", "arrivals", "morning_gain"],
  legendTitle: "Bikes gained on a weekday morning, 6 to 10",
});

const lines = await addLayer({ name: "Trips between stations", sql: LINES_SQL });
// Colour and width both follow the trips, the colour on a log scale; the
// ramp fades toward its quiet end, so the many small pairs stay a haze and
// the busy corridors stand out.
const tripPaint = await api.post(`/api/layers/${lines.id}/fill`, { attribute: "trips", method: "continuous", palette: "global_warming" });
const FADE = [0.03, 0.08, 0.25, 0.55, 0.85, 1];
if (tripPaint.stops.length !== FADE.length) throw new Error(`The ramp has ${tripPaint.stops.length} stops; the fade names ${FADE.length}.`);
const stops = tripPaint.stops.map((c, i) => ({ ...c, a: FADE[i] }));
const widths = await api.post(`/api/layers/${lines.id}/scale`, { attribute: "trips", range: [0.3, 6] });
await patchLayer(lines.id, {
  // Straight lines, seen from above: in a city this dense, arcs between
  // 400 stations rise into a dome that hides the corridors.
  viz: {
    type: "line",
    origin: { kind: "geometry", field: "one_end_station" },
    dest: { kind: "geometry", field: "other_end_station" },
    height: 0.25,
  },
  style: {
    ...lines.style,
    // Below ten trips in the nine months a line keeps the faintest colour.
    strokeBy: { ...tripPaint, log: true, clamp: [10, tripPaint.domain[1]], stops },
    strokeOpacity: 1,
    strokeWidth: 0.3,
    strokeWidthBy: widths,
  },
  tooltip: ["one_end", "other_end", "time_of_day", "day_type", "trips", "typical_minutes"],
  legendTitle: "Trips between two stations",
  legendAttrs: { stroke: "trips", width: "trips" },
});

const widget = (id, type, title, more) => ({
  id, type, layerId: lines.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
const read = record.sources.trips.fetchedAt.slice(0, 10);
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: -58.43, lat: -34.605, zoom: 12.25, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [lines.id, stations.id],
  layerOrder: [lines.id, stations.id],
  widgets: [
    widget("widget-trips", "formula", "Trips", { agg: "sum", field: "trips", format: "integer", note: "On the lines drawn, January to September 2026" }),
    widget("widget-time", "category", "Part of the day", { field: "time_of_day", agg: "sum", aggField: "trips" }),
    widget("widget-day", "category", "Weekday or weekend", { field: "day_type", agg: "sum", aggField: "trips" }),
    widget("widget-minutes", "histogram", "Typical ride between the two stations, min", { field: "typical_minutes" }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      note: creditNote(facts, {
        [ecobici.name]: `The Ecobici trips of January to September 2026 (recorridos-realizados-2026.zip), read on ${read}. Modified: only each trip's start (to the minute), its length and its two stations kept, the riders' user numbers and genders left out; the stations' names and positions taken from the trips; trips counted by pair of stations in the map's SQL. [BA Data: Bicicletas públicas](https://data.buenosaires.gob.ar/dataset/bicicletas-publicas)`,
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { stations: stations.id, lines: lines.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
