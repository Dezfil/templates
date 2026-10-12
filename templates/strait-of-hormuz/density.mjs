// Read a window of the World Bank's ship density raster without unpacking
// the whole archive. The publisher ships each layer as one ZIP holding an
// uncompressed BigTIFF of about 9.8 GB, deflated inside the ZIP, with its
// directory at the end of the TIFF. So the build fetches only the TIFF's
// compressed entry (a byte range of the ZIP), inflates it once to read the
// directory and check the entry's CRC-32, and once more to copy out the
// rows and columns of the window. Nothing else of the archive is fetched,
// and the inflated TIFF never touches the disk.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, crc32 } from "node:zlib";
import { USER_AGENT } from "../../tools/source.mjs";

async function range(url, from, to) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, range: `bytes=${from}-${to}` } });
  if (response.status !== 206) throw new Error(`${url} answered ${response.status} to a range request`);
  return Buffer.from(await response.arrayBuffer());
}

/** The ZIP's central directory: every entry's name, method, sizes, CRC and offset. */
export async function zipEntries(url) {
  const head = await fetch(url, { method: "HEAD", headers: { "user-agent": USER_AGENT } });
  if (!head.ok) throw new Error(`${url} answered ${head.status}`);
  const length = Number(head.headers.get("content-length"));
  const tail = await range(url, length - 65536, length - 1);
  const base = length - 65536;
  let cdOffset;
  const z64 = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
  if (z64 >= 0) cdOffset = Number(tail.readBigUInt64LE(z64 + 48));
  else {
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error("No end of central directory in the archive's last 64 KB.");
    cdOffset = tail.readUInt32LE(eocd + 16);
  }
  const entries = [];
  let p = cdOffset - base;
  while (p >= 0 && p + 46 <= tail.length && tail.readUInt32LE(p) === 0x02014b50) {
    const method = tail.readUInt16LE(p + 10);
    const crc = tail.readUInt32LE(p + 16);
    let csize = tail.readUInt32LE(p + 20);
    let usize = tail.readUInt32LE(p + 24);
    const nameLength = tail.readUInt16LE(p + 28);
    const extraLength = tail.readUInt16LE(p + 30);
    const commentLength = tail.readUInt16LE(p + 32);
    let offset = tail.readUInt32LE(p + 42);
    const name = tail.subarray(p + 46, p + 46 + nameLength).toString("utf8");
    const extra = tail.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    for (let q = 0; q + 4 <= extra.length;) {
      const id = extra.readUInt16LE(q);
      const size = extra.readUInt16LE(q + 2);
      if (id === 1) {
        let k = q + 4;
        if (usize === 0xffffffff) { usize = Number(extra.readBigUInt64LE(k)); k += 8; }
        if (csize === 0xffffffff) { csize = Number(extra.readBigUInt64LE(k)); k += 8; }
        if (offset === 0xffffffff) { offset = Number(extra.readBigUInt64LE(k)); k += 8; }
      }
      q += 4 + size;
    }
    entries.push({ name, method, crc, csize, usize, offset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return {
    length,
    etag: head.headers.get("etag"),
    lastModified: head.headers.get("last-modified"),
    entries,
  };
}

/** Inflate the saved entry, handing each chunk and its position to `each`. */
async function inflate(file, each) {
  let position = 0;
  let crc = 0;
  await pipeline(
    createReadStream(file, { highWaterMark: 1 << 20 }),
    createInflateRaw({ chunkSize: 1 << 20 }),
    new Transform({
      transform(chunk, _encoding, done) {
        crc = crc32(chunk, crc);
        each(chunk, position);
        position += chunk.length;
        done();
      },
    }),
  );
  return { bytes: position, crc };
}

const TAG = { width: 256, height: 257, bits: 258, compression: 259, stripOffsets: 273, samplesPerPixel: 277, rowsPerStrip: 278, planar: 284, tileWidth: 322, tileLength: 323, tileOffsets: 324, sampleFormat: 339, scale: 33550, tiepoint: 33922, nodata: 42113 };
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

/** The BigTIFF directory's tags, their values read from `at(offset, length)`. */
function readDirectory(directory, at) {
  const count = Number(at(directory, 8).readBigUInt64LE(0));
  const entries = at(directory + 8, count * 20);
  const tags = {};
  for (let i = 0; i < count; i++) {
    const e = entries.subarray(i * 20, i * 20 + 20);
    const tag = e.readUInt16LE(0);
    const type = e.readUInt16LE(2);
    const n = Number(e.readBigUInt64LE(4));
    const size = (TYPE_SIZE[type] ?? 1) * n;
    const raw = size <= 8 ? e.subarray(12, 12 + size) : at(Number(e.readBigUInt64LE(12)), size);
    const values = [];
    for (let k = 0; k < n; k++) {
      if (type === 3) values.push(raw.readUInt16LE(k * 2));
      else if (type === 4) values.push(raw.readUInt32LE(k * 4));
      else if (type === 16) values.push(Number(raw.readBigUInt64LE(k * 8)));
      else if (type === 12) values.push(raw.readDoubleLE(k * 8));
      else if (type === 2) { values.push(raw.toString("latin1").replace(/\0+$/, "")); break; }
      else values.push(raw[k]);
    }
    tags[tag] = values;
  }
  return tags;
}

/**
 * Fetch the TIFF entry of the ZIP at `url` into a new folder under
 * `downloads`: only the entry's compressed bytes, by a range request. The
 * record names the archive, the range read, its bytes and SHA-256.
 */
export async function fetchEntry({ url, entryName, downloads }) {
  const zip = await zipEntries(url);
  const entry = zip.entries.find((e) => e.name === entryName);
  if (!entry) throw new Error(`The archive holds ${zip.entries.map((e) => e.name).join(", ")}; no ${entryName}.`);
  if (entry.method !== 8) throw new Error(`${entryName} is stored with method ${entry.method}, not deflate.`);
  const local = await range(url, entry.offset, entry.offset + 29);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`No local header for ${entryName} at ${entry.offset}.`);
  const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const end = start + entry.csize - 1;

  await mkdir(downloads, { recursive: true });
  const dir = await mkdtemp(path.join(downloads, "worldbank-density-"));
  const file = path.join(dir, `${entryName}.deflate`);
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, range: `bytes=${start}-${end}` } });
  if (response.status !== 206) throw new Error(`${url} answered ${response.status} to the entry's range`);
  const hash = createHash("sha256");
  let fetched = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({ transform(chunk, _e, done) { hash.update(chunk); fetched += chunk.length; done(null, chunk); } }),
    createWriteStream(file),
  );
  if (fetched !== entry.csize) throw new Error(`Fetched ${fetched} bytes of ${entryName}; the archive lists ${entry.csize}.`);
  return {
    path: file,
    entry,
    record: {
      url,
      archive: { bytes: zip.length, etag: zip.etag, lastModified: zip.lastModified, entries: zip.entries.map((e) => e.name) },
      entry: { name: entryName, range: [start, end], bytes: fetched, sha256: hash.digest("hex"), inflated: entry.usize, crc32: entry.crc },
      fetchedAt: new Date().toISOString(),
    },
  };
}

