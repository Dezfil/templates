// Author "Where New York's taxis go" on a scratch Dezfil through its
// documented API: the project, both datasets, the map with its zones and its
// arcs, whose SQL aggregates the month's trips, their styles, the widgets and
// the credit note.
//
//   node templates/nyc-taxis/author.mjs http://127.0.0.1:3771 [work folder]
//
// Reads the build's output and writes <work>/nyc-taxis/authored.json
// (the project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3771");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "nyc-taxis");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [tlc] = facts.sources;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
const ZONE_EDGE = rgb("#8C93A0");

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["trips", "taxi_zones"]) {
  const file = path.join(work, record.outputs[name].file);
  const table = await api.upload(`${name}.parquet`, await readFile(file), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

// The zones, coloured by the month's pickups.
const ZONES_SQL = `SELECT z.zone, z.borough, coalesce(p.pickups, 0) AS pickups, z.geom
FROM taxi_zones z
LEFT JOIN (
  SELECT pickup_zone, count(*) AS pickups FROM trips GROUP BY pickup_zone
) p ON p.pickup_zone = z.location_id`;
const zones = await addLayer({ name: "Taxi zones, by pickups", sql: ZONES_SQL });
const pickupPaint = await api.post(`/api/layers/${zones.id}/fill`, { attribute: "pickups", method: "quantile", palette: "blues", classes: 6 });
await patchLayer(zones.id, {
  style: {
    ...zones.style,
    fill: pickupPaint,
    fillOpacity: 0.35,
    stroke: ZONE_EDGE,
    strokeOpacity: 0.5,
    strokeWidth: 0.5,
  },
  tooltip: ["zone", "borough", "pickups"],
  legendTitle: "Pickups in August 2026",
});

// The arcs: 3.3 million trips counted between every pair of zones, both
// ways together, in five parts of the day, then drawn between the zones'
// centres. A pair is kept when it saw at least 31 trips in that part of the
// day in the month, about one a day.
const ARCS_SQL = `WITH centres AS (
  SELECT location_id, zone || ', ' || borough AS place, borough, service_zone,
         ST_Centroid(geom) AS centre
  FROM taxi_zones
),
pairs AS (
  SELECT
    least(pickup_zone, dropoff_zone) AS a,
    greatest(pickup_zone, dropoff_zone) AS b,
    CASE
      WHEN pickup_hour < 6 THEN 'Night'
      WHEN pickup_hour < 10 THEN 'Morning rush'
      WHEN pickup_hour < 16 THEN 'Midday'
      WHEN pickup_hour < 20 THEN 'Evening rush'
      ELSE 'Late evening'
    END AS time_of_day,
    count(*) AS trips,
    round(avg(fare) FILTER (WHERE fare > 0), 2) AS average_fare
  FROM trips
  WHERE pickup_zone <> dropoff_zone
  GROUP BY ALL
  HAVING count(*) >= 31
)
SELECT
  ca.place AS one_end,
  cb.place AS other_end,
  p.time_of_day,
  p.trips,
  p.average_fare,
  CASE
    WHEN ca.service_zone IN ('Airports', 'EWR') OR cb.service_zone IN ('Airports', 'EWR') THEN 'Airport'
    WHEN ca.borough = 'Manhattan' AND cb.borough = 'Manhattan' THEN 'In Manhattan'
    WHEN ca.borough = 'Manhattan' OR cb.borough = 'Manhattan' THEN 'Cross-borough'
    ELSE 'Outer boroughs'
  END AS route,
  ca.centre AS one_end_centre,
  cb.centre AS other_end_centre
FROM pairs p
JOIN centres ca ON ca.location_id = p.a
JOIN centres cb ON cb.location_id = p.b
ORDER BY p.trips`;
const arcs = await addLayer({ name: "Taxi trips between zones", sql: ARCS_SQL });
// Colour and width both follow the trips, on a log scale for the colour;
// the ramp fades toward its quiet end, so the thousands of small pairs stay
// a haze and the busy ones stand out.
const tripPaint = await api.post(`/api/layers/${arcs.id}/fill`, { attribute: "trips", method: "continuous", palette: "global_warming" });
const FADE = [0.1, 0.2, 0.4, 0.7, 0.9, 1];
if (tripPaint.stops.length !== FADE.length) throw new Error(`The ramp has ${tripPaint.stops.length} stops; the fade names ${FADE.length}.`);
const widths = await api.post(`/api/layers/${arcs.id}/scale`, { attribute: "trips", range: [0.4, 8] });
await patchLayer(arcs.id, {
  viz: {
    type: "arc",
    origin: { kind: "geometry", field: "one_end_centre" },
    dest: { kind: "geometry", field: "other_end_centre" },
    height: 0.3,
  },
  style: {
    ...arcs.style,
    strokeBy: { ...tripPaint, log: true, stops: tripPaint.stops.map((c, i) => ({ ...c, a: FADE[i] })) },
    strokeOpacity: 1,
    strokeWidth: 0.4,
    strokeWidthBy: widths,
  },
  tooltip: ["one_end", "other_end", "time_of_day", "trips", "average_fare"],
  legendTitle: "Trips between two zones",
  legendAttrs: { stroke: "trips", width: "trips" },
});

const widget = (id, type, title, more) => ({
  id, type, layerId: arcs.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  // Up Manhattan's avenues: LaGuardia ahead, JFK to the right.
  viewport: { lng: -73.885, lat: 40.72, zoom: 10.8, pitch: 45, bearing: 29 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [arcs.id, zones.id],
  layerOrder: [zones.id, arcs.id],
  widgets: [
    widget("widget-trips", "formula", "Trips", { agg: "sum", field: "trips", note: "On the arcs drawn, August 2026", format: "integer" }),
    widget("widget-time", "category", "Part of the day", { field: "time_of_day", agg: "sum", aggField: "trips" }),
    widget("widget-route", "category", "Where the trip runs", { field: "route", agg: "sum", aggField: "trips" }),
    widget("widget-fare", "histogram", "Average fare on the arc, $", { field: "average_fare" }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      note: creditNote(facts, {
        [tlc.name]: `Yellow taxi trip records of August 2026 (yellow_tripdata_2026-08.parquet) and the taxi zone shapefile and lookup table, read on ${record.sources.trips.fetchedAt.slice(0, 10)}. Modified: only the zones, the pickup hour and the fare kept; trips counted by pair of zones in the map's SQL. [TLC Trip Record Data](https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page)`,
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { zones: zones.id, arcs: arcs.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
