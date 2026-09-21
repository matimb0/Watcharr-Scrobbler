/*
 * Shared helpers for the service content scripts.
 *
 * Loaded before the per-service scripts – see the `contentScripts` arrays in
 * background/services.js (the manifest lists the same files in the same order).
 */
"use strict";

(function () {
  /**
   * Creates a pacer that lets a call through at most once per `gapMs`.
   * Used to keep page-based history crawls from hammering the service while
   * they walk through hundreds of pages.
   */
  function createThrottle(gapMs) {
    let lastAt = 0;
    return async function throttle() {
      const wait = lastAt + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastAt = Date.now();
    };
  }

  /** Stable state key of a playing item (title + season/episode for series). */
  function identityKey(meta) {
    if (meta.type === "tv") {
      return (
        "tv|" +
        meta.title.toLowerCase().trim() +
        "|S" +
        meta.seasonNumber +
        "E" +
        meta.episodeNumber
      );
    }
    return "movie|" + meta.title.toLowerCase().trim();
  }

  globalThis.WatcharrContentUtil = { createThrottle, identityKey };
})();
