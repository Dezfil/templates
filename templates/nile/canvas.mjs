// The workflow's canvas, in sections left to right: the valley drawn
// from the river, its land and people, the valley in numbers.

import { sectionsCanvas } from "../../tools/workflow.mjs";

export default (facts) => sectionsCanvas([
  {
    id: "note-about", label: "About", heading: 1, color: "blue", width: 256,
    title: facts.title,
    text: "Herodotus called Egypt the gift of the Nile. How many of its people live along the river, and on how much of its land?",
  },
  {
    id: "note-data", label: "Input data", color: "green",
    title: "Four open datasets",
    text: "The Nile, its Delta and Egypt's outline from Natural Earth, and people per hexagon from Kontur.",
    nodes: { nile: [0, 0], nile_delta: [0, 1], egypt: [0, 2], population_cells: [0, 3] },
  },
  {
    id: "note-valley", label: "Step 1",
    title: "The valley",
    text: "10 km either side of the Nile and its Delta branches, with the Delta added, merged into one shape and cut at Egypt's border.",
    nodes: { nile_simplified: [0, 0], nile_10km: [1, 0], nile_10km_and_delta: [2, 1], valley_whole: [3, 0], valley: [4, 2] },
  },
  {
    id: "note-land-people", label: "Step 2",
    title: "Land and people",
    text: "The valley and the land beyond it, measured on the ground, and the people in the hexagons that touch the valley.",
    nodes: { cells_in_the_valley: [0, 1], beyond_the_valley: [0, 3], people_in_the_valley: [1, 1], valley_area: [1, 2], beyond_the_valley_area: [1, 3] },
  },
  {
    id: "note-share", label: "Result",
    title: "The valley in numbers",
    text: "The valley's people and land against the whole country.",
    nodes: { the_valley_in_numbers: [0, 0] },
  },
], { rows: 4 });
