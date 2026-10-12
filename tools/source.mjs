// Fetching a source from its publisher, and the DuckDB engine a build
// prepares it with. Shared by every template's build.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

export const USER_AGENT = "Dezfil-templates/1.0 (+https://dezfil.io)";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Fetch one pinned address into a new folder of its own under `root`, so
 * no download ever lands beside another or beside a script. Answers what
 * the build record keeps: the address, when, how many bytes and their hash.
 * The body is data: nothing here runs or imports it.
 */
export async function download(root, label, url, file) {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, `${label}-`));
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const target = path.join(dir, file);
  await writeFile(target, bytes);
  return {
    url,
    ...(response.url !== url ? { answeredFrom: response.url } : {}),
    fetchedAt: new Date().toISOString(),
    bytes: bytes.length,
    sha256: sha256(bytes),
    path: target,
  };
}

/** An in-memory DuckDB with the spatial extension loaded. */
export async function engine() {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run("INSTALL spatial");
  await conn.run("LOAD spatial");
  return {
    run: (sql) => conn.run(sql),
    rows: async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson(),
    close: () => {
      conn.closeSync();
      instance.closeSync();
    },
  };
}

/** A SQL string literal. */
export const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
