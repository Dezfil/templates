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
// The ports drawn: those with at least a call a day on the 2025 days. The
// small ones crowd the Emirates' coast and say little at this scale; their
// calls stay in the data.
const FEWEST_A_DAY = 1;
// The ports labelled, and ringed with their 2025 calls: in each of the
// UAE, Iran, Iraq and Saudi Arabia, the port inside the strait that lost
// the most calls a day; and the three ports on the Red Sea, the Gulf of
// Oman and the Arabian Sea that gained the most.
const FALLS_IN = ["United Arab Emirates", "Iran", "Iraq", "Saudi Arabia"];
const SEAWARD = ["Red Sea", "Gulf of Oman", "Arabian Sea"];
const GAINS = 3;

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
};
// One size scale for every ring and dot: ships a day, area-true, up to the
// strait's busiest day in the series.
const SIZE = { domain: [0, figures.busiest_day_ships], range: [1, 46] };

// Where each label sits at the template's camera: its point moved by dx, dy
// pixels from the place, the label centred there, so that no label lies on
// another port's ring or dot where the Emirates' ports crowd. Labels and
// marks do not avoid each other, so the placement is set here.
const CAMERA = { lng: 50.0, lat: 23.4, zoom: 4.95 };
const LABEL_NUDGES = {
  "Strait of Hormuz": [128, 0],
  "Jebel Ali": [0, 52],
  "Bandar-E Pars Terminal": [0, -38],
  "Umm Qasr": [-112, 0],
  Jubail: [-93, 0],
  Duqm: [71, 0],
  Salalah: [93, 0],
  "Yanbu (King Fahd Port)": [172, 0],
};
// A point moved by dx, dy pixels at the camera's zoom, in Web Mercator.
const nudged = (column, nudges) => {
  const perDegree = (512 * 2 ** CAMERA.zoom) / 360;
  const cases = (i) => Object.entries(nudges).map(([text, d]) => `WHEN ${column} = '${text}' THEN ${d[i]}`).join(" ");
  const x = `CASE ${cases(0)} ELSE 0 END`;
  const y = `CASE ${cases(1)} ELSE 0 END`;
  const mercator = "degrees(ln(tan(pi() / 4 + radians(ST_Y(geom)) / 2)))";
  return `ST_Point(ST_X(geom) + (${x}) / ${perDegree}, degrees(2 * atan(exp(radians(${mercator} - (${y}) / ${perDegree}))) - pi() / 2)) AS geom`;
};

const change = (now, then) => `round(100 * (${now} - ${then}) / ${then})`;
const signed = (pct) => `CASE WHEN ${pct} >= 0 THEN '+' ELSE '−' END || CAST(abs(${pct}) AS INTEGER) || '%'`;
const between = ([a, b]) => `day BETWEEN DATE '${a}' AND DATE '${b}'`;

// Each port's calls a day over the two stretches of days.
const PORT_RATES = [
  "WITH rates AS (",
  "  SELECT portid,",
  `         avg(calls) FILTER (WHERE ${between(BEFORE)}) AS y2025,`,
  `         avg(calls) FILTER (WHERE ${between(AFTER)}) AS y2026`,
  "  FROM port_calls",
  "  GROUP BY portid),",
  "story AS (",
  "  SELECT portid FROM (",
  "    SELECT r.portid, row_number() OVER (PARTITION BY p.country ORDER BY r.y2025 - r.y2026 DESC) AS n",
  "    FROM ports AS p JOIN rates AS r USING (portid)",
  `    WHERE p.sea = 'The Gulf, inside the strait' AND p.country IN (${FALLS_IN.map((c) => `'${c}'`).join(", ")}) AND r.y2025 >= ${FEWEST_A_DAY})`,
  "  WHERE n = 1",
  "  UNION ALL",
  "  SELECT portid FROM (",
  "    SELECT r.portid, row_number() OVER (ORDER BY r.y2026 - r.y2025 DESC) AS n",
  "    FROM ports AS p JOIN rates AS r USING (portid)",
  `    WHERE p.sea IN (${SEAWARD.map((c) => `'${c}'`).join(", ")}) AND r.y2025 >= ${FEWEST_A_DAY} AND r.y2026 > r.y2025)`,
  `  WHERE n <= ${GAINS})`,
].join("\n");

// The strait and the story's ports, each with its 2025 and 2026 a day and
// its label; the rings layer draws them, the labels layer names them.
const STORY_ROWS = [
  "strait AS (",
  `  SELECT avg(ships) FILTER (WHERE ${between(BEFORE)}) AS y2025,`,
  `         avg(ships) FILTER (WHERE ${between(AFTER)}) AS y2026,`,
  "         any_value(geom) AS geom",
  "  FROM strait_transits),",
  "rows AS (",
  "  SELECT 'Strait of Hormuz' AS place, 'Ships through the strait' AS counted, y2025, y2026, geom FROM strait",
  "  UNION ALL",
  "  SELECT p.port, 'Calls at the port', r.y2025, r.y2026, p.geom",
  "  FROM ports AS p JOIN rates AS r USING (portid) JOIN story USING (portid))",
].join("\n");
const RINGS_SQL = [
  PORT_RATES + ",",
  STORY_ROWS,
  "SELECT place, counted, round(y2025, 1) AS a_day_2025, round(y2026, 1) AS a_day_2026, geom FROM rows",
].join("\n");
const LABELS_SQL = [
  PORT_RATES + ",",
  STORY_ROWS,
  `SELECT place || ' ' || ${signed(change("y2026", "y2025"))} AS label, ${nudged("place", LABEL_NUDGES)}`,
  "FROM rows",
].join("\n");

