// Author "Charging Germany's cars" on a scratch Dezfil through its
// documented API: the project, the charging stations, the counties and
// their people, the map with the counties shaded by charge points per
// person and the fastest stations on a timeline, their styles, the
// widgets and the credit note.
//
//   node templates/charging-germany/author.mjs http://127.0.0.1:3801 [work folder]
//
// Reads the build's output and writes <work>/charging-germany/authored.json
// (the project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3801");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "charging-germany");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [bnetza, overture, kontur] = facts.sources;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });

// Charge points per 10,000 people: half the counties have between 18 and
// 30, a tenth fewer than 15, and a few car-making towns more than 60.
const BREAKS = [15, 20, 25, 30, 40, 60];
const SHADES = ["#EDF3FA", "#C9DCEF", "#9DC3E3", "#6BA3D2", "#3F80BF", "#1F5D9E", "#0B3A6E"];
// The fastest stations, 150 kW or more: those a long drive stops at.
const FAST_KW = 150;

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["chargers", "counties", "county_population"]) {
  const file = path.join(work, record.outputs[name].file);
  const table = await api.upload(`${name}.parquet`, await readFile(file), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

// The counties: every station counted in the county it stands in, by a
// spatial join in the layer's SQL, beside the county's people.
const counties = await addLayer({
  name: "Charge points per 10,000 people",
  sql: [
    "WITH per_county AS (",
    "  SELECT c.division,",
    "         count(s.station) AS stations,",
    "         coalesce(sum(s.charge_points), 0) AS charge_points,",
    "         coalesce(sum(s.power_kw), 0) AS kilowatts",
    "  FROM counties AS c",
    "  LEFT JOIN chargers AS s ON ST_Intersects(c.geom, s.geom)",
    "  GROUP BY c.division",
    ")",
    "SELECT c.county,",
    "       p.population,",
    "       x.stations,",
    "       x.charge_points::INTEGER AS charge_points,",
    "       round(x.kilowatts / 1000, 1) AS megawatts,",
    "       round(10000.0 * x.charge_points / p.population, 1) AS per_10000_people,",
    "       c.geom",
    "FROM counties AS c",
    "JOIN county_population AS p ON p.division = c.division",
    "JOIN per_county AS x ON x.division = c.division",
  ].join("\n"),
});
const shades = await api.post(`/api/layers/${counties.id}/fill`, { attribute: "per_10000_people", method: "quantile", palette: "blues", classes: SHADES.length });
await patchLayer(counties.id, {
  style: {
    ...counties.style,
    fill: { ...shades, method: "custom", baseMethod: "quantile", breaks: BREAKS, colors: SHADES.map((hex) => rgb(hex)) },
    fillOpacity: 0.85,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0.4,
    strokeOpacity: 0.7,
  },
  tooltip: ["county", "per_10000_people", "charge_points", "stations", "megawatts", "population"],
  legendTitle: "Public charge points per 10,000 people",
});

// The fastest stations, one point each, on a timeline by the day each
// went into service.
const fast = await addLayer({
  name: `Stations of ${FAST_KW} kW or more`,
  sql: [
    "SELECT operator, power_kw, charge_points, commissioned, street, town, geom",
    "FROM chargers",
    `WHERE power_kw >= ${FAST_KW}`,
    "ORDER BY commissioned",
  ].join("\n"),
});
await patchLayer(fast.id, {
  style: {
    ...fast.style,
    // Small and unrimmed: at the country's scale 23,000 stations would
    // otherwise cover the counties beneath them.
    fill: { type: "constant", color: rgb("#F2542D") },
    fillOpacity: 0.85,
    stroke: rgb("#FFFFFF"),
    strokeWidth: 0,
    strokeOpacity: 0,
    pointRadius: 0.8,
  },
  tooltip: ["operator", "power_kw", "charge_points", "commissioned", "street", "town"],
  filters: [{ field: "commissioned", kind: "timerange", min: null, max: null }],
  legendTitle: `A station of ${FAST_KW} kW or more`,
});

const widget = (id, type, title, layerId, more) => ({
  id, type, layerId, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
const asOf = new Date(`${record.slice.registerDate}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: 10.4, lat: 51.15, zoom: 5.45, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [fast.id, counties.id],
  layerOrder: [counties.id, fast.id],
  timeline: { layerId: fast.id, field: "commissioned", speed: 1 },
  widgets: [
    widget("widget-points", "formula", "Public charge points", counties.id, { field: "charge_points", agg: "sum", format: "integer", note: `In the register on ${asOf}` }),
    widget("widget-power", "formula", "Charging power", counties.id, { field: "megawatts", agg: "sum", format: "integer", unit: "MW" }),
    widget("widget-fast", "formula", `Stations of ${FAST_KW} kW or more`, fast.id, { format: "integer", note: "In service in the period shown" }),
    widget("widget-operators", "category", "Who runs the fastest stations", fast.id, { field: "operator" }),
    widget("widget-per-person", "histogram", "Counties by charge points per 10,000 people", counties.id, { field: "per_10000_people" }),
    widget("widget-sources", "note", "Sources", null, {
      note: creditNote(facts, {
        [bnetza.name]: `The list as of ${asOf}; modified: the stations' own columns kept, their kinds named in English. [bundesnetzagentur.de](https://www.bundesnetzagentur.de/ladesaeulenkarte)`,
        [overture.name]: `Release ${record.sources.overture.release}; outlines simplified to about 100 m. [overturemaps.org](https://overturemaps.org)`,
        [kontur.name]: "Release 2023-11-01, summed by county. [data.humdata.org](https://data.humdata.org/dataset/kontur-population-germany)",
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { counties: counties.id, fast: fast.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
