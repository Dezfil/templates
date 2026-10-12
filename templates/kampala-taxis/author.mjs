// Author "Kampala's minibus taxis" on a scratch Dezfil through its
// documented API: the project, both datasets, the map with its trips,
// whose SQL works out each trip's fare per kilometre, and its stages, their
// styles, the widgets and the credit note.
//
//   node templates/kampala-taxis/author.mjs http://127.0.0.1:3811 [work folder]
//
// Reads the build's output and writes <work>/kampala-taxis/authored.json
// (the project, map, layer and widget ids pack and pictures need).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../tools/client.mjs";
import { creditNote } from "../../tools/facts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) throw new Error("Name the scratch instance, e.g. http://127.0.0.1:3811");
const work = path.resolve(process.argv[3] ?? path.join(here, "../../work"), "kampala-taxis");

const facts = JSON.parse(await readFile(path.join(here, "facts.json"), "utf8"));
const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
const [study] = facts.sources;

const api = await connect(base);

const project = await api.post("/api/projects", { name: facts.title });
for (const name of ["taxi_trips", "stages"]) {
  const file = path.join(work, record.outputs[name].file);
  const table = await api.upload(`${name}.parquet`, await readFile(file), project.id);
  if (table.name !== name || table.rowCount !== record.outputs[name].rows) {
    throw new Error(`${name} landed as ${table.name} with ${table.rowCount} rows; the build made ${record.outputs[name].rows}.`);
  }
}

const map = await api.post("/api/maps", { name: facts.title, projectId: project.id });
const addLayer = (body) => api.mapWrite(map.id, "POST", `/api/maps/${map.id}/layers`, body);
const patchLayer = (id, body) => api.mapWrite(map.id, "PATCH", `/api/layers/${id}`, body);

// Fares per kilometre in five bands, cheap to dear; the trips with no
// recorded fare take the paint's "other" colour, grey, and the legend
// names it. A continuous colour would give a trip with no fare the ramp's
// first colour, as if it were the cheapest.
const BANDS = [
  { label: "Under 100", below: 100, color: "#2B54A8" },
  { label: "100 to 150", below: 150, color: "#3B9AD0" },
  { label: "150 to 200", below: 200, color: "#E8C21C" },
  { label: "200 to 300", below: 300, color: "#F0812A" },
  { label: "300 and more", below: null, color: "#D7263D" },
];
const NO_FARE = { label: "No fare recorded", color: "#9AA0A6" };

const perKm = "fare_ugx / length_km";
const bandCase = [
  "CASE",
  `  WHEN fare_ugx IS NULL THEN '${NO_FARE.label}'`,
  ...BANDS.filter((b) => b.below !== null).map((b) => `  WHEN ${perKm} < ${b.below} THEN '${b.label}'`),
  `  ELSE '${BANDS.at(-1).label}'`,
  "END",
].join("\n");
const rankCase = [
  "CASE",
  "  WHEN fare_ugx IS NULL THEN 0",
  ...BANDS.filter((b) => b.below !== null).map((b, i) => `  WHEN ${perKm} < ${b.below} THEN ${i + 1}`),
  `  ELSE ${BANDS.length}`,
  "END",
].join("\n");

// The trips, each with its fare per kilometre: the fare for the whole trip
// over its length. The dearer trips are drawn last, on top.
const TRIPS_SQL = [
  "SELECT trip_name,",
  "       from_stage,",
  "       to_stage,",
  "       vehicle,",
  "       ends_in,",
  "       CAST(round(length_km, 1) AS DOUBLE) AS length_km,",
  "       fare_ugx,",
  `       CAST(round(${perKm}) AS INTEGER) AS fare_per_km,`,
  `       ${bandCase.split("\n").join("\n       ")} AS fare_band,`,
  `       ${rankCase.split("\n").join("\n       ")} AS band_rank,`,
  "       geom",
  "FROM taxi_trips",
  "ORDER BY band_rank, fare_ugx / length_km",
].join("\n");

// The stages, sized by the trips that start there.
const STAGES_SQL = [
  "SELECT name,",
  "       district,",
  "       trips_from,",
  "       trips_to,",
  "       geom",
  "FROM stages",
  "ORDER BY trips_from",
].join("\n");

