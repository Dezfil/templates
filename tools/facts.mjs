// A template's facts (its template.json) as this repository keeps them in
// templates/<id>/facts.json, and the credit note the map carries for them.
// The product's admission is the real gate; this catches the slips that
// would otherwise only show at validation.

import { readFile } from "node:fs/promises";

export const TAGS = ["First map", "Time", "Analysis", "3D", "Big data", "Widgets", "Flows"];

export async function readFacts(file) {
  const facts = JSON.parse(await readFile(file, "utf8"));
  const problems = [];
  if (facts.formatVersion !== 1) problems.push("formatVersion must be 1");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(facts.id ?? "")) problems.push("id must be lowercase letters, digits and hyphens");
  if (!Number.isInteger(facts.version) || facts.version < 1) problems.push("version must be a whole number from 1");
  if (!Array.isArray(facts.tags) || facts.tags.length < 1 || facts.tags.length > 3 || facts.tags.some((t) => !TAGS.includes(t))) {
    problems.push(`tags must be one to three of ${TAGS.join(", ")}`);
  }
  for (const s of facts.sources ?? []) {
    if (!s.name || !s.licence || !s.credit) problems.push("every source needs a name, a licence and a credit");
  }
  // The format's text bounds: a catalogue whose index breaks one is refused
  // whole, with no word of which field it was.
  const long = (value, at, max) => {
    if (typeof value === "string" && [...value].length > max) problems.push(`${at} is ${[...value].length} characters; the format holds ${max}`);
  };
  long(facts.title, "title", 80);
  long(facts.question, "question", 200);
  long(facts.place, "place", 80);
  (facts.sources ?? []).forEach((s, i) => { long(s.name, `sources[${i}].name`, 120); long(s.credit, `sources[${i}].credit`, 300); });
  long(facts.howMade?.question, "howMade.question", 2000);
  (facts.howMade?.datasets ?? []).forEach((d, i) => long(d.made, `howMade.datasets[${i}].made`, 300));
  (facts.howMade?.styling ?? []).forEach((line, i) => long(line, `howMade.styling[${i}]`, 300));
  if ((facts.howMade?.styling ?? []).length > 12) problems.push("howMade.styling holds at most 12 lines");
  if (!/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/.test(facts.dataDate ?? "")) problems.push("dataDate must be a year, a month or a day");
  if (facts.pictures?.light !== "pictures/light.png" || facts.pictures?.dark !== "pictures/dark.png") {
    problems.push("pictures must be pictures/light.png and pictures/dark.png");
  }
  if (problems.length) throw new Error(`${file}: ${problems.join("; ")}.`);
  return facts;
}

/**
 * The credit note: one paragraph per source naming it, its licence and its
 * credit text word for word (the product refuses a template whose note
 * misses any of the three), then whatever `extra` adds for that source.
 */
export function creditNote(facts, extra = {}) {
  const note = facts.sources
    .map((s) => {
      const credit = s.credit.startsWith("Credit:") ? s.credit : `Credit: ${s.credit}`;
      return [`${s.name}. Licence: ${s.licence}. ${credit}.`, extra[s.name]].filter(Boolean).join(" ");
    })
    .join("\n\n");
  for (const s of facts.sources) {
    if (!note.includes(s.name) || !note.includes(s.licence) || !note.includes(s.credit)) {
      throw new Error(`The credit note lost ${s.name}'s name, licence or credit.`);
    }
  }
  if (note.length > 2000) throw new Error(`The credit note is ${note.length} characters; a note holds 2000.`);
  return note;
}