const DOTS_SQL = [
  PORT_RATES + ",",
  "rated AS (",
  "  SELECT p.port, p.country, p.sea, r.y2025, r.y2026,",
  `         ${change("r.y2026", "r.y2025")} AS change_pct,`,
  "         p.geom",
  "  FROM ports AS p JOIN rates AS r USING (portid)",
  `  WHERE r.y2025 >= ${FEWEST_A_DAY})`,
  "SELECT port, country, sea,",
  "       round(y2025, 1) AS calls_a_day_2025,",
  "       round(y2026, 1) AS calls_a_day_2026,",
  "       change_pct,",
  "       CASE WHEN change_pct <= -75 THEN 'Down 75% or more'",
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
    fill: { ...changePaint, map: Object.entries(CHANGE).map(([value, color]) => ({ value, color })), other: CHANGE["Within 25%"] },
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
    stroke: rgb("#C9D1D9"),
    strokeWidth: 1,
    strokeOpacity: 0.8,
    pointRadiusBy: { attribute: "a_day_2025", ...SIZE },
  },
  tooltip: ["place", "counted", "a_day_2025", "a_day_2026"],
  legendTitle: "Ships a day, 1 March to 2 October 2025, at the strait and the labelled ports",
});

// The labels: a layer of their own on top, out of the legend, its marks
// invisible, each label centred on its nudged point.
const labels = await addLayer({ name: "Labels", sql: LABELS_SQL });
await patchLayer(labels.id, {
  inLegend: false,
  style: {
    ...labels.style,
    fill: { type: "constant", color: rgb("#FFFFFF", 0) },
    fillOpacity: 0,
    strokeWidth: 0,
    pointRadius: 0,
    label: {
      attribute: "label",
      size: 12,
      color: rgb("#FFFFFF"),
      haloWidth: 1,
      haloColor: rgb("#1D1F24"),
      weight: "bold",
      anchor: "center",
    },
  },
  tooltip: [],
});

// What happened, in PortWatch's own figures from the data as built.
const [d27, d28, d1, d2, , d4] = figures.around_28_february;
const fmtDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
const happened = [
  `28 February 2026: the United States and Israel strike Iran. PortWatch counted ${d27.ships} ships through the Strait of Hormuz on ${fmtDay(d27.day)}, ${d28.ships} on ${fmtDay(d28.day)}, ${d1.ships} on ${fmtDay(d1.day)}, ${d2.ships} on ${fmtDay(d2.day)} and ${d4.ships === 0 ? "none" : d4.ships} on ${fmtDay(d4.day)}. Across 2025 it counted ${figures.transits_a_day_2025} a day.`,
  `From 1 March to 2 October 2026 it counted ${figures.strait_2026} a day, against ${figures.strait_2025} on the same days of 2025, and ${figures.days_without_a_transit} days with none at all.`,
  "Most ports inside the strait lost most of their calls; some outside it gained. The dots are the calls a day on the 2026 days at every port with a call a day or more in 2025; the rings, the same days of 2025 at the strait and the labelled ports.",
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
  viewport: { ...CAMERA, pitch: 0, bearing: 0 },
  // One basemap for both themes: on the dark style the white labels and
  // the blue lanes read the same way in either.
  basemap: "dark",
  legendCorner: "bottom-left",
  layerOrder: [lanes.id, schemes.id, dots.id, strait.id, rings.id, labels.id],
  legendOrder: [dots.id, rings.id, strait.id, lanes.id, schemes.id, labels.id],
  timeline: { layerId: strait.id, field: "day", speed: 1 },
  widgets: [
    widget("widget-strait", "formula", "Ships through the strait", strait.id, { format: "integer", note: "In the timeline's window, as AIS counts them" }),
    widget("widget-types", "category", "Of which", strait.id, { field: "ship_type" }),
    widget("widget-sea", "category", "Port calls a day in 2026, by sea", dots.id, { field: "sea", agg: "sum", aggField: "calls_a_day_2026" }),
    widget("widget-after", "formula", "Port calls a day, 1 March to 2 October 2026", dots.id, { field: "calls_a_day_2026", agg: "sum", format: "integer", note: "Ports with a call a day or more in 2025" }),
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
  layers: { lanes: lanes.id, schemes: schemes.id, dots: dots.id, strait: strait.id, rings: rings.id, labels: labels.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