/**
 * Read the window [west, south, east, north] of the fetched entry as sums
 * over blocks of `block` × `block` pixels, with each block's centre.
 * Inflates the entry twice: once to read the TIFF's directory at its end
 * and check the CRC-32, once to copy out the strips or tiles the window
 * needs. Takes uncompressed 32-bit single-band TIFFs, stripped or tiled.
 */
export async function readWindow({ path: file, entry }, { window: [west, south, east, north], block }) {
  // Pass 1: the header names the directory's offset; keep everything from
  // there to the end, and check the whole entry against its CRC-32.
  let directoryAt = null;
  const tailChunks = [];
  const first = await inflate(file, (chunk, at) => {
    if (directoryAt === null) {
      if (chunk.toString("latin1", 0, 2) !== "II" || chunk.readUInt16LE(2) !== 43) throw new Error(`${entry.name} is not a little-endian BigTIFF.`);
      directoryAt = Number(chunk.readBigUInt64LE(8));
    }
    if (at + chunk.length > directoryAt) tailChunks.push(Buffer.from(chunk.subarray(Math.max(0, directoryAt - at))));
  });
  if (first.bytes !== entry.usize) throw new Error(`${entry.name} inflated to ${first.bytes} bytes; the archive lists ${entry.usize}.`);
  if (first.crc !== entry.crc) throw new Error(`${entry.name}'s CRC-32 is ${first.crc}; the archive lists ${entry.crc}.`);
  const tail = Buffer.concat(tailChunks);
  const at = (offset, length) => {
    if (offset < directoryAt || offset + length > directoryAt + tail.length) throw new Error(`The TIFF keeps a value at ${offset}, before its directory.`);
    return tail.subarray(offset - directoryAt, offset - directoryAt + length);
  };
  const tags = readDirectory(directoryAt, at);
  const [width] = tags[TAG.width];
  const [height] = tags[TAG.height];
  const [bits] = tags[TAG.bits];
  const [compression] = tags[TAG.compression];
  const [format] = tags[TAG.sampleFormat] ?? [1];
  const [samples] = tags[TAG.samplesPerPixel] ?? [1];
  if (compression !== 1) throw new Error(`The TIFF is compressed (${compression}); this reader takes uncompressed data only.`);
  if (samples !== 1) throw new Error(`The TIFF has ${samples} samples a pixel; this reader takes one band.`);
  if (bits !== 32 || ![1, 2, 3].includes(format)) throw new Error(`The TIFF's samples are ${bits}-bit format ${format}; expected 32-bit.`);
  const [sx, sy] = tags[TAG.scale];
  const [, , , x0, y0] = tags[TAG.tiepoint];
  const nodata = tags[TAG.nodata]?.[0] !== undefined ? Number(tags[TAG.nodata][0]) : undefined;
  const read = format === 3 ? (b, o) => b.readFloatLE(o) : format === 2 ? (b, o) => b.readInt32LE(o) : (b, o) => b.readUInt32LE(o);

  // A strip is a tile as wide as the image.
  const tiled = Boolean(tags[TAG.tileWidth]);
  const tileW = tiled ? tags[TAG.tileWidth][0] : width;
  const tileH = tiled ? tags[TAG.tileLength][0] : tags[TAG.rowsPerStrip][0];
  const offsets = tiled ? tags[TAG.tileOffsets] : tags[TAG.stripOffsets];
  const across = Math.ceil(width / tileW);

  // The window in pixels, snapped outward to whole blocks.
  const c0 = Math.floor((west - x0) / sx / block) * block;
  const c1 = Math.ceil((east - x0) / sx / block) * block;
  const r0 = Math.floor((y0 - north) / sy / block) * block;
  const r1 = Math.ceil((y0 - south) / sy / block) * block;
  if (c0 < 0 || r0 < 0 || c1 > width || r1 > height) throw new Error("The window reaches past the raster.");
  const cols = (c1 - c0) / block;
  const rows = (r1 - r0) / block;
  const sums = new Float64Array(cols * rows);

  const wanted = [];
  for (let tr = Math.floor(r0 / tileH); tr <= Math.floor((r1 - 1) / tileH); tr++) {
    for (let tc = Math.floor(c0 / tileW); tc <= Math.floor((c1 - 1) / tileW); tc++) {
      const from = offsets[tr * across + tc];
      wanted.push({ tr, tc, from, to: from + tileW * tileH * 4 });
    }
  }
  wanted.sort((a, b) => a.from - b.from);
  let nonzeroPixels = 0;
  const take = ({ tr, tc }, bytes) => {
    for (let y = 0; y < tileH; y++) {
      const r = tr * tileH + y;
      if (r < r0 || r >= r1) continue;
      for (let x = 0; x < tileW; x++) {
        const c = tc * tileW + x;
        if (c < c0 || c >= c1) continue;
        const v = read(bytes, (y * tileW + x) * 4);
        if (!v || v === nodata || !Number.isFinite(v)) continue;
        nonzeroPixels++;
        sums[Math.floor((r - r0) / block) * cols + Math.floor((c - c0) / block)] += v;
      }
    }
  };
  // Pass 2: copy each wanted tile as it streams past.
  let next = 0;
  let parts = [];
  await inflate(file, (chunk, position) => {
    const chunkEnd = position + chunk.length;
    while (next < wanted.length) {
      const w = wanted[next];
      if (w.from >= chunkEnd) return;
      const from = Math.max(w.from, position) - position;
      const to = Math.min(w.to, chunkEnd) - position;
      if (to > from) parts.push(Buffer.from(chunk.subarray(from, to)));
      if (w.to > chunkEnd) return;
      take(w, Buffer.concat(parts));
      parts = [];
      next++;
    }
  });
  if (next !== wanted.length) throw new Error(`Read ${next} of the window's ${wanted.length} tiles.`);

  let nonzeroBlocks = 0;
  for (const v of sums) if (v) nonzeroBlocks++;
  return {
    record: {
      tiff: { width, height, bitsPerSample: bits, sampleFormat: format, tile: tiled ? [tileW, tileH] : null, rowsPerStrip: tiled ? null : tileH, pixelDegrees: [sx, sy], corner: [x0, y0], nodata: nodata ?? null },
      window: { west, south, east, north, pixels: [c1 - c0, r1 - r0], block, tiles: wanted.length, nonzeroPixels, nonzeroBlocks },
    },
    grid: {
      sums,
      cols,
      rows,
      // x0 and y0 are the raster's corner (the tie point); a block's centre
      // is half a block in from its own corner.
      centre: (br, bc) => [x0 + (c0 + bc * block + block / 2) * sx, y0 - (r0 + br * block + block / 2) * sy],
    },
  };
}
