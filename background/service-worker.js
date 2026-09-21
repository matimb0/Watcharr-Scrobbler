/*
 * Chrome MV3 background entry (service worker).
 *
 * Chrome only supports `background.service_worker` with a *single* file, so
 * this worker loads the shared background modules plus the `browser.*`
 * polyfill. It is used only by the Chrome build (dist/chrome) – Firefox uses
 * the manifest's `background.scripts` (event page) and never loads this file.
 *
 * Note: `importScripts()` is synchronous and only available in classic
 * workers (service worker / worker), which is why this entry file exists.
 */
"use strict";

importScripts(
  "../lib/browser-polyfill.min.js",
  "services.js",
  "service-tabs.js",
  "../content/importexport/import-content.js",
  "../content/importexport/export-content.js",
  "watcharr-client.js",
  "history.js",
  "background.js",
);
