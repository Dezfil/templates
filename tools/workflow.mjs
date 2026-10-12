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
