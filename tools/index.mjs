// Write a release's index.json from the entries pack left in the dist
// folder: one entry per template, its newest version, in the order given
// (else by id). The archives and pictures sit beside it, named relative.
//
//   node tools/index.mjs <dist folder> [id ...]

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const INDEX_MAX_BYTES = 1024 * 1024;

export async function writeIndex(dist, order = []) {
  const newest = new Map();
  for (const file of await readdir(dist)) {
    if (!file.endsWith(".json") || file === "index.json") continue;
    const entry = JSON.parse(await readFile(path.join(dist, file), "utf8"));
    const kept = newest.get(entry.facts.id);
    if (!kept || entry.facts.version > kept.facts.version) newest.set(entry.facts.id, entry);
  }
  for (const id of order) if (!newest.has(id)) throw new Error(`No packed entry for ${id} in ${dist}.`);
  const ids = [...order, ...[...newest.keys()].filter((id) => !order.includes(id)).sort()];
  const index = { formatVersion: 1, templates: ids.map((id) => newest.get(id)) };
  const text = JSON.stringify(index, null, 2) + "\n";
  if (Buffer.byteLength(text) > INDEX_MAX_BYTES) throw new Error("The index is past the 1 MB a catalogue's index may be.");
  await writeFile(path.join(dist, "index.json"), text);
  return index.templates.map((t) => `${t.facts.id} version ${t.facts.version}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dist, ...order] = process.argv.slice(2);
  if (!dist) throw new Error("Usage: node tools/index.mjs <dist folder> [id ...]");
  console.log((await writeIndex(path.resolve(dist), order)).join("\n"));
}
