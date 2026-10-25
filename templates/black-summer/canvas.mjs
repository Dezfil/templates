// The workflow's canvas, in sections left to right: the detections into
// burning cells, the cells into fires, each fire's outline and power, the
// fires.

import { sectionsCanvas } from "../../tools/workflow.mjs";

export default (facts) => sectionsCanvas([
  {
    id: "note-about", label: "About", heading: 1, color: "blue", width: 256,
    title: facts.title,
    text: "How many separate fires burned in New South Wales and Victoria from November 2019 to January 2020, and how big were they?",
  },
  {
    id: "note-data", label: "Input data", color: "green",
    title: "Fire detections",
    text: "NASA's MODIS fire detections from November to January, and the state outlines.",
    nodes: { fire_detections: [0, 0], states: [0, 2] },
  },
  {
    id: "note-cells", label: "Step 1",
    title: "Burning cells",
    text: "The detections FIRMS rates 80 or more go into H3 cells of about 36 km², each with its detections and fire power.",
    nodes: { confident_detections: [0, 0], detections_in_cells: [1, 0], burning_cells: [2, 1] },
  },
  {
    id: "note-fires", label: "Step 2",
    title: "Cells into fires",
    text: "Burning cells within 9 km of one another make one fire, and every detection gets its fire.",
    nodes: { burning_cell_middles: [0, 1], cells_by_fire: [1, 1], detections_by_fire: [2, 0] },
  },
  {
    id: "note-outlines", label: "Step 3",
    title: "Outline and power",
    text: "A convex hull around each fire's detections, cut to land and measured, and its summed and peak fire power. A hull is an upper bound on the ground that burned.",
    nodes: { fire_hulls: [0, 1], fire_outlines: [1, 2], fire_areas: [2, 1], fire_power: [0, 0] },
  },
  {
    id: "note-result", label: "Result",
    title: "Fires",
    text: "Every fire with its outline, its area and its fire power.",
    nodes: { fires: [0, 0] },
  },
]);
