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

  /**
   * Splits a release year that a service appended to a title:
   * "Road House (2024)" -> { title: "Road House", year: 2024 }.
   *
   * Prime Video titles its entries with the year in parentheses (its catalog
   * metadata has no year field at all), and such a title finds NOTHING in the
   * TMDB search – the year must be removed from the query and used as the year
   * instead (the search then returns the same-titled entries to pick from).
   * "[2024]", a leading separator and stray spaces are handled as well, but
   * only when a real title remains.
   */
  function splitTitleYear(title) {
    const raw = String(title == null ? "" : title).trim();
    // Title followed by the year in brackets – "Road House (2024)",
    // "Road House [2024]", "Road House (2024) " (the separator is optional).
    const m = raw.match(/^(.*?)[\s\-–—]*[([ ](\d{4})[)\]]\s*$/);
    if (!m) return { title: raw, year: null };
    const name = m[1].trim();
    const year = parseInt(m[2], 10);
    if (!name || !(year >= 1800 && year <= 2200)) {
      return { title: raw, year: null };
    }
    return { title: name, year };
  }

  globalThis.WatcharrContentUtil = {
    createThrottle,
    identityKey,
    splitTitleYear,
  };
})();
