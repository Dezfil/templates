// Author "Kruger's elephants and the heat" on a scratch Dezfil through its
// documented API: the project, the fixes, the map with its one layer built
// by SQL, its style, the timeline, the widgets and the credit note.
//
//   node templates/kruger-elephants/author.mjs http://127.0.0.1:3811 [work folder]
//
// Reads the build's output and writes <work>/kruger-elephants/authored.json
// (the project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3811");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "kruger-elephants");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [movebank] = facts.sources;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// The temperature the collar measured, cool to hot, readable on the light
// and the dark basemap alike.
const HEAT = {
  "Under 20 °C": rgb("#2B54A8"),
  "20 to 25 °C": rgb("#3B9AD0"),
  "25 to 30 °C": rgb("#E8C21C"),
  "30 to 35 °C": rgb("#F0812A"),
  "35 °C and hotter": rgb("#D7263D"),
};

// The tracks are built in the layer's SQL from the 283,688 fixes: each
// herd's track is cut into stretches of one temperature band, a stretch
// running on to the next one's first fix so the track draws unbroken, and
// broken where the collar missed more than three hours. Each stretch
// carries when it started (the timeline), the part of the day, its hours,
// the kilometres between its fixes in a straight line and so its speed.
// Hotter stretches draw on top.
const STRETCHES_SQL = [
  "WITH f AS (",
  "  SELECT herd, time_local, temperature_c, geom,",
  "         CASE WHEN temperature_c < 20 THEN 0 WHEN temperature_c < 25 THEN 1 WHEN temperature_c < 30 THEN 2",
  "              WHEN temperature_c < 35 THEN 3 ELSE 4 END AS heat_rank",
  "  FROM elephant_fixes),",
  "p AS (",
  "  SELECT *,",
  "         lag(heat_rank) OVER w AS before_rank,",
  "         lag(time_local) OVER w AS before_time,",
  "         lead(time_local) OVER w AS next_time,",
  "         lead(geom) OVER w AS next_geom",
  "  FROM f WINDOW w AS (PARTITION BY herd ORDER BY time_local)),",
  "r AS (",
  "  SELECT *,",
  "         sum(CAST(before_rank IS NULL OR before_rank <> heat_rank OR time_local - before_time > INTERVAL 3 HOUR AS INTEGER))",
  "           OVER (PARTITION BY herd ORDER BY time_local ROWS UNBOUNDED PRECEDING) AS stretch,",
  "         coalesce(next_time - time_local <= INTERVAL 3 HOUR, false) AS joined",
  "  FROM p),",
  "steps AS (",
  "  SELECT *,",
  "         CASE WHEN joined THEN sqrt(power((ST_X(next_geom) - ST_X(geom)) * 111.32 * cos(radians(ST_Y(geom))), 2)",
  "                                    + power((ST_Y(next_geom) - ST_Y(geom)) * 110.57, 2)) END AS step_km,",
  "         CASE WHEN joined THEN epoch(next_time - time_local) / 3600 END AS step_hours",
  "  FROM r),",
  "vertices AS (",
  "  SELECT herd, stretch, time_local, geom FROM steps",
  "  UNION ALL",
  "  SELECT herd, stretch, next_time, next_geom FROM (",
  "    SELECT herd, stretch, time_local, next_time, next_geom, joined,",
  "           row_number() OVER (PARTITION BY herd, stretch ORDER BY time_local DESC) AS from_end",
  "    FROM steps) WHERE from_end = 1 AND joined),",
  "lines AS (",
  "  SELECT herd, stretch, ST_MakeLine(list(geom ORDER BY time_local)) AS geom",
  "  FROM vertices GROUP BY herd, stretch HAVING count(*) >= 2)",
  "SELECT s.herd,",
  "       CASE any_value(heat_rank) WHEN 0 THEN 'Under 20 \u00b0C' WHEN 1 THEN '20 to 25 \u00b0C' WHEN 2 THEN '25 to 30 \u00b0C'",
  "            WHEN 3 THEN '30 to 35 \u00b0C' ELSE '35 \u00b0C and hotter' END AS heat,",
  "       any_value(heat_rank) AS heat_rank,",
  "       min(time_local) AS started,",
  "       CASE WHEN hour(min(time_local)) BETWEEN 6 AND 10 THEN 'Morning, 6 to 11 am'",
  "            WHEN hour(min(time_local)) BETWEEN 11 AND 15 THEN 'Midday, 11 am to 4 pm'",
  "            WHEN hour(min(time_local)) BETWEEN 16 AND 19 THEN 'Evening, 4 to 8 pm'",
  "            ELSE 'Night, 8 pm to 6 am' END AS part_of_day,",
  "       round(sum(step_hours), 2) AS hours,",
  "       round(sum(step_km), 2) AS km,",
  "       round(sum(step_km) / nullif(sum(step_hours), 0), 2) AS speed_kmh,",
  "       any_value(l.geom) AS geom",
  "FROM steps s JOIN lines l USING (herd, stretch)",
  "GROUP BY s.herd, s.stretch",
  "ORDER BY heat_rank, started",
].join("\n");

