// Author "Zurich's counters" on a scratch Dezfil through its documented
// API: the project, the counts and the counters, the map with one week of
// hourly counts on a timeline and the counters' names, their styles, the
// widgets and the credit note.
//
//   node templates/zurich-counters/author.mjs http://127.0.0.1:3801 [work folder]
//
// Reads the build's output and writes <work>/zurich-counters/authored.json
// (the project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3801");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "zurich-counters");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [counts, sites] = facts.sources;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });

// The week on the timeline: Monday 7 to Sunday 13 July 2025, the last
// school week before the summer holidays, with 25 of the year's 28
// counters counting. The dataset holds the whole year in quarter hours;
// the layer's SQL picks the week and adds the quarter hours up by hour.
const WEEK = { from: "2025-07-07", to: "2025-07-14" };
// The hour the map opens on, and its pictures show: Tuesday's evening
// rush, the busiest hour of the week.
const OPENING = { min: "2025-07-08T17:00:00", max: "2025-07-08T17:59:59" };

const MODES = { Bicycles: rgb("#1F78C8"), Pedestrians: rgb("#E8792B") };
const TIMES_OF_DAY = [
  [6, "Night, 0 to 6"],
  [9, "Morning rush, 6 to 9"],
  [16, "Day, 9 to 16"],
  [19, "Evening rush, 16 to 19"],
  [24, "Evening, 19 to 24"],
];

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["counts", "counters"]) {
  const file = path.join(work, record.outputs[name].file);
  const table = await api.upload(`${name}.parquet`, await readFile(file), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

// The counters, named, under the counts.
const places = await addLayer({ name: "The counters", sql: "SELECT name, mode, towards_in, towards_out, geom FROM counters" });
await patchLayer(places.id, {
  style: {
    ...places.style,
    fill: { type: "constant", color: rgb("#2B2F36") },
    fillOpacity: 0.9,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0.8,
    strokeOpacity: 0.9,
    pointRadius: 2.5,
    label: {
      attribute: "name",
      // Dark on a white rim: crisp on the light basemap, outlined on the
      // dark one; white on a dark rim washed out on the light basemap.
      size: 10,
      color: rgb("#2B2F36"),
      haloWidth: 1,
      haloColor: rgb("#FFFFFF", 0.9),
      // Beside the point, clear of the smaller circles.
      anchor: "right",
      offsetX: 8,
      density: 0.5,
    },
  },
  tooltip: ["name", "mode", "towards_in", "towards_out"],
  legendTitle: "A counter",
});

// The week, hour by hour: each counter's passages, both ways together.
const band = TIMES_OF_DAY.map(([until, label]) => `WHEN hour(q.quarter_hour) < ${until} THEN '${label}'`).join(" ");
const hours = await addLayer({
  name: "Passages per hour",
  sql: [
    "SELECT c.name AS counter,",
    "       q.mode,",
    "       date_trunc('hour', q.quarter_hour) AS hour,",
    `       CASE ${band} END AS time_of_day,`,
    "       sum(q.passages)::INTEGER AS passages,",
    "       sum(q.passages_in)::INTEGER AS towards_first,",
    "       sum(q.passages_out)::INTEGER AS towards_second,",
    "       any_value(c.geom) AS geom",
    "FROM counts AS q",
    "JOIN counters AS c ON c.counter = q.counter",
    `WHERE q.quarter_hour >= TIMESTAMP '${WEEK.from}' AND q.quarter_hour < TIMESTAMP '${WEEK.to}'`,
    "GROUP BY ALL",
    // The busiest drawn first, so a quiet counter beside a busy one stays
    // in sight on top of it.
    "ORDER BY passages DESC",
  ].join("\n"),
});
const modePaint = await api.post(`/api/layers/${hours.id}/fill`, { attribute: "mode", method: "categorical", palette: "bold" });
const sizes = await api.post(`/api/layers/${hours.id}/scale`, { attribute: "passages", range: [2, 30] });
await patchLayer(hours.id, {
  style: {
    ...hours.style,
    fill: { ...modePaint, map: Object.entries(MODES).map(([value, color]) => ({ value, color })) },
    fillOpacity: 0.55,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 1,
    strokeOpacity: 0.9,
    pointRadius: 2,
    pointRadiusBy: sizes,
  },
  tooltip: ["counter", "mode", "hour", "passages", "towards_first", "towards_second"],
  filters: [{ field: "hour", kind: "timerange", min: OPENING.min, max: OPENING.max }],
  legendTitle: "Passages in the hour",
});

const widget = (id, type, title, more) => ({
  id, type, layerId: hours.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  // The city from Oerlikon in the north to the lake's west shore.
  viewport: { lng: 8.53, lat: 47.374, zoom: 12.35, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [hours.id, places.id],
  layerOrder: [places.id, hours.id],
  timeline: { layerId: hours.id, field: "hour", speed: 1 },
  widgets: [
    widget("widget-passages", "formula", "Passages", { field: "passages", agg: "sum", format: "integer", note: "Counted in the hours shown" }),
    widget("widget-time", "category", "Time of day", { field: "time_of_day", agg: "sum", aggField: "passages" }),
    widget("widget-counter", "category", "Busiest counters", { field: "counter", agg: "sum", aggField: "passages" }),
    widget("widget-mode", "category", "Bicycles or pedestrians", { field: "mode", agg: "sum", aggField: "passages" }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      note: creditNote(facts, {
        [counts.name]:
          `Every quarter hour of ${record.slice.year} at the city's 28 counters, read on ${record.sources.counts.fetchedAt.slice(0, 10)}; modified: the two directions added up. ` +
          "[data.stadt-zuerich.ch](https://data.stadt-zuerich.ch/dataset/ted_taz_verkehrszaehlungen_werte_fussgaenger_velo)",
        [sites.name]:
          "Names and places of the counters. [data.stadt-zuerich.ch](https://data.stadt-zuerich.ch/dataset/geo_standorte_der_automatischen_fuss__und_velozaehlungen)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { places: places.id, hours: hours.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
