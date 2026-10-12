// Author "Ships through the Strait of Hormuz in 2026" on a scratch Dezfil
// through its documented API: the project, the five datasets, the map with
// its six layers built by SQL, their styles, the timeline over the strait's
// days, the widgets, what happened and the credit note.
//
//   node templates/strait-of-hormuz/author.mjs http://127.0.0.1:3821 [work folder]
//
// Reads the build's output and writes <work>/strait-of-hormuz/authored.json.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3821");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "strait-of-hormuz");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [portwatch, worldBank, osm, naturalEarth] = facts.sources;
const { figures } = record;

// The same days of two years: 1 March to 2 October, the last day both of
// PortWatch's series hold.
const BEFORE = ["2025-03-01", "2025-10-02"];
const AFTER = ["2026-03-01", "2026-10-02"];
// A port needs this many calls on the 2025 days for its change to be read.
const FEWEST_CALLS = 30;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// Red for ports that lost their ships, blue for ports that gained, a
// neutral grey between; each reads on the light and the dark basemap.
const CHANGE = {
  "Down 75% or more": rgb("#B2182B"),
  "Down 50 to 75%": rgb("#D6604D"),
  "Down 25 to 50%": rgb("#F4A582"),
  "Within 25%": rgb("#9E9E9E"),
  "Up 25 to 100%": rgb("#6BAED6"),
  "Up 100% or more": rgb("#2171B5"),
  "Too few calls to compare": rgb("#C8C8C8"),
};
// One size scale for every ring and dot: ships a day, area-true, up to the
// strait's busiest day in the series.
const SIZE = { domain: [0, figures.busiest_day_ships], range: [1, 46] };

const change = (now, then) => `round(100 * (${now} - ${then}) / ${then})`;
const signed = (pct) => `CASE WHEN ${pct} >= 0 THEN '+' ELSE '−' END || CAST(abs(${pct}) AS INTEGER) || '%'`;
const between = ([a, b]) => `day BETWEEN DATE '${a}' AND DATE '${b}'`;

// Each port's calls a day over the two stretches of days.
const PORT_RATES = [
  "WITH rates AS (",
  "  SELECT portid,",
  `         avg(calls) FILTER (WHERE ${between(BEFORE)}) AS y2025,`,
  `         avg(calls) FILTER (WHERE ${between(AFTER)}) AS y2026,`,
  `         sum(calls) FILTER (WHERE ${between(BEFORE)}) AS calls_before`,
  "  FROM port_calls",
  "  GROUP BY portid)",
].join("\n");

const RINGS_SQL = [
  "WITH strait AS (",
  `  SELECT avg(ships) FILTER (WHERE ${between(BEFORE)}) AS y2025,`,
  `         avg(ships) FILTER (WHERE ${between(AFTER)}) AS y2026,`,
  "         any_value(geom) AS geom",
  "  FROM strait_transits),",
  PORT_RATES.replace(/^WITH /, ""),
  "SELECT 'Strait of Hormuz' AS place, 'Ships through the strait' AS counted,",
  "       round(y2025, 1) AS a_day_2025, round(y2026, 1) AS a_day_2026,",
  `       'Strait of Hormuz ' || ${signed(change("y2026", "y2025"))} AS label,`,
  "       geom",
  "FROM strait",
  "UNION ALL",
  "SELECT p.port, 'Calls at the port', round(r.y2025, 1), round(r.y2026, 1),",
  `       CASE WHEN r.y2025 >= 1 AND r.calls_before >= ${FEWEST_CALLS} THEN p.port || ' ' || ${signed(change("r.y2026", "r.y2025"))} END,`,
  "       p.geom",
  "FROM ports AS p JOIN rates AS r USING (portid)",
].join("\n");

const DOTS_SQL = [
  PORT_RATES + ",",
  "rated AS (",
  "  SELECT p.port, p.country, p.sea, r.y2025, r.y2026, r.calls_before,",
  `         CASE WHEN r.calls_before >= ${FEWEST_CALLS} THEN ${change("r.y2026", "r.y2025")} END AS change_pct,`,
  "         p.geom",
  "  FROM ports AS p JOIN rates AS r USING (portid))",
  "SELECT port, country, sea,",
  "       round(y2025, 1) AS calls_a_day_2025,",
  "       round(y2026, 1) AS calls_a_day_2026,",
  "       change_pct,",
  "       CASE WHEN change_pct IS NULL THEN 'Too few calls to compare'",
  "            WHEN change_pct <= -75 THEN 'Down 75% or more'",
  "            WHEN change_pct <= -50 THEN 'Down 50 to 75%'",
  "            WHEN change_pct <= -25 THEN 'Down 25 to 50%'",
  "            WHEN change_pct < 25 THEN 'Within 25%'",
  "            WHEN change_pct < 100 THEN 'Up 25 to 100%'",
  "            ELSE 'Up 100% or more' END AS change,",
  "       geom",
  "FROM rated",
  "ORDER BY y2025",
].join("\n");

