/*
 * Build script – creates a self-contained, per-browser extension bundle from
 * the single Firefox-oriented source tree (no second project):
 *
 *   dist/firefox/  – Firefox/AMO build (event-page background, no polyfill)
 *   dist/chrome/   – Chrome Web Store build:
 *                      * background.service_worker = background/service-worker.js
 *                      * `browser.*` polyfill (lib/browser-polyfill.min.js) is
 *                        added to every context that uses it
 *                      * browser_specific_settings is removed
 *   <name>-firefox-<version>.xpi – installable Firefox package at the root
 *                                  (built from dist/firefox)
 *   <name>-chrome-<version>.zip  – Chrome Web Store package at the root (built
 *                                  from dist/chrome)
 *
 * Usage:  node tools/build.mjs   (or: npm run build)
 *
 * No third-party build dependencies (Node.js >= 16).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");

// Per-browser package names at the project root, derived once from the source
// manifest (e.g. watcharr-scrobbler-firefox-1.1.xpi). An .xpi is a ZIP
// container: Firefox installs it directly on double-click / drag & drop.
// The Chrome Web Store upload form only accepts a plain .zip file.
const rootManifest = JSON.parse(
  readFileSync(join(root, "manifest.json"), "utf8"),
);
const addonId = rootManifest.browser_specific_settings?.gecko?.id?.split("@")[0];
const baseName = addonId || "watcharr-scrobbler";
const FIREFOX_XPI = `${baseName}-firefox-${rootManifest.version}.xpi`;
const CHROME_ZIP = `${baseName}-chrome-${rootManifest.version}.zip`;

// ANY root package of this add-on (`<name>-firefox-1.1.xpi`, `<name>-chrome-2.0.zip`, …)
// must stay out of a store package – not only the ones of the current version.
// Build order: the Firefox package is written before the stale Chrome package of
// an older version is removed, so a name check limited to the current version
// would nest the old ZIP inside the new XPI.
const ROOT_PACKAGE_RE = new RegExp(
  "^" +
    baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
    "-.*\\.(xpi|zip)$",
);

// Files/folders that are never part of a store package.
const COMMON_EXCLUDE = new Set([
  ".git",
  ".gitignore",
  ".DS_Store",
  ".venv",
  "node_modules",
  "web-ext-artifacts",
  "dist",
  "tools",
  "package.json",
  "package-lock.json",
  "README.md",
  FIREFOX_XPI, // root packages – never inside a store package
  CHROME_ZIP,
]);

// Chrome-only artifacts that must NOT end up in the Firefox package.
const FIREFOX_EXCLUDE = new Set([
  ...COMMON_EXCLUDE,
  "lib", // browser.* polyfill (not needed – Firefox has a native `browser`)
  "background/service-worker.js", // Chrome service-worker entry
]);

/** Copies `src` into `dest`, skipping every path in `exclude` (root-relative). */
function copyTree(src, dest, exclude, rel = "") {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (exclude.has(relPath) || ROOT_PACKAGE_RE.test(relPath)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, exclude, relPath);
    } else {
      copyFileSync(from, to);
    }
  }
}

/**
 * Removes leftover store packages of previous versions from the project root
 * (e.g. an old watcharr-scrobbler-firefox-1.1.xpi next to the freshly built
 * 1.2 one), so that after a build only the packages of the current version
 * exist. Called per browser kind BEFORE the new package is written – stale
 * packages from the root would otherwise be copied into the dist tree (only
 * the current file name is excluded there) and end up nested inside the new
 * package.
 */
function cleanupOldPackages(browser, extension) {
  const prefix = `${baseName}-${browser}-`;
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(prefix) && entry.endsWith(`.${extension}`)) {
      console.log(`  entferne altes Paket: ${entry}`);
      unlinkSync(join(root, entry));
    }
  }
}

/** Adds the polyfill <script> tag to an HTML page (Chrome only). */
function injectPolyfillIntoHtml(filePath) {
  const needle = '<script src="../i18n/locale.js"></script>';
  let html = readFileSync(filePath, "utf8");
  if (!html.includes(needle)) {
    throw new Error(
      `Cannot inject polyfill into ${filePath}: anchor not found.`,
    );
  }
  html = html.replace(
    needle,
    '<script src="../lib/browser-polyfill.min.js"></script>\n    ' + needle,
  );
  writeFileSync(filePath, html);
}

/** Builds dist/firefox – essentially the source tree without Chrome-only files. */
function buildFirefox() {
  const out = join(distDir, "firefox");
  rmSync(out, { recursive: true, force: true });
  copyTree(root, out, FIREFOX_EXCLUDE);
  return out;
}

