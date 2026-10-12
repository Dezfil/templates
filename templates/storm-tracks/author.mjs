// Author "Storm tracks since 1980" on a scratch Dezfil through its
// documented API: the project, the track points, the map with its one
// layer built by SQL, its style, the timeline, the widgets and the credit
// note.
//
//   node templates/storm-tracks/author.mjs http://127.0.0.1:3801 [work folder]
//
// Reads the build's output and writes <work>/storm-tracks/authored.json
// (the project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3801");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "storm-tracks");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [ibtracs] = facts.sources;

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });
// The Saffir-Simpson scale as storm maps draw it, cool to hot, readable on
// light and dark basemaps alike; the weak and non-tropical stretches fade.
const CATEGORY = {
  "Weaker or not tropical": rgb("#8C9AAE", 0.45),
  "Tropical storm": rgb("#3FA7D6"),
  "Category 1": rgb("#E9C31B"),
  "Category 2": rgb("#F39A1F"),
  "Category 3": rgb("#EA5F2A"),
  "Category 4": rgb("#D21F3C"),
  "Category 5": rgb("#B4148C"),
};

// The tracks are built in the layer's SQL from the 300,000 points: each
// storm's track is cut into stretches of one category (a stretch runs on
// to the next one's first point, so a track draws unbroken) and is broken
// where it crosses the antimeridian. Stronger stretches draw on top. One
// stretch of each storm carries storms = 1, so the widgets count storms.
const TRACKS_SQL = [
  "WITH p AS (",
  "  SELECT storm_id, name, season, time_utc, category, category_rank, wind_kt, geom,",
  "         first_value(basin) OVER w AS formed_in,",
  "         max(category_rank) OVER (PARTITION BY storm_id) AS peak_rank,",
  "         coalesce(lag(category) OVER w <> category, true) AS new_category,",
  "         coalesce(abs(ST_X(geom) - lag(ST_X(geom)) OVER w) > 180, false) AS crosses",
  "  FROM storm_track_points",
  "  WINDOW w AS (PARTITION BY storm_id ORDER BY time_utc)),",
  "r AS (",
  "  SELECT *, sum(CAST(new_category OR crosses AS INTEGER))",
  "              OVER (PARTITION BY storm_id ORDER BY time_utc ROWS UNBOUNDED PRECEDING) AS stretch",
  "  FROM p),",
  "vertices AS (",
  "  SELECT storm_id, stretch, time_utc, geom FROM r",
  "  UNION ALL",
  "  SELECT storm_id, stretch - 1, time_utc, geom FROM r",
  "  WHERE new_category AND NOT crosses AND stretch > 1),",
  "lines AS (",
  "  SELECT storm_id, stretch, ST_MakeLine(list(geom ORDER BY time_utc)) AS geom",
  "  FROM vertices GROUP BY storm_id, stretch HAVING count(*) >= 2),",
  "stretches AS (",
  "  SELECT storm_id, stretch,",
  "         any_value(name) AS name, any_value(season) AS season, any_value(formed_in) AS formed_in,",
  "         any_value(category) AS category, any_value(category_rank) AS category_rank,",
  "         any_value(peak_rank) AS peak_rank, max(wind_kt) AS wind_kt, min(time_utc) AS started",
  "  FROM r GROUP BY storm_id, stretch)",
  "SELECT s.name, s.season, s.category,",
  "       CASE WHEN s.peak_rank >= 1 THEN 'Category ' || s.peak_rank",
  "            WHEN s.peak_rank = 0 THEN 'Tropical storm'",
  "            ELSE 'Weaker or not tropical' END AS strongest,",
  "       s.formed_in, s.wind_kt, s.started,",
  "       greatest(s.category_rank, -1) AS strength,",
  "       CASE WHEN row_number() OVER (PARTITION BY s.storm_id ORDER BY s.stretch) = 1 THEN 1 ELSE 0 END AS storms,",
  "       l.geom",
  "FROM stretches s JOIN lines l USING (storm_id, stretch)",
  "ORDER BY s.category_rank, s.started"
].join("\n");

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
const name = "storm_track_points";
const table = await api.upload(`${name}.parquet`, await readFile(path.join(work, record.outputs[name].file)), project.id);
if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
  throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

const tracks = await addLayer({ name: "Storm tracks, by category", sql: TRACKS_SQL });
const paint = await api.post(`/api/layers/${tracks.id}/fill`, { attribute: "category", method: "categorical", palette: "bold" });
await patchLayer(tracks.id, {
  style: {
    ...tracks.style,
    strokeBy: { ...paint, map: Object.entries(CATEGORY).map(([value, color]) => ({ value, color })) },
    strokeWidth: 1,
    strokeWidthBy: { attribute: "strength", domain: [-1, 5], range: [0.6, 2.6] },
    strokeOpacity: 0.9,
  },
  tooltip: ["name", "season", "category", "wind_kt", "started", "strongest", "formed_in"],
  filters: [{ field: "started", kind: "timerange", min: null, max: null }],
  legendTitle: "Saffir-Simpson category",
});

const widget = (id, type, title, more) => ({
  id, type, layerId: tracks.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
const byStorms = { agg: "sum", aggField: "storms" };
const read = record.sources.ibtracs.fetchedAt.slice(0, 10);
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  // Centred on the Pacific, with the edge of the picture over Africa and
  // Europe, where no tropical storm runs: every basin whole.
  viewport: { lng: -175, lat: 14, zoom: 1.35, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  timeline: { layerId: tracks.id, field: "started", speed: 1 },
  widgets: [
    widget("widget-storms", "formula", "Storms", { field: "storms", agg: "sum", format: "integer", note: "Formed 1980 to 2025" }),
    widget("widget-strongest", "category", "Strongest category reached", { field: "strongest", ...byStorms }),
    widget("widget-basin", "category", "Where the storm formed", { field: "formed_in", ...byStorms }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      note: creditNote(facts, {
        [ibtracs.name]:
          `Gahtan, J., K. R. Knapp, C. J. Schreck III, H. J. Diamond, J. P. Kossin and M. C. Kruk (2024). IBTrACS Project, Version 4.01, since1980. NOAA National Centers for Environmental Information. [doi:10.25921/82ty-9e16](https://doi.org/10.25921/82ty-9e16), read ${read}. ` +
          "Knapp, K. R., et al. (2010), Bulletin of the American Meteorological Society 91, 363-376. " +
          "Wind and category from the US agencies (NHC, JTWC); the newest season can still be revised.",
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
