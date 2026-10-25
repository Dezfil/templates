// Check a workflow example's canvas the way a reader sees it: every node
// inside a section and below its heading band, and no edge crossing a
// node other than its own ends, a section's heading band, or running
// backwards. Edges are traced as the canvas draws them (a bezier from the
// tile's right edge to the next tile's left edge, both control points
// halfway across).
//
//   node tools/canvas-check.mjs <instance> <template folder> [work folder]
//
// lays the template's canvas (its canvas.mjs) onto the newest workflow of
// that title on a scratch instance, then prints what it found; exits
// non-zero on any problem. Use it to adjust a canvas without re-authoring.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect } from "./client.mjs";
import { GRID, readsOf, setCanvas } from "./workflow.mjs";

const TILE = { left: 36, right: 108, mid: 36 };

function bezier(s, t) {
  const sx = s.x + TILE.right, sy = s.y + TILE.mid;
  const tx = t.x + TILE.left, ty = t.y + TILE.mid;
  const d = tx - sx;
  const off = d >= 0 ? 0.5 * d : 0.25 * 25 * Math.sqrt(-d);
  const c1 = [sx + off, sy], c2 = [tx - off, ty];
  const points = [];
  for (let i = 0; i <= 200; i++) {
    const u = i / 200, v = 1 - u;
    points.push([
      v * v * v * sx + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * tx,
      v * v * v * sy + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * ty,
    ]);
  }
  return { points, backwards: d < 16 };
}

const inside = ([x, y], r) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1;

/** Problems with a canvas, from the workflow's steps and its layout. */
export function checkCanvas(steps, layout) {
  const members = new Map();
  for (const [name, p] of Object.entries(layout.sources)) members.set(name, p);
  for (const s of steps) if (layout.steps[s.id]) members.set(s.parameters.name, layout.steps[s.id]);
  const problems = [];
  for (const s of steps) if (!layout.steps[s.id]) problems.push(`${s.parameters.name} has no position`);

  for (const [name, p] of members) {
    const home = layout.notes.find((n) => p.x >= n.x + 16 && p.x + GRID.nodeW <= n.x + n.w - 16 && p.y + GRID.nodeH <= n.y + n.h - 8 && p.y >= n.y);
    if (!home) problems.push(`${name} is not inside a section`);
    else if (p.y < home.y + GRID.band - 8) problems.push(`${name} sits in its section's heading band`);
  }

  const bodies = [...members].map(([name, p]) => ({ name, x0: p.x + 6, x1: p.x + GRID.nodeW - 6, y0: p.y - 4, y1: p.y + GRID.nodeH - 2 }));
  const bands = layout.notes.map((n) => ({ name: n.id, x0: n.x, x1: n.x + n.w, y0: n.y, y1: n.y + GRID.band - 8 }));
  for (const s of steps) {
    const to = s.parameters.name;
    for (const from of new Set(readsOf(s))) {
      if (!members.has(from) || !members.has(to)) continue;
      const { points, backwards } = bezier(members.get(from), members.get(to));
      const edge = `${from} → ${to}`;
      if (backwards) problems.push(`${edge} runs backwards`);
      for (const b of bodies) if (b.name !== from && b.name !== to && points.some((pt) => inside(pt, b))) problems.push(`${edge} crosses ${b.name}`);
      for (const b of bands) if (points.some((pt) => inside(pt, b))) problems.push(`${edge} crosses the heading of ${b.name}`);
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, folder, workArg] = process.argv.slice(2);
  if (!folder) throw new Error("Usage: node tools/canvas-check.mjs <instance> <template folder> [work folder]");
  const facts = JSON.parse(await readFile(path.join(folder, "facts.json"), "utf8"));
  const work = path.resolve(workArg ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../work"), facts.id);
  const { default: canvas } = await import(pathToFileURL(path.resolve(folder, "canvas.mjs")).href);
  const api = await connect(base);
  const { recipes } = await api.get("/api/recipes");
  const mine = recipes.filter((r) => r.name === facts.title).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!mine.length) throw new Error(`No workflow named ${facts.title} on ${base}.`);
  await setCanvas(api, mine[0].id, await canvas(facts, { work }));
  const { recipe } = await api.get(`/api/recipes/${mine[0].id}`);
  const { layout } = await api.get(`/api/recipes/${mine[0].id}/layout`);
  const problems = checkCanvas(recipe.steps, layout);
  console.log(problems.length ? problems.join("\n") : `${facts.id}: the canvas is clear`);
  process.exitCode = problems.length ? 1 : 0;
}
