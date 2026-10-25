// The workflow's canvas, in sections left to right as the work flows. The
// hexagons' middles sit in the middle row and feed both the distance
// above and the districts below.

import { sectionsCanvas } from "../../tools/workflow.mjs";

export default (facts) => sectionsCanvas([
  {
    id: "note-about", label: "About", heading: 1, color: "blue", width: 256,
    title: facts.title,
    text: "How many people live more than 5 km from a public health facility, district by district? Five kilometres is about an hour's walk.",
  },
  {
    id: "note-data", label: "Input data", color: "green",
    title: "Three open datasets",
    text: "People per hexagon, public health facilities and district boundaries.",
    nodes: { health_facilities: [0, 0], population_cells: [0, 1], districts: [0, 2] },
  },
  {
    id: "note-distance", label: "Step 1",
    title: "Distance to the nearest facility",
    text:
      "The middle of each hexagon finds its nearest facility in a straight line, and the people more than 5 km away are kept. " +
      "Roads and hills make the real journey longer.",
    nodes: { cell_centres: [0, 1], nearest_facility: [1, 0], beyond_5km: [2, 0] },
  },
  {
    id: "note-districts", label: "Step 2",
    title: "People per district",
    text: "Two spatial joins add up each district's people: everyone, and those more than 5 km away.",
    nodes: { district_people: [0, 2], district_access: [1, 2] },
  },
  {
    id: "note-share", label: "Result",
    title: "Share per district",
    text: "Each district's share of people more than 5 km from a facility.",
    nodes: { district_share: [0, 2] },
  },
]);
