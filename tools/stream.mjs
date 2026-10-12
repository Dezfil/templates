// Fetching a large source straight to disk, for files too big to hold in
// memory (a city's tree register, a national census grid), with `curl`:
// it streams to the file, follows redirects and verifies the server's
// certificate against the system's store, which some public servers need
// (Berlin's geodata service chains to a root Node's own store lacks). The
// same record as source.mjs's download: the address, when, the bytes and
// their hash, and the path of a new folder of its own under `root`. The
// body is data: nothing here runs or imports it.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { USER_AGENT } from "./source.mjs";

const run = promisify(execFile);

export async function downloadStream(root, label, url, file) {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, `${label}-`));
  const target = path.join(dir, file);
  const fetchedAt = new Date().toISOString();
  const { stdout } = await run(
    "curl",
    ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--user-agent", USER_AGENT, "--output", target, "--write-out", "%{url_effective}", url],
    { maxBuffer: 1024 * 1024 },
  );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  // A redirect's address is kept without its query, which for a signed
  // storage address is a signature, not part of where the file lives.
  const answered = stdout.trim().split("?")[0];
  return {
    url,
    ...(answered && answered !== url.split("?")[0] ? { answeredFrom: answered } : {}),
    fetchedAt,
    bytes: (await stat(target)).size,
    sha256: hash.digest("hex"),
    path: target,
  };
}