/** Builds dist/chrome – polyfilled MV3 with a service-worker background. */
function buildChrome() {
  const out = join(distDir, "chrome");
  rmSync(out, { recursive: true, force: true });
  copyTree(root, out, COMMON_EXCLUDE);

  // --- manifest -----------------------------------------------------
  const manifestPath = join(out, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  // Firefox-specific block is not needed/not wanted by the Chrome Web Store.
  delete manifest.browser_specific_settings;

  // Chrome only supports a single service-worker background script.
  manifest.background = { service_worker: "background/service-worker.js" };

  // The polyfill must run first in every content script (same isolated world).
  manifest.content_scripts = (manifest.content_scripts || []).map((cs) => ({
    ...cs,
    js: ["lib/browser-polyfill.min.js", ...(cs.js || [])],
  }));

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // --- HTML pages (options / popup / history) ----------------------
  for (const page of [
    "options/options.html",
    "popup/popup.html",
    "history/history.html",
  ]) {
    injectPolyfillIntoHtml(join(out, page));
  }

  // --- dynamic content-script injection (background/services.js) --------
  // The content scripts that are injected on demand (into tabs opened before
  // the extension was loaded) are listed per service in the `contentScripts`
  // arrays of background/services.js. In the Chrome build the `browser.*`
  // polyfill must run first in every one of those lists as well.
  const servicesJs = join(out, "background/services.js");
  let sjs = readFileSync(servicesJs, "utf8");
  const newSjs = sjs.replace(
    /(contentScripts:\s*\[)(\s*\n\s*)/g,
    '$1$2"lib/browser-polyfill.min.js",$2',
  );
  if (newSjs === sjs) {
    throw new Error(
      "Cannot inject polyfill into background/services.js: contentScripts arrays not found.",
    );
  }
  writeFileSync(servicesJs, newSjs);

  return out;
}

/* -- ZIP writer (no third-party dependencies) -------------------------------- */

// Minimal, dependency-free ZIP archive writer (deflate via node:zlib). Used to
// package dist/firefox into a ready-to-submit file for addons.mozilla.org.

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

// Collects every file under `dir` as a ZIP entry (paths use forward slashes).
// macOS Finder junk (.DS_Store / ._*) is skipped – never part of a package.
function collectZipFiles(dir, prefix = "") {
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name.startsWith("._")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...collectZipFiles(full, rel));
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
    const comp = deflateRawSync(data);
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
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    chunks.push(local, nameBuf, comp);

    // Central directory header.
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed to extract
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(8, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra field length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(0, 38); // external attributes
    cd.writeUInt32LE(offset, 42); // offset of local header

    // A central directory record is the fixed header above FOLLOWED by the
    // file name (and optional extra/comment fields, none here).
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(central);

  // End of central directory record.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // this disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// Packages the contents of `dir` into `<outDir>/<fileName>` (ZIP container) and
// returns the resulting path. Used to place the installable .xpi at the root.
function writePackage(dir, outDir, fileName) {
  const out = join(outDir, fileName);
  writeFileSync(out, buildZip(collectZipFiles(dir)));
  return out;
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const targetArg = process.argv.indexOf("--target");
const target = targetArg >= 0 ? process.argv[targetArg + 1] || "all" : "all";

const results = [];
let firefoxXpi = null;
let chromeZip = null;
if (target === "firefox" || target === "all") {
  cleanupOldPackages("firefox", "xpi");
  const out = buildFirefox();
  results.push(["Firefox", out]);
  // Installable .xpi at the project root – its content equals dist/firefox.
  // Firefox installs it on double-click / drag & drop; addons.mozilla.org
  // accepts the .xpi for submission as well.
  firefoxXpi = writePackage(out, root, FIREFOX_XPI);
}
if (target === "chrome" || target === "all") {
  cleanupOldPackages("chrome", "zip");
  const out = buildChrome();
  results.push(["Chrome", out]);
  // Ready-to-upload Chrome Web Store package at the project root – its content
  // equals dist/chrome. The store only accepts a .zip file.
  chromeZip = writePackage(out, root, CHROME_ZIP);
}

console.log("Build finished:");
for (const [name, dir] of results) {
  console.log(`  ${name}: ${dir}`);
}
if (firefoxXpi) {
  console.log(
    `  Firefox-XPI (in Firefox ziehen = installieren): ${firefoxXpi}`,
  );
}
if (chromeZip) {
  console.log(
    `  Chrome-ZIP (direkt im Chrome Web Store hochladen): ${chromeZip}`,
  );
}
if (target === "chrome" || target === "all") {
  console.log(
    "  → Chrome testen: chrome://extensions → „Entwicklermodus“ → „Entpackte Erweiterung laden“ → dist/chrome",
  );
}
if (target === "firefox" || target === "all") {
  console.log(
    "  → Firefox-XPI in Firefox ziehen (temporär installieren) oder bei addons.mozilla.org einreichen.",
  );
}
