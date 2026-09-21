/*
 * Chrome-specific transforms of the build.
 *
 * The source tree targets Firefox. For Chrome MV3 it needs
 *   – a service-worker background instead of the event page,
 *   – no `browser_specific_settings` block,
 *   – the `browser.*` polyfill loaded FIRST in every context that uses it
 *     (extension pages, manifest content scripts, on-demand injected content
 *     scripts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const POLYFILL = "lib/browser-polyfill.min.js";

/** Anchor the polyfill script tag is prepended to (present in every page). */
const HTML_ANCHOR = '<script src="../i18n/locale.js"></script>';

/** Rewrites manifest.json for Chrome MV3. */
function rewriteManifest(outDir) {
  const manifestPath = join(outDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  // Firefox-specific block is not needed/not wanted by the Chrome Web Store.
  delete manifest.browser_specific_settings;

  // Chrome only supports a single service-worker background script.
  manifest.background = { service_worker: "background/service-worker.js" };

  // The polyfill must run before the content scripts (same isolated world).
  manifest.content_scripts = (manifest.content_scripts || []).map((entry) => ({
    ...entry,
    js: [POLYFILL, ...(entry.js || [])],
  }));

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

/** Adds the polyfill <script> tag to one HTML page. */
function injectPolyfillIntoHtml(filePath) {
  const html = readFileSync(filePath, "utf8");
  if (!html.includes(HTML_ANCHOR)) {
    throw new Error(
      `Cannot inject polyfill into ${filePath}: anchor not found.`,
    );
  }
  writeFileSync(
    filePath,
    html.replace(
      HTML_ANCHOR,
      `<script src="../${POLYFILL}"></script>\n    ${HTML_ANCHOR}`,
    ),
  );
}

/**
 * Adds the polyfill to every `contentScripts` array in background/services.js.
 *
 * Those arrays list the scripts that are injected on demand into tabs that were
 * already open – they are not in the manifest, so the polyfill has to be
 * prepended here as well. A plain textual injection is safe because the file is
 * an ordinary data table (verified by counting the arrays).
 */
function injectPolyfillIntoServiceScripts(filePath) {
  const source = readFileSync(filePath, "utf8");
  const arrays = (source.match(/contentScripts:\s*\[/g) || []).length;
  if (!arrays) {
    throw new Error(
      "Cannot inject polyfill into background/services.js: no contentScripts array found.",
    );
  }
  const updated = source.replace(
    /(contentScripts:\s*\[)/g,
    `$1"${POLYFILL}", `,
  );
  writeFileSync(filePath, updated);
  return arrays;
}

/** Applies all Chrome transforms to an already copied dist/chrome tree. */
export function applyChromeBuild(outDir) {
  rewriteManifest(outDir);
  for (const page of [
    "options/options.html",
    "popup/popup.html",
    "history/history.html",
  ]) {
    injectPolyfillIntoHtml(join(outDir, page));
  }
  return injectPolyfillIntoServiceScripts(
    join(outDir, "background/services.js"),
  );
}
