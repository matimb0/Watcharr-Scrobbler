/*
 * Minimal, dependency-free ZIP writer (deflate via node:zlib).
 *
 * Used to package the built extension into the files the stores expect: Firefox
 * installs a `.xpi` (which is a ZIP) directly, the Chrome Web Store only accepts
 * a plain `.zip`.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

let crcTable = null;

function getCrcTable() {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  return crcTable;
}

function crc32(buf) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Collects every file under `dir` as a ZIP entry (forward-slash paths).
 *  macOS Finder junk (.DS_Store / ._*) is skipped – never part of a package. */
function collectFiles(dir, prefix = "") {
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name.startsWith("._")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...collectFiles(full, rel));
    } else {
      entries.push({ name: rel, data: readFileSync(full) });
    }
  }
  return entries;
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const crc = crc32(data);
    const compressed = deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");

    // Local file header.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0, 6); // general purpose flags
    local.writeUInt16LE(8, 8); // compression method: deflate
    local.writeUInt16LE(0, 10); // last-mod time
    local.writeUInt16LE(0, 12); // last-mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    chunks.push(local, nameBuf, compressed);

    // Central directory record (fixed header + file name, no extra/comment).
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); // signature
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed to extract
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(8, 10); // method
    entry.writeUInt16LE(0, 12); // mod time
    entry.writeUInt16LE(0, 14); // mod date
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt16LE(0, 30); // extra field length
    entry.writeUInt16LE(0, 32); // comment length
    entry.writeUInt16LE(0, 34); // disk number start
    entry.writeUInt16LE(0, 36); // internal attributes
    entry.writeUInt32LE(0, 38); // external attributes
    entry.writeUInt32LE(offset, 42); // offset of local header

    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(central);

  // End of central directory record.
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // signature
  end.writeUInt16LE(0, 4); // this disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, end]);
}

/** Packages the contents of `dir` into `<outDir>/<fileName>` and returns its
 *  path. Used to place the installable .xpi / .zip at the project root. */
export function writePackage(dir, outDir, fileName) {
  const out = join(outDir, fileName);
  writeFileSync(out, buildZip(collectFiles(dir)));
  return out;
}
