// The workflow's canvas, in sections left to right: the deaths per pump,
// then the ring around the Broad Street pump and its share.

import { sectionsCanvas } from "../../tools/workflow.mjs";

export default (facts) => sectionsCanvas([
  {
    id: "note-about", label: "About", heading: 1, color: "blue", width: 256,
    title: facts.title,
    text: "In 1854 cholera killed more than 500 people in a few streets of Soho. Which street pump do the deaths gather around?",
  },
  {
    id: "note-data", label: "Input data", color: "green",
    title: "Deaths and pumps",
    text: "John Snow's deaths, one point per bar he drew, and the street pumps, on today's streets.",
    nodes: { deaths: [0, 0], pumps: [0, 1] },
  },
  {
    id: "note-per-pump", label: "Step 1",
    title: "Deaths per pump",
    text: "Each death goes to its nearest pump in a straight line, and the deaths are counted per pump. On foot, the nearest pump can be another one.",
    nodes: { deaths_nearest_pump: [0, 2], deaths_per_pump: [1, 2], pumps_with_deaths: [2, 1] },
  },
  {
    id: "note-ring", label: "Step 2",
    title: "Within 100 m of Broad Street",
    text: "A ring of 100 m, about a minute's walk, around the Broad Street pump, and the deaths inside it.",
    nodes: { broad_street_pump: [0, 2], within_100_m: [1, 2], deaths_within_100_m: [2, 0] },
  },
  {
    id: "note-share", label: "Result",
    title: "Share near the pump",
    text: "The share of all the deaths that fell within 100 m of the Broad Street pump.",
    nodes: { share_within_100_m: [0, 1] },
  },
]);
