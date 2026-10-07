/*
 * Merge (file + file -> file) – combining several history exports into one.
 *
 * The history-file feature lives in content/history-file/, one file per
 * direction. Merging sits between the two others: it takes the parsed rows of
 * several export files (content/history-file/import.js), removes duplicates
 * that the different services reported twice (e.g. the same episode on Netflix
 * and Prime Video) and returns them in the row shape the export side writes
 * (content/history-file/export.js).
 *
 * Pure data processing (no DOM, no `browser.*`, no other module at load time),
 * so it can be loaded as a classic script where needed. Exposes the global
 * `WatcharrHistoryFileMerge`.
 */
"use strict";

(function () {
  /** Watch date to the minute – exports differ in the precision they report
   *  (seconds vs. milliseconds), which must not defeat the duplicate check. */
  function dateKey(v) {
    if (!v) return "";
    const time = new Date(v).getTime();
    return isNaN(time) ? "" : String(Math.floor(time / 60000));
  }

  /** Identity of a row: same title, type, episode number and watch minute.
   *  Deliberately WITHOUT the service, so a title that was watched on two
   *  services (Netflix and Prime Video) counts as the same entry. */
  function dedupeKey(row) {
    const title = String(row.title == null ? "" : row.title)
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const num = (v) => (v == null || v === "" ? "" : String(Number(v)));
    return [
      title,
      row.type === "tv" ? "tv" : "movie",
      num(row.season),
      num(row.episode),
      dateKey(row.watchedAt),
    ].join("\u0000");
  }

  /** How much information a row carries – of two duplicates the richer one
   *  survives, so TMDB data / an episode title are never lost to a poorer copy. */
  function rowScore(row) {
    let score = 0;
    if (row.tmdbId != null) score += 8;
    if (row.episodeTitle) score += 2;
    if (row.year != null) score += 1;
    if (row.tmdbYear != null) score += 1;
    if (row.service) score += 1;
    return score;
  }

  /** Newest watch first; rows without a usable date end up last (file order). */
  function newestFirst(rows) {
    const time = (r) => (r.watchedAt ? new Date(r.watchedAt).getTime() : NaN);
    return rows.slice().sort((a, b) => {
      const ta = time(a);
      const tb = time(b);
      if (isNaN(ta) && isNaN(tb)) return 0; // stable: keep the input order
      if (isNaN(ta)) return 1;
      if (isNaN(tb)) return -1;
      return tb - ta;
    });
  }

  /**
   * Merges the row arrays of any number of files into one list: duplicates are
   * dropped (the richest copy wins) and the result is ordered newest first,
   * exactly like a single export file. `total` is the number of input rows,
   * `duplicates` how many of them were dropped.
   */
  function mergeRows(rowSets) {
    const byKey = new Map();
    let total = 0;
    let duplicates = 0;
    for (const set of rowSets || []) {
      for (const row of set || []) {
        if (!row || !row.title) continue;
        total++;
        const key = dedupeKey(row);
        const previous = byKey.get(key);
        if (!previous) {
          byKey.set(key, row);
          continue;
        }
        duplicates++;
        if (rowScore(row) > rowScore(previous)) byKey.set(key, row);
      }
    }
    return { rows: newestFirst([...byKey.values()]), total, duplicates };
  }

  /** One import row as an export row, so the merged list serializes into the
   *  same CSV/JSON shape as a normal export (and stays importable again). */
  function toExportRow(row) {
    const isTv = row.type === "tv";
    return {
      service: row.service || "",
      serviceId: row.serviceId || "",
      title: row.title || "",
      type: isTv ? "tv" : "movie",
      year: row.year != null ? row.year : null,
      season: isTv && row.season != null ? Number(row.season) : null,
      episode: isTv && row.episode != null ? Number(row.episode) : null,
      episodeTitle: isTv ? row.episodeTitle || null : null,
      watchedAt: row.watchedAt || null,
      tmdbId: row.tmdbId != null ? Number(row.tmdbId) : null,
      // Which identifier scheme the row carries – same meaning as in a single
      // export (export.js decides the file-wide value from the rows).
      tmdbType: row.tmdbId != null ? (isTv ? "tv" : "movie") : null,
      tmdbTitle: row.tmdbTitle || null,
      tmdbYear: row.tmdbYear != null ? row.tmdbYear : null,
    };
  }

  function toExportRows(rows) {
    return (rows || []).map(toExportRow);
  }

  /** Unique non-empty value of `field`, e.g. all services of the merged rows. */
  function uniqueValues(rows, field) {
    const seen = new Set();
    for (const row of rows || []) {
      const value = row && row[field];
      if (value) seen.add(String(value));
    }
    return [...seen];
  }

  /** Display name of the merged file ("Netflix + Prime Video"), used as the
   *  metadata header of a JSON export. `fallback` when no file had one. */
  function serviceName(rows, fallback) {
    const names = uniqueValues(rows, "service");
    return names.length ? names.join(" + ") : fallback || "";
  }

  /** Service part of the merged file name: the ids of the source exports
   *  ("netflix-primevideo") or `fallback` when the files carry none. Sorted, so
   *  the name does not depend on the order of the chosen files. */
  function serviceSlug(rows, fallback) {
    const ids = uniqueValues(rows, "serviceId")
      .map((id) =>
        id
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, ""),
      )
      .filter(Boolean);
    return ids.length
      ? [...new Set(ids)].sort().join("-")
      : fallback || "history";
  }

  globalThis.WatcharrHistoryFileMerge = {
    dedupeKey,
    mergeRows,
    toExportRows,
    serviceName,
    serviceSlug,
  };
})();