const rgb = (hex, a = 1) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });

const trips = await addLayer({ name: "Taxi trips, by fare per kilometre", sql: TRIPS_SQL });
const bands = await api.post(`/api/layers/${trips.id}/fill`, { attribute: "fare_band", method: "categorical", palette: "bold" });
await patchLayer(trips.id, {
  style: {
    ...trips.style,
    strokeBy: {
      ...bands,
      map: BANDS.map((b) => ({ value: b.label, color: rgb(b.color) })),
      other: rgb(NO_FARE.color),
    },
    strokeOpacity: 0.85,
    strokeWidth: 1.4,
  },
  tooltip: ["trip_name", "vehicle", "length_km", "fare_ugx", "fare_per_km"],
  legendTitle: "Fare per kilometre, Ugandan shillings",
  legendLabels: [...BANDS.map(() => null), NO_FARE.label],
});

const stages = await addLayer({ name: "Taxi parks and stages", sql: STAGES_SQL });
const sizes = await api.post(`/api/layers/${stages.id}/scale`, { attribute: "trips_from", range: [1.5, 8] });
await patchLayer(stages.id, {
  style: {
    ...stages.style,
    fill: { type: "constant", color: rgb("#FFFFFF") },
    fillOpacity: 1,
    stroke: rgb("#2A2622"),
    strokeOpacity: 1,
    strokeWidth: 0.8,
    pointRadiusBy: sizes,
  },
  tooltip: ["name", "district", "trips_from", "trips_to"],
  legendTitle: "Trips starting at the stage",
});

const widget = (id, type, title, more) => ({
  id, type, layerId: trips.id, title, field: null, agg: "count", aggField: null,
  unit: null, note: null, format: null, visible: true, ...more,
});
const read = record.sources.trips.fetchedAt.slice(0, 10);
await api.mapWrite(map.id, "PATCH", `/api/maps/${map.id}`, {
  viewport: { lng: 32.59, lat: 0.32, zoom: 11.3, pitch: 0, bearing: 0 },
  basemap: null,
  legendCorner: "bottom-left",
  legendOrder: [trips.id, stages.id],
  layerOrder: [trips.id, stages.id],
  widgets: [
    widget("widget-fare", "formula", "Average fare per kilometre", { agg: "avg", field: "fare_per_km", unit: "UGX", format: "integer", note: "Over the trips drawn that have a recorded fare, early 2020" }),
    widget("widget-from", "category", "Stage the trip starts from", { field: "from_stage" }),
    widget("widget-length", "histogram", "Length of the trip, km", { field: "length_km" }),
    widget("widget-ends", "category", "District the trip ends in", { field: "ends_in" }),
    widget("widget-sources", "note", "Sources", {
      layerId: null,
      note: creditNote(facts, {
        [study.name]: `The study's unique trips and stages layers, read on ${read} from the repository at commit ${record.commit.slice(0, 7)}. The study's attribution: "This data is owned by Kampala Capital City Authority and the Ministry of Works and Transport. Data was created by a consortium composed of Transitec Consulting Engineers, Suez Consulting, Organization Development Africa (ODA), Transport for Cairo, Prome Consultants, Claudia Heim, and Amanda Ngabirano under the 'Study of the Paratransit Transport System and Street Usage in the Kampala Metropolitan Area' project sponsored by the French Development Agency." Modified: fields renamed, districts named, positions rounded to about a metre, a fare of 0 read as none; fare per kilometre worked out in the map's SQL. [DigitalTransport4Africa: Kampala](https://gitlab.com/digitaltransport/data/africa/kampala)`,
      }),
    }),
  ],
  widgetsPublished: true,
});

const authored = {
  base: api.origin,
  projectId: project.id,
  mapId: map.id,
  layers: { trips: trips.id, stages: stages.id },
  authoredAt: new Date().toISOString(),
};
await writeFile(path.join(work, "authored.json"), JSON.stringify(authored, null, 2) + "\n");
process.stdout.write(`authored project ${project.id}, map ${map.id}\n`);
