// Authoring a workflow example through the documented API: the workflow,
// its steps in order, its canvas layout, and one whole run whose outputs
// become the example's bundled results.

/** The workflow's current edit revision, read before each write. */
async function revision(api, recipeId) {
  return (await api.get(`/api/recipes/${recipeId}`)).editRevision;
}

/** A new workflow filed in the project. */
export async function createWorkflow(api, projectId, name) {
  const { recipe } = await api.post("/api/recipes", { name, projectId, origin: "workflow" });
  return recipe;
}

/** Add one step at the end; answers the stored step. */
export async function addStep(api, recipeId, operation, parameters) {
  const headers = { "x-edit-revision": await revision(api, recipeId) };
  const { step } = await api.post(`/api/recipes/${recipeId}/steps`, { operation, parameters }, headers);
  return step;
}

/** Replace the canvas layout: positions for steps and sources, and notes. */
export async function setLayout(api, recipeId, layout) {
  const headers = { "x-edit-revision": await revision(api, recipeId) };
  return api.put(`/api/recipes/${recipeId}/layout`, layout, headers);
}

/**
 * A section of the canvas: a tinted note behind a group of steps with an
 * optional label tag, a short heading and a sentence or two. The examples
 * explain themselves with these: the question, the input data, one per
 * stage, the result.
 */
export function section({ id, label, title, text, color = "yellow", x, y, w, h, heading = 2 }) {
  const block = label ? `---\nlabel: ${label}\n---\n` : "";
  return { id, x, y, w, h, color, text: `${block}${"#".repeat(heading)} ${title}\n\n${text}` };
}

/**
 * The examples' canvas grid. A node is 144 by 114 (its 72 px tile at the
 * top, centred, its name and caption under it); node columns are 176
 * apart; sections are full-height columns 24 apart, every heading in one
 * band across the top and every node in the rows below it, so no edge
 * crosses a section's text.
 */
export const GRID = { nodeW: 144, nodeH: 114, column: 176, pad: 24, gap: 24, band: 176, row: 152, minW: 240 };

/**
 * A canvas laid out as sections side by side, left to right. Each section
 * names its nodes by dataset name, at [column, row] inside it; a section
 * without nodes takes `width`. Answers `{ at, notes }` for `setCanvas`.
 */
export function sectionsCanvas(sections, { rows = 3 } = {}) {
  const g = GRID;
  const h = Math.ceil((g.band + (rows - 1) * g.row + g.nodeH + g.pad) / 8) * 8;
  const at = {};
  const notes = [];
  let x = 0;
  for (const s of sections) {
    const nodes = Object.entries(s.nodes ?? {});
    const cols = nodes.length ? Math.max(...nodes.map(([, [c]]) => c)) + 1 : 0;
    const block = cols ? cols * g.nodeW + (cols - 1) * (g.column - g.nodeW) : 0;
    const w = cols ? Math.max(g.minW, block + 2 * g.pad) : s.width;
    const left = x + (w - block) / 2;
    for (const [name, [c, r]] of nodes) at[name] = { x: left + c * g.column, y: g.band + r * g.row };
    notes.push(section({ ...s, x, y: 0, w, h }));
    x += w + g.gap;
  }
  return { at, notes };
}

/**
 * Replace the canvas layout from positions keyed by name: a step by the
 * dataset it makes, a source by its own. A name that is neither is refused.
 */
export async function setCanvas(api, recipeId, { at, notes }) {
  const { recipe } = await api.get(`/api/recipes/${recipeId}`);
  const byOutput = new Map(recipe.steps.map((s) => [s.parameters.name, s.id]));
  const read = new Set(recipe.steps.flatMap((s) => readsOf(s)));
  const steps = {};
  const sources = {};
  for (const [name, position] of Object.entries(at)) {
    if (byOutput.has(name)) steps[byOutput.get(name)] = position;
    else if (read.has(name)) sources[name] = position;
    else throw new Error(`${name} is neither a step's output nor a dataset a step reads.`);
  }
  return setLayout(api, recipeId, { sources, steps, notes });
}

/** The dataset names a step reads: its named inputs, or a SQL step's tables. */
export function readsOf(step) {
  const { name, sql, ...rest } = step.parameters;
  if (step.operation === "sql_step") return [...sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]);
  return Object.values(rest).filter((v) => typeof v === "string");
}

/**
 * Run the whole workflow once and wait for it to finish. Answers the run;
 * throws unless every step completed.
 */
export async function runWorkflow(api, recipeId, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const headers = { "x-edit-revision": await revision(api, recipeId) };
  const { run } = await api.post(`/api/recipes/${recipeId}/runs`, {}, headers);
  const started = Date.now();
  for (;;) {
    const { run: now } = await api.get(`/api/recipes/${recipeId}/runs/${run.id}`);
    if (now.outcome) {
      if (now.outcome !== "completed") throw new Error(`The run ended ${now.outcome}: ${JSON.stringify(now.members).slice(0, 1500)}`);
      return now;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`The run did not finish in ${timeoutMs / 1000} s.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
