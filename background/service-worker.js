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
  "errors.js",
  "util.js",
  "settings.js",
  "services.js",
  "service-tabs.js",
  "../content/history-file/import.js",
  "../content/history-file/export.js",
  "watcharr-client.js",
  "jellyfin.js",
  "tmdb-site.js",
  "history/matcher.js",
  "history/loader.js",
  "history/exporter.js",
  "history/importer.js",
  "history/index.js",
  "messages/settings.js",
  "messages/scrobble.js",
  "messages/netflix.js",
  "messages/primevideo.js",
  "messages/history.js",
  "background.js",
);