// The window the map opens on, and the camera: three herds north-west of
// Satara, where the hot stretches run straight into the places they drink.
const WINDOW = ["2008-10-10 00:00:00", "2008-10-24 00:00:00"];

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
const name = "elephant_fixes";
const table = await api.upload(`${name}.parquet`, await readFile(path.join(work, record.outputs[name].file)), project.id);
if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
  throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

const tracks = await addLayer({ name: "Herd tracks, by temperature", sql: STRETCHES_SQL });
const paint = await api.post(`/api/layers/${tracks.id}/fill`, { attribute: "heat", method: "categorical", palette: "bold" });
await patchLayer(tracks.id, {
  style: {
    ...tracks.style,
    strokeBy: { ...paint, map: Object.entries(HEAT).map(([value, color]) => ({ value, color })) },
    strokeWidth: 1,
    strokeWidthBy: { attribute: "heat_rank", domain: [0, 4], range: [0.9, 1.6] },
    strokeOpacity: 0.9,
  },
  tooltip: ["herd", "heat", "started", "part_of_day", "hours", "km", "speed_kmh"],
  // The map opens on two weeks of October 2008, the hottest month of the
  // two years, late in the dry season; the timeline moves the window.
  filters: [{ field: "started", kind: "timerange", min: WINDOW[0], max: WINDOW[1] }],
  legendTitle: "Temperature at the collar",
});

const widget = (id, type, title, more) => ({
  id, type, layerId: tracks.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
const read = record.sources.fixes.fetchedAt.slice(0, 10);
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: 31.715, lat: -24.275, zoom: 11.4, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [tracks.id],
  layerOrder: [tracks.id],
  timeline: { layerId: tracks.id, field: "started", speed: 1 },
  widgets: [
    widget("widget-speed", "formula", "Average speed", { agg: "avg", field: "speed_kmh", unit: "km/h", format: "decimal2", note: "Per stretch, fix to fix in a straight line" }),
    widget("widget-heat", "category", "Hours at each temperature", { field: "heat", agg: "sum", aggField: "hours" }),
    widget("widget-day", "category", "Kilometres by part of the day", { field: "part_of_day", agg: "sum", aggField: "km" }),
    widget("widget-herd", "category", "Kilometres by herd", { field: "herd", agg: "sum", aggField: "km" }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      note: creditNote(facts, {
        [movebank.name]:
          `The GPS fixes of 14 herds, every 30 minutes from August 2007 to August 2009, with the temperature at each collar, read on ${read}. Modified: times moved from UTC to South African time; the map's SQL joins the fixes into tracks. ` +
          "Described in Thaker M, Gupte PR, Prins HHT, Slotow R, Vanak AT (2019), Frontiers in Ecology and Evolution 7:4, [doi:10.3389/fevo.2019.00004](https://doi.org/10.3389/fevo.2019.00004).",
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { tracks: tracks.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