// One row for every ship PortWatch counted through the strait, by its
// type, on the day it crossed; each carries the day's total, which sizes
// the dot. The timeline's bars count these rows: ships a day.
const TYPES = [
  ["Tanker", "tanker"],
  ["Container ship", "container"],
  ["Dry bulk carrier", "dry_bulk"],
  ["General cargo ship", "general_cargo"],
  ["Ro-ro ship", "roro"],
];
// The timeline runs from 1 July 2025: eight months of the usual traffic
// before 28 February, at about 20,000 rows rather than 37,000 for all of
// 2025 (the rows travel to the browser whole).
const TIMELINE_FROM = "2025-07-01";
const TRANSITS_SQL = [
  "WITH by_type AS (",
  TYPES.map(([label, column]) => `  SELECT day, ships, geom, '${label}' AS ship_type, ${column} AS n FROM strait_transits WHERE day >= DATE '${TIMELINE_FROM}'`).join("\n  UNION ALL\n"),
  ")",
  "SELECT day, ship_type, ships_that_day, geom",
  "FROM (SELECT day, ship_type, ships AS ships_that_day, geom, unnest(range(n)) AS one FROM by_type)",
  "ORDER BY day",
].join("\n");

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["strait_transits", "ports", "port_calls", "shipping_lanes", "separation_schemes"]) {
  const table = await api.upload(`${name}.parquet`, await readFile(path.join(work, record.outputs[name].file)), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

// The lanes: cells with fewer than ten million positions in six years are
// stray signals, mostly over land, and are left out. The colour fades in
// with the traffic on a logarithmic scale, so the busy lanes stand out and
// the open sea is a haze; a single blue reads on either basemap.
const lanes = await addLayer({ name: "Usual shipping lanes, 2015 to 2021", sql: "SELECT positions, geom FROM shipping_lanes WHERE positions >= 10000000" });
const lanePaint = await api.post(`/api/layers/${lanes.id}/fill`, { attribute: "positions", method: "continuous", palette: "blues" });
const LANE_STOPS = [["#9ECAE1", 0.06], ["#6BAED6", 0.25], ["#4292C6", 0.5], ["#2B83C6", 0.75], ["#1C6FB8", 0.95]];
await patchLayer(lanes.id, {
  style: {
    ...lanes.style,
    fill: { ...lanePaint, log: true, clamp: [2e8, 1.2e10], stops: LANE_STOPS.map(([hex, a]) => rgb(hex, a)) },
    fillOpacity: 0.85,
    strokeWidth: 0,
  },
  tooltip: ["positions"],
  legendTitle: "Usual lanes: commercial ships' positions, 2015 to 2021",
});

const schemes = await addLayer({ name: "Traffic separation schemes", sql: "SELECT part, geom FROM separation_schemes" });
await patchLayer(schemes.id, {
  style: { ...schemes.style, stroke: rgb("#5B6B7A"), strokeWidth: 1, strokeOpacity: 0.9 },
  tooltip: ["part"],
  legendTitle: "Traffic separation schemes",
});

const dots = await addLayer({ name: "Port calls a day since 1 March 2026", sql: DOTS_SQL });
const changePaint = await api.post(`/api/layers/${dots.id}/fill`, { attribute: "change", method: "categorical", palette: "bold" });
await patchLayer(dots.id, {
  style: {
    ...dots.style,
    fill: { ...changePaint, map: Object.entries(CHANGE).map(([value, color]) => ({ value, color })), other: CHANGE["Too few calls to compare"] },
    fillOpacity: 0.95,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0.8,
    strokeOpacity: 0.9,
    pointRadiusBy: { attribute: "calls_a_day_2026", ...SIZE },
  },
  tooltip: ["port", "country", "sea", "calls_a_day_2025", "calls_a_day_2026", "change_pct"],
  legendTitle: "Port calls a day, 1 March to 2 October 2026, against the same days of 2025",
});

const strait = await addLayer({ name: "Ships through the strait each day", sql: TRANSITS_SQL });
await patchLayer(strait.id, {
  style: {
    ...strait.style,
    fill: { type: "constant", color: CHANGE["Down 75% or more"] },
    fillOpacity: 0.9,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0.8,
    strokeOpacity: 0.9,
    pointRadiusBy: { attribute: "ships_that_day", ...SIZE },
  },
  tooltip: ["day", "ships_that_day", "ship_type"],
  // The window opens on the last week of data; play runs it from January 2025.
  filters: [{ field: "day", kind: "timerange", min: "2026-09-28", max: "2026-10-04" }],
  legendTitle: "Ships through the strait each day (the timeline's window)",
});

const rings = await addLayer({ name: "A day, 1 March to 2 October 2025", sql: RINGS_SQL });
await patchLayer(rings.id, {
  style: {
    ...rings.style,
    fill: { type: "constant", color: rgb("#FFFFFF", 0) },
    fillOpacity: 0,
    stroke: rgb("#6E7781"),
    strokeWidth: 1.4,
    strokeOpacity: 0.95,
    pointRadiusBy: { attribute: "a_day_2025", ...SIZE },
    // The labels ride the top layer, so no ring or dot covers them: the
    // change at the strait and at every port with a call a day in 2025,
    // the busiest first.
    label: {
      attribute: "label",
      size: 12,
      color: rgb("#FFFFFF"),
      haloWidth: 1,
      haloColor: rgb("#1D1F24"),
      weight: "bold",
      anchor: "right",
      offsetX: 8,
      priorityField: "a_day_2025",
    },
  },
  tooltip: ["place", "counted", "a_day_2025", "a_day_2026"],
  legendTitle: "Ships a day, 1 March to 2 October 2025",
});

// What happened, in PortWatch's own figures from the data as built.
const [d27, d28, d1, d2, , d4] = figures.around_28_february;
const fmtDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
const happened = [
  `28 February 2026: the United States and Israel strike Iran. PortWatch counted ${d27.ships} ships through the Strait of Hormuz on ${fmtDay(d27.day)}, ${d28.ships} on ${fmtDay(d28.day)}, ${d1.ships} on ${fmtDay(d1.day)}, ${d2.ships} on ${fmtDay(d2.day)} and ${d4.ships === 0 ? "none" : d4.ships} on ${fmtDay(d4.day)}. Across 2025 it counted ${figures.transits_a_day_2025} a day.`,
  `From 1 March to 2 October 2026 it counted ${figures.strait_2026} a day, against ${figures.strait_2025} on the same days of 2025, and ${figures.days_without_a_transit} days with none at all.`,
  "Most ports inside the strait lost most of their calls; some outside it gained. The rings are the ships a day on the 2025 days, the dots the same days of 2026.",
  "The counts come from ships' AIS transponders. PortWatch writes: \"Due to the ongoing conflict in the Strait of Hormuz, there are reports of GPS jamming, AIS spoofing, and vessels going dark.\" It names possible anomalies on 27 and 28 April 2026. A port call is a ship's arrival at berth, bunkering stops left out. A ship crossing with its transponder off is not counted: the counts are a floor, not all the traffic.",
  "Data to 4 October 2026 for the strait and 2 October for the ports. Context: Wikipedia, 2026 Strait of Hormuz crisis.",
].join("\n\n");
if (happened.length > 2000) throw new Error(`What happened is ${happened.length} characters; a note holds 2000.`);

const widget = (id, type, title, layerId, more) => ({
  id, type, layerId, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
const read = record.builtAt.slice(0, 10);
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: 50.0, lat: 23.4, zoom: 4.95, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  layerOrder: [lanes.id, schemes.id, dots.id, strait.id, rings.id],
  legendOrder: [dots.id, rings.id, strait.id, lanes.id, schemes.id],
  timeline: { layerId: strait.id, field: "day", speed: 1 },
  widgets: [
    widget("widget-strait", "formula", "Ships through the strait", strait.id, { format: "integer", note: "In the timeline's window, as AIS counts them" }),
    widget("widget-types", "category", "Of which", strait.id, { field: "ship_type" }),
    widget("widget-sea", "category", "Port calls a day in 2026, by sea", dots.id, { field: "sea", agg: "sum", aggField: "calls_a_day_2026" }),
    widget("widget-after", "formula", "Port calls a day, 1 March to 2 October 2026", dots.id, { field: "calls_a_day_2026", agg: "sum", format: "integer" }),
    widget("widget-before", "formula", "The same days of 2025", dots.id, { field: "calls_a_day_2025", agg: "sum", format: "integer" }),
    widget("widget-happened", "note", "What happened", null, { note: happened }),
    widget("widget-sources", "note", "Sources", null, {
      note: creditNote(facts, {
        [portwatch.name]:
          `Source: International Monetary Fund, PortWatch, Daily Chokepoints Data, Daily Ports Data and Ports, [portwatch.imf.org](https://portwatch.imf.org), read ${read}. ` +
          "Changed by this template: daily figures averaged over named days, and each day's transits unrolled into one row a ship.",
        [worldBank.name]: "[datacatalog.worldbank.org, dataset 0037580](https://datacatalog.worldbank.org/search/dataset/0037580); summed into H3 cells.",
        [osm.name]: `As of ${read}. [openstreetmap.org/copyright](https://www.openstreetmap.org/copyright)`,
        [naturalEarth.name]: "Names the sea each port lies on.",
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { lanes: lanes.id, schemes: schemes.id, dots: dots.id, strait: strait.id, rings: rings.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
