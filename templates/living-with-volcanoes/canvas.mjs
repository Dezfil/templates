// The workflow's canvas, in sections left to right: the circles around
// the volcanoes, the people and eruptions per volcano, the people near
// any volcano counted once, the country's share.

import { sectionsCanvas } from "../../tools/workflow.mjs";

export default (facts) => sectionsCanvas([
  {
    id: "note-about", label: "About", heading: 1, color: "blue", width: 256,
    title: facts.title,
    text: "How many people in the Philippines live within 30 km of a volcano that has erupted in recorded history?",
  },
  {
    id: "note-data", label: "Input data", color: "green",
    title: "Four open datasets",
    text: "Volcanoes and their eruptions from NOAA, the country's outline and people per hexagon.",
    nodes: { volcanoes: [0, 0], philippines: [0, 1], population_cells: [0, 2], significant_eruptions: [0, 3] },
  },
  {
    id: "note-circles", label: "Step 1",
    title: "30 km around each volcano",
    text: "The 18 volcanoes with an eruption in recorded history, a 30 km circle around each, cut to the land.",
    nodes: { historical_volcanoes: [0, 0], within_30km: [1, 0], within_30km_on_land: [2, 1] },
  },
  {
    id: "note-per-volcano", label: "Step 2",
    title: "People and eruptions per volcano",
    text: "The people inside each circle, and each volcano's significant eruptions. Someone near two volcanoes counts for both.",
    nodes: { cell_centres: [0, 2], eruptions_per_volcano: [0, 3], people_per_volcano: [1, 0], volcanoes_in_numbers: [2, 3] },
  },
  {
    id: "note-near", label: "Step 3",
    title: "People near any volcano",
    text: "The circles merge into one shape, so everyone near a volcano counts once.",
    nodes: { near_a_volcano: [0, 1], centres_near_a_volcano: [1, 2], people_near_a_volcano: [2, 1] },
  },
  {
    id: "note-share", label: "Result",
    title: "The Philippines in numbers",
    text: "The people near a volcano against the whole country.",
    nodes: { the_philippines_in_numbers: [0, 0] },
  },
], { rows: 4 });
