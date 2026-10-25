// The workflow's canvas, in sections left to right: the serious
// collisions per cell, every cell with its zeros, the hot spots.

import { sectionsCanvas } from "../../tools/workflow.mjs";

export default (facts) => sectionsCanvas([
  {
    id: "note-about", label: "About", heading: 1, color: "blue", width: 256,
    title: facts.title,
    text: "Where in London do collisions that kill or seriously injure someone cluster more than chance would allow?",
  },
  {
    id: "note-data", label: "Input data", color: "green",
    title: "Collisions in 2025",
    text: "Every road collision in London in which someone was hurt, as the police recorded it.",
    nodes: { collisions: [0, 0] },
  },
  {
    id: "note-per-cell", label: "Step 1",
    title: "Serious collisions per cell",
    text: "Each collision goes into an H3 cell about 350 m across, and the ones that killed or seriously injured someone are counted per cell.",
    nodes: { collision_cells: [0, 0], serious_collisions: [1, 1], serious_per_cell: [2, 1] },
  },
  {
    id: "note-zeros", label: "Step 2",
    title: "Zeros kept",
    text: "Every cell where anyone was hurt stays in, with a zero where no one was seriously hurt.",
    nodes: { serious_by_cell: [0, 0] },
  },
  {
    id: "note-hotspots", label: "Result",
    title: "Hot spots",
    text: "Gi* compares each cell and its six neighbours with all of London. A z-score above 1.96 is a hot spot at 95% confidence.",
    nodes: { crash_hotspots: [0, 0] },
  },
], { rows: 2 });
