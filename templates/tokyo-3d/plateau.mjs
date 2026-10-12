// Reading PLATEAU's CityGML without downloading the whole archive: the
// 23 wards' models come as one 5.3 GB ZIP, of which a ward's buildings are
// a few dozen members. This reads the archive's central directory and then
// each wanted member through HTTP range requests, and takes from each
// building only what the map uses. Plain ZIP and ZIP64 directories, stored
// or deflated members.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { USER_AGENT } from "../../tools/source.mjs";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64_LOCATOR = 0x07064b50;
const END64 = 0x06064b50;

async function range(url, start, end) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, range: `bytes=${start}-${end}` } });
  if (response.status !== 206) throw new Error(`${url} answered ${response.status} to a range request.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== end - start + 1) throw new Error(`${url} answered ${bytes.length} bytes for a range of ${end - start + 1}.`);
  return bytes;
}

/** The archive's size, its last modification as the server states it, and
 * every member's name, method, sizes, CRC and local header offset. */
export async function remoteDirectory(url) {
  const head = await fetch(url, { method: "HEAD", headers: { "user-agent": USER_AGENT } });
  if (!head.ok) throw new Error(`${url} answered ${head.status}`);
  const size = Number(head.headers.get("content-length"));
  const tailLength = Math.min(size, 0xffff + 22 + 20);
  const tail = await range(url, size - tailLength, size - 1);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === END) { end = i; break; }
  if (end < 0) throw new Error(`${url} is not a ZIP archive.`);
  let count = tail.readUInt16LE(end + 10);
  let directorySize = tail.readUInt32LE(end + 12);
  let directoryOffset = tail.readUInt32LE(end + 16);
  if (end >= 20 && tail.readUInt32LE(end - 20) === END64_LOCATOR) {
    const at = Number(tail.readBigUInt64LE(end - 20 + 8));
    const record = await range(url, at, at + 55);
    if (record.readUInt32LE(0) !== END64) throw new Error(`${url} has a broken ZIP64 end record.`);
    count = Number(record.readBigUInt64LE(32));
    directorySize = Number(record.readBigUInt64LE(40));
    directoryOffset = Number(record.readBigUInt64LE(48));
  }
  const directory = await range(url, directoryOffset, directoryOffset + directorySize - 1);
  const members = new Map();
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (directory.readUInt32LE(at) !== CENTRAL) throw new Error(`${url} has a broken central directory.`);
    const method = directory.readUInt16LE(at + 10);
    const crc = directory.readUInt32LE(at + 16);
    let compressed = directory.readUInt32LE(at + 20);
    let size = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    let local = directory.readUInt32LE(at + 42);
    const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
    // ZIP64: the sizes and offset that overflowed 32 bits, in that order.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extra);
      const length = directory.readUInt16LE(extra + 2);
      if (id === 1) {
        let field = extra + 4;
        if (size === 0xffffffff) { size = Number(directory.readBigUInt64LE(field)); field += 8; }
        if (compressed === 0xffffffff) { compressed = Number(directory.readBigUInt64LE(field)); field += 8; }
        if (local === 0xffffffff) { local = Number(directory.readBigUInt64LE(field)); field += 8; }
      }
      extra += 4 + length;
    }
    members.set(name, { name, method, crc, compressed, size, local });
    at = extraEnd + commentLength;
  }
  return { url, size, lastModified: head.headers.get("last-modified"), members };
}

/**
 * Fetch one member by range into a new folder of its own under `root`,
 * under a fixed file name (a name in the archive never becomes a path).
 * Answers what a build record keeps.
 */
export async function fetchMember(root, label, directory, name, file) {
  const member = directory.members.get(name);
  if (!member) throw new Error(`The archive holds no ${name}.`);
  const header = await range(directory.url, member.local, member.local + 29);
  if (header.readUInt32LE(0) !== LOCAL) throw new Error(`${name} has no local header.`);
  const start = member.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const raw = await range(directory.url, start, start + member.compressed - 1);
  const data = member.method === 0 ? raw : member.method === 8 ? inflateRawSync(raw) : null;
  if (!data) throw new Error(`${name} uses compression method ${member.method}.`);
  if (data.length !== member.size || crc32(data) !== member.crc) throw new Error(`${name} does not match its size or CRC.`);
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, `${label}-`));
  const target = path.join(dir, file);
  await writeFile(target, data);
  return {
    member: name,
    fetchedAt: new Date().toISOString(),
    compressedBytes: member.compressed,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    path: target,
  };
}

const between = (text, open, close, from = 0) => {
  const start = text.indexOf(open, from);
  if (start < 0) return null;
  const end = text.indexOf(close, start + open.length);
  if (end < 0) return null;
  return { start, end: end + close.length, inner: text.slice(start + open.length, end) };
};

/** A posList of latitude, longitude and height triples as a WKT ring of
 * longitude and latitude. */
function ring(posList) {
  const values = posList.trim().split(/\s+/).map(Number);
  if (values.length % 3 !== 0 || values.some((v) => !Number.isFinite(v))) throw new Error("A posList that is not latitude, longitude, height triples.");
  const points = [];
  for (let i = 0; i < values.length; i += 3) points.push(`${values[i + 1]} ${values[i]}`);
  return `(${points.join(", ")})`;
}

/**
 * Every building in one CityGML file of PLATEAU's building models: its id,
 * its name where it has one, its measured height, its city code, its
 * survey year and its roof outline (LOD0) as a WKT multipolygon of
 * longitude and latitude. The file is read as text: nothing in it is run.
 */
export function readBuildings(text) {
  const buildings = [];
  let parts = 0;
  let from = 0;
  for (;;) {
    const block = between(text, "<bldg:Building ", "</bldg:Building>", from);
    if (!block) break;
    from = block.end;
    const body = block.inner;
    if (body.includes("<bldg:BuildingPart")) parts++;
    const id = /^gml:id="([^"]+)"/.exec(body)?.[1] ?? null;
    const height = /<bldg:measuredHeight uom="m">([^<]+)<\/bldg:measuredHeight>/.exec(body)?.[1];
    const city = /<uro:city [^>]*>(\d+)<\/uro:city>/.exec(body)?.[1] ?? null;
    const survey = /<uro:surveyYear>(\d{4})<\/uro:surveyYear>/.exec(body)?.[1];
    const name = /<gml:name>([^<]+)<\/gml:name>/.exec(body)?.[1] ?? null;
    const polygons = [];
    let at = 0;
    for (;;) {
      const edge = between(body, "<bldg:lod0RoofEdge>", "</bldg:lod0RoofEdge>", at);
      if (!edge) break;
      at = edge.end;
      let p = 0;
      for (;;) {
        const polygon = between(edge.inner, "<gml:Polygon", "</gml:Polygon>", p);
        if (!polygon) break;
        p = polygon.end;
        const rings = [...polygon.inner.matchAll(/<gml:posList[^>]*>([^<]+)<\/gml:posList>/g)].map((m) => ring(m[1]));
        if (rings.length) polygons.push(`(${rings.join(", ")})`);
      }
    }
    buildings.push({
      id,
      name,
      height: height === undefined ? null : Number(height),
      city,
      surveyYear: survey === undefined ? null : Number(survey),
      wkt: polygons.length ? `MULTIPOLYGON (${polygons.join(", ")})` : null,
    });
  }
  return { buildings, withParts: parts };
}
