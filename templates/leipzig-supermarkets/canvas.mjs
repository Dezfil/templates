// The workflow's canvas, in sections left to right: the distance to the
// nearest supermarket, each square's district, the districts' shares.

import { sectionsCanvas } from "../../tools/workflow.mjs";

export default (facts) => sectionsCanvas([
  {
    id: "note-about", label: "About", heading: 1, color: "blue", width: 256,
    title: facts.title,
    text: "A supermarket within a kilometre means the weekly shop can be carried home on foot. How many people live further away, and where?",
  },
  {
    id: "note-data", label: "Input data", color: "green",
    title: "Three open datasets",
    text: "Census population in 100 m squares, supermarkets from OpenStreetMap and the city's districts.",
    nodes: { supermarkets: [0, 0], population_cells: [0, 1], districts: [0, 2] },
  },
  {
    id: "note-distance", label: "Step 1",
    title: "Distance to the nearest supermarket",
    text: "The middle of each census square finds its nearest supermarket in a straight line. Streets, rivers and railways make the walk longer.",
    nodes: { cell_centres: [0, 1], nearest_supermarket: [1, 0] },
  },
  {
    id: "note-district", label: "Step 2",
    title: "Each square's district",
    text: "A spatial join gives each square the district it lies in.",
    nodes: { cells_by_district: [0, 1] },
  },
  {
    id: "note-summary", label: "Result",
    title: "Per district",
    text: "Each district's people more than 1 km from a supermarket, their share and the average distance.",
    nodes: { district_access: [0, 2] },
  },
]);
