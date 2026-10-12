// The template's two map pictures, light and dark, from the server's own
// image export of the authored map: no legend, no widgets, no title, the
// basemap credit the licence requires.
//
//   node tools/pictures.mjs <instance> <template work folder>
//
// Reads <work>/authored.json (its mapId and, optionally, a `picture` block
// with the camera and scale) and writes <work>/pictures/{light,dark}.png.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { connect } from "./client.mjs";

export const PICTURE_MAX_BYTES = 2 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function makePictures(base, work) {
  const authored = JSON.parse(await readFile(path.join(work, "authored.json"), "utf8"));
  const api = await connect(base);
  const map = await api.get(`/api/maps/${authored.mapId}`);
  const picture = authored.picture ?? {};
  const out = path.join(work, "pictures");
  await mkdir(out, { recursive: true });
  const made = {};
  for (const appearance of ["light", "dark"]) {
    const definition = {
      appearance,
      viewport: { pitch: 0, bearing: 0, ...map.viewport, ...picture.viewport },
      size: picture.size ?? { width: 1280, height: 800 },
      mapScale: picture.mapScale ?? 1,
      legend: { visible: false, corner: "bottom-left", size: "s" },
      widgets: [],
      title: null,
      credit: { corner: "bottom-right", size: "xs" },
    };
    // A render that gave up on a basemap tile answers an image with a hole
    // in it and says so in a header: such a picture is never kept.
    let bytes;
    for (let attempt = 1; ; attempt++) {
      // A render can also run out of its time budget now and then (a tile
      // that never answers, a busy machine) and succeed at once when asked
      // again: up to three tries.
      let response;
      try {
        response = await api.raw("POST", `/api/maps/${authored.mapId}/export/image`, { definition });
      } catch (error) {
        if (error.code !== "render_timeout" || attempt === 3) throw error;
        process.stderr.write(`${appearance}: the render ran out of time; rendering again\n`);
        continue;
      }
      bytes = Buffer.from(await response.arrayBuffer());
      const abandoned = response.headers.get("x-dezfil-export-abandoned");
      if (!abandoned) break;
      if (attempt === 3) throw new Error(`The ${appearance} render abandoned requests three times (${abandoned}).`);
      process.stderr.write(`${appearance}: the render abandoned requests (${abandoned}); rendering again\n`);
    }
    if (!bytes.subarray(0, 8).equals(PNG)) throw new Error(`The ${appearance} picture is not a PNG.`);
    if (bytes.length > PICTURE_MAX_BYTES) throw new Error(`The ${appearance} picture is ${bytes.length} bytes; a template picture is at most 2 MB.`);
    await writeFile(path.join(out, `${appearance}.png`), bytes);
    made[appearance] = { bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  return made;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base, work] = process.argv.slice(2);
  if (!base || !work) throw new Error("Usage: node tools/pictures.mjs <instance> <template work folder>");
  console.log(JSON.stringify(await makePictures(base, path.resolve(work))));
}
