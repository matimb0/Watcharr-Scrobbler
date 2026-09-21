/*
 * Export (service → file) – building and serializing of a history export.
 *
 * Side of the import/export feature that turns service entries into export
 * rows and those rows into the CSV/JSON text of the export file. The files
 * live together with the rest of the feature in content/importexport/ – one
 * file per direction, exactly like every streaming service keeps its logic in
 * content/<service>/<service>-content.js.
 *
 * The functions are pure data processing (no DOM), so the file is loaded where
 * it is needed as a classic script:
 *   – background (background/history.js) builds the export rows,
 *   – the history page serializes them into CSV/JSON text.
 * It exposes the global `WatcharrExport`.
 *
 * The CSV/JSON shapes deliberately stay compatible with the import side
 * (content/importexport/import-content.js) and with other services.
 */
"use strict";

(function () {
  /** ISO-8601 string for a date value (string or number) – null when unusable. */
  function toIsoDateString(v) {
    if (v == null) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
    const d = new Date(v); // ISO-8601 string or numeric ms
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Column order of the CSV export. The header labels are stable machine names
  // (not localized) so the file can be processed by scripts. The `tmdb*`
  // columns stay empty when the export runs without the TMDB enrichment.
  const EXPORT_COLUMNS = [
    "service",
    "serviceId",
    "title",
    "type",
    "year",
    "season",
    "episode",
    "watchedAt",
    "tmdbId",
    "tmdbType",
    "tmdbTitle",
    "tmdbYear",
  ];

  /**
   * Flattens one service entry into the row shape of a history export.
   * The data comes from the service itself (plus which service it came from);
   * the `tmdb*` fields stay empty unless the export additionally resolves the
   * title to TMDB through the Watcharr instance (see `enrichExportRows()` in
   * background/history.js).
   */
  function entryToExportRow(entry, svc) {
    const isTv = !!entry.isTv;
    return {
      service: svc ? svc.name : "",
      serviceId: svc ? svc.id : "",
      title: entry.title || "",
      type: isTv ? "tv" : "movie",
      year: entry.year != null ? entry.year : null,
      season: isTv && entry.season != null ? Number(entry.season) : null,
      episode: isTv && entry.episode != null ? Number(entry.episode) : null,
      watchedAt: toIsoDateString(entry.date),
      // Filled in by `enrichExportRows()` (TMDB lookup through Watcharr).
      tmdbId: null,
      tmdbType: null,
      tmdbTitle: null,
      tmdbYear: null,
    };
  }

  /** Quotes a CSV field when it contains a separator, a quote or a line break. */
  function csvField(value) {
    const s = value == null ? "" : String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** CSV (RFC 4180, comma separated, empty season/episode for movies). */
  function toCsv(rows) {
    const lines = [EXPORT_COLUMNS.join(",")];
    for (const row of rows) {
      lines.push(EXPORT_COLUMNS.map((c) => csvField(row[c])).join(","));
    }
    return lines.join("\r\n") + "\r\n";
  }

  /** ID type of the TMDB columns – "tmdb" (or null without enrichment), so an
   *  importer knows which identifier scheme the file uses. */
  function exportIdType(rows) {
    return rows.some((r) => r && r.tmdbId) ? "tmdb" : null;
  }

  /** JSON export with metadata header (service, date, entry count, ID scheme).
   *  `serviceName` is what the history page shows for the current service (the
   *  caller resolves it, so this module needs no knowledge of the selection). */
  function toJson(rows, serviceName) {
    let version = null;
    try {
      version = browser.runtime.getManifest().version;
    } catch (_) {
      /* manifest not reachable – metadata only */
    }
    return (
      JSON.stringify(
        {
          extension: "Watcharr Scrobbler",
          version,
          service: serviceName,
          exportedAt: new Date().toISOString(),
          count: rows.length,
          // Which IDs the entries carry (null = no TMDB data in this export).
          idType: exportIdType(rows),
          tmdbMatched: rows.filter((r) => r && r.tmdbId).length,
          entries: rows,
        },
        null,
        2,
      ) + "\n"
    );
  }

  /** File name of the export, e.g. "watcharr-scrobbler-netflix-2026-09-16.csv". */
  function filename(serviceId, format) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const stamp =
      d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
    return (
      "watcharr-scrobbler-" +
      (serviceId || "history") +
      "-" +
      stamp +
      (format === "json" ? ".json" : ".csv")
    );
  }

  const api = {
    EXPORT_COLUMNS,
    entryToExportRow,
    toCsv,
    toJson,
    filename,
    exportIdType,
  };

  // Expose on whatever global object this file is loaded into (extension page
  // window, Firefox event page, Chrome service worker).
  const root =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof window !== "undefined"
        ? window
        : self;
  root.WatcharrExport = api;
})();
