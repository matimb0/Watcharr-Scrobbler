/*
 * Build script – creates a self-contained, per-browser extension bundle from
 * the single Firefox-oriented source tree (no second project):
 *
 *   dist/firefox/  – Firefox/AMO build (event-page background, no polyfill)
 *   dist/chrome/   – Chrome Web Store build (service worker + `browser.*`
 *                    polyfill, see tools/lib/chrome.mjs)
 *   <name>-firefox-<version>.xpi – installable Firefox package at the root
 *                                  (built from dist/firefox)
 *   <name>-chrome-<version>.zip  – Chrome Web Store package at the root (built
 *                                  from dist/chrome)
 *
 * Usage:  node tools/build.mjs [--target firefox|chrome|all]
 *         (npm run build / build:firefox / build:chrome)
 *
 * Helpers: tools/lib/zip.mjs writes the ZIP containers, tools/lib/chrome.mjs
 * applies the Chrome-only changes. No third-party build dependencies
 * (Node.js >= 16).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { writePackage } from "./lib/zip.mjs";
import { applyChromeBuild } from "./lib/chrome.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");

// Package names at the project root, derived from the source manifest
// (e.g. watcharr-scrobbler-firefox-1.3.xpi). An .xpi is a ZIP container that
// Firefox installs on double-click / drag & drop; the Chrome Web Store upload
// form only accepts a plain .zip.
const rootManifest = JSON.parse(
  readFileSync(join(root, "manifest.json"), "utf8"),
);
const addonId =
  rootManifest.browser_specific_settings?.gecko?.id?.split("@")[0];
const baseName = addonId || "watcharr-scrobbler";
const FIREFOX_XPI = `${baseName}-firefox-${rootManifest.version}.xpi`;
const CHROME_ZIP = `${baseName}-chrome-${rootManifest.version}.zip`;

// ANY root package of this add-on (`<name>-firefox-1.1.xpi`, …) must stay out of
// a store package – not only the ones of the current version. Build order: the
// Firefox package is written before the stale Chrome package of an older version
// is removed, so a name check limited to the current version would nest the old
// ZIP inside the new XPI.
const ROOT_PACKAGE_RE = new RegExp(
  "^" + baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-.*\\.(xpi|zip)$",
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
  "lib", // browser.* polyfill (Firefox has a native `browser`)
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
 * Removes leftover store packages of previous versions from the project root,
 * so that after a build only the packages of the current version exist. Called
 * per browser kind BEFORE the new package is written: stale packages would
 * otherwise be copied into the dist tree and end up nested in the new package.
 */
function cleanupOldPackages(browser, extension) {
  const prefix = `${baseName}-${browser}-`;
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(prefix) && entry.endsWith(`.${extension}`)) {
      console.log(`  removing stale package: ${entry}`);
      unlinkSync(join(root, entry));
    }
  }
}

/** dist/firefox – essentially the source tree without the Chrome-only files. */
function buildFirefox() {
  const out = join(distDir, "firefox");
  rmSync(out, { recursive: true, force: true });
  copyTree(root, out, FIREFOX_EXCLUDE);
  return out;
}

/** dist/chrome – polyfilled MV3 with a service-worker background. */
function buildChrome() {
  const out = join(distDir, "chrome");
  rmSync(out, { recursive: true, force: true });
  copyTree(root, out, COMMON_EXCLUDE);
  const polyfilled = applyChromeBuild(out);
  console.log(
    `  Chrome: polyfill added to ${polyfilled} contentScripts arrays`,
  );
  return out;
}

/* -------------------------------------------------------------------------- */

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
  firefoxXpi = writePackage(out, root, FIREFOX_XPI);
}

if (target === "chrome" || target === "all") {
  cleanupOldPackages("chrome", "zip");
  const out = buildChrome();
  results.push(["Chrome", out]);
  chromeZip = writePackage(out, root, CHROME_ZIP);
}

console.log("Build finished:");
for (const [name, dir] of results) {
  console.log(`  ${name}: ${dir}`);
}
if (firefoxXpi) {
  console.log(`  Firefox XPI (drop into Firefox to install): ${firefoxXpi}`);
}
if (chromeZip) {
  console.log(`  Chrome ZIP (upload to the Chrome Web Store): ${chromeZip}`);
}
if (target === "chrome" || target === "all") {
  console.log(
    "  → Test in Chrome: chrome://extensions → Developer mode → Load unpacked → dist/chrome",
  );
}
if (target === "firefox" || target === "all") {
  console.log(
    "  → Test in Firefox: drag the XPI into Firefox, or submit it to addons.mozilla.org.",
  );
}
