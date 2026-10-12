// Pack one template: the authored project's export from the scratch
// instance, plus its facts (template.json), its workflow's bundled results
// (results/) and its two pictures (pictures/), into one archive with one
// <id>.dezfil folder. Writes the archive, its pictures and its index entry
// (size and SHA-256 included) into the dist folder.
//
//   node tools/pack.mjs <instance> <template folder> <work folder> <dist folder>
//
// <work folder> is the template's own (work/<id>), holding build-record.json,
// authored.json and pictures/. A workflow example's authored.json names its
// bundled results as { "results": { "<step id>": "<dataset name>" } }: each
// named dataset leaves the export's datasets and travels as
// results/<step id>.parquet, as the format keeps a step's result.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { connect } from "./client.mjs";
import { readFacts } from "./facts.mjs";
import { sha256 } from "./source.mjs";
import { readZip, writeZip } from "./zip.mjs";

export async function pack(base, templateDir, work, dist) {
  const facts = await readFacts(path.join(templateDir, "facts.json"));
  const record = JSON.parse(await readFile(path.join(work, "build-record.json"), "utf8"));
  const authored = JSON.parse(await readFile(path.join(work, "authored.json"), "utf8"));

  // The facts say when the data was read; hold them to the build that read it.
  const day = record.builtAt.slice(0, 10);
  for (const line of facts.howMade.datasets) {
    if (!line.made.includes(day)) throw new Error(`howMade for ${line.dataset} does not name ${day}, the day the build read its source.`);
  }

  const api = await connect(base);
  const members = await api.get(`/api/projects/${authored.projectId}/members`);
  const response = await api.raw("POST", `/api/projects/${authored.projectId}/export`, {
    file: facts.id,
    maps: members.maps.map((m) => m.id),
    workflows: members.recipes.map((w) => w.id),
    datasets: members.tables.map((t) => t.id),
  });
  const exported = readZip(Buffer.from(await response.arrayBuffer()));
  const root = `${facts.id}.dezfil/`;
  const files = new Map();
  for (const { name, data } of exported) {
    if (!name.startsWith(root)) throw new Error(`The export holds ${name}, outside ${root}.`);
    files.set(name.slice(root.length), data);
  }
  for (const reserved of ["template.json"]) if (files.has(reserved)) throw new Error(`The export already holds ${reserved}.`);

  const manifest = JSON.parse(files.get("project.json").toString("utf8"));
  for (const [step, dataset] of Object.entries(authored.results ?? {})) {
    const entry = manifest.contents.datasets.find((d) => d.name === dataset);
    if (!entry) throw new Error(`The export holds no dataset ${dataset} for step ${step}.`);
    files.set(`results/${step}.parquet`, files.get(entry.file));
    files.delete(entry.file);
    manifest.contents.datasets = manifest.contents.datasets.filter((d) => d !== entry);
  }
  // The export's manifest stays as exported unless a result left it.
  if (Object.keys(authored.results ?? {}).length) files.set("project.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));

  const named = new Set(facts.howMade.datasets.map((d) => d.dataset));
  const held = new Set(manifest.contents.datasets.map((d) => d.name));
  if (named.size !== held.size || [...named].some((n) => !held.has(n))) {
    throw new Error(`howMade names ${[...named].join(", ")}; the export holds ${[...held].join(", ")}.`);
  }

  const pictures = {};
  for (const theme of ["light", "dark"]) {
    pictures[theme] = await readFile(path.join(work, "pictures", `${theme}.png`));
    files.set(facts.pictures[theme], pictures[theme]);
  }
  files.set("template.json", Buffer.from(JSON.stringify(facts, null, 2) + "\n"));

  const archive = writeZip([...files].map(([name, data]) => ({ name: root + name, data })));
  const stem = `${facts.id}-${facts.version}`;
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, `${stem}.zip`), archive);
  for (const theme of ["light", "dark"]) await writeFile(path.join(dist, `${stem}-${theme}.png`), pictures[theme]);
  const entry = {
    facts,
    size: archive.length,
    sha256: sha256(archive),
    archive: `${stem}.zip`,
    pictures: { light: `${stem}-light.png`, dark: `${stem}-dark.png` },
  };
  await writeFile(path.join(dist, `${stem}.json`), JSON.stringify(entry, null, 2) + "\n");
  return { archive: path.join(dist, `${stem}.zip`), size: entry.size, sha256: entry.sha256, members: [...files.keys()].sort() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base, templateDir, work, dist] = process.argv.slice(2);
  if (!dist) throw new Error("Usage: node tools/pack.mjs <instance> <template folder> <work folder> <dist folder>");
  console.log(JSON.stringify(await pack(base, path.resolve(templateDir), path.resolve(work), path.resolve(dist)), null, 2));
}
