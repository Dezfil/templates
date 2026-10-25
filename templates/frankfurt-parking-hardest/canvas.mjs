// The workflow's canvas, in sections left to right: the minutes of
// searching and the parking spaces per cell, the minutes per space, the
// hot spots. Below them, the trips' licence, which travels with the data.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { readLicence } from "../frankfurt-parking/sources.mjs";
import { GRID, sectionsCanvas } from "../../tools/workflow.mjs";

export default async (facts, { work }) => {
  const canvas = sectionsCanvas([
    {
      id: "note-about", label: "About", heading: 1, color: "blue", width: 256,
      title: facts.title,
      text: "Not where drivers search, but where they search long for the spaces there are.",
    },
    {
      id: "note-data", label: "Input data", color: "green",
      title: "Trips and spaces",
      text: "Waypoints of 65 start2park trips, marked where drivers searched, and the parking spaces from OpenStreetMap.",
      nodes: { search_points: [0, 0], parking_spaces: [0, 1] },
    },
    {
      id: "note-per-cell", label: "Step 1",
      title: "Per cell",
      text: "Each waypoint marked as searching counts the minutes until the next one. Minutes and parking spaces are added up per H3 cell.",
      nodes: { search_cells: [0, 0], search_minutes_per_cell: [1, 0], space_cells: [0, 1], spaces_per_cell: [1, 1] },
    },
    {
      id: "note-per-space", label: "Step 2",
      title: "Minutes per space",
      text: "The minutes divided by the spaces in the same cell: a long hunt for few spaces scores high.",
      nodes: { search_per_space: [0, 0] },
    },
    {
      id: "note-hotspots", label: "Result",
      title: "Hot spots",
      text: "Gi* compares each cell and two rings of neighbours with every searched cell. A z-score above 1.96 is a hot spot at 95% confidence.",
      nodes: { parking_hotspots: [0, 0] },
    },
  ], { rows: 2 });
  const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
  const licence = await readLicence(work, record);
  const below = Math.max(...canvas.notes.map((n) => n.y + n.h)) + 2 * GRID.gap;
  canvas.notes.push({
    id: "note-licence", x: 0, y: below, w: 560, h: 520, color: "grey",
    text: `---\nlabel: Licence\n---\nThe start2park trips are published by ReLUT, Frankfurt University of Applied Sciences, under this licence:\n\n${licence.trim()}`,
  });
  return canvas;
};
