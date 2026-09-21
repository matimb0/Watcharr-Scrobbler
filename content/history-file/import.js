/*
 * Import (file -> Watcharr) – parsing of an exported history file.
 *
 * Turns a previously exported CSV or JSON file into the rows/entries the
 * history page works with. The history-file feature lives in
 * content/history-file/, one file per direction.
 *
 * Pure data processing (no DOM, no `browser.*`), so it is loaded as a classic
 * script where needed (background/history/index.js) and exposes the global
 * `WatcharrHistoryFileImport`.
 *
 * The accepted field spellings are deliberately generous, so the import also
 * works for files written by other tools, not only our own export.
 */
"use strict";

(function () {
  /** Normalizes a watched date from a file to an ISO-8601 string. The value
   *  may be a Date, an ISO-8601 string or numeric ms – never call
   *  `.toISOString()` on it directly. */
  function toIsoDateString(v) {
    if (v == null) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Accepted field spellings (lower-case, punctuation stripped) so the import
  // also works for files written by other tools.
  const FILE_TITLE_KEYS = [
    "title",
    "name",
    "showname",
    "showtitle",
    "seriesname",
    "movietitle",
  ];
  const FILE_TMDB_TITLE_KEYS = ["tmdbtitle", "tmdbname", "originaltitle"];
  const FILE_TYPE_KEYS = [
    "type",
    "contenttype",
    "mediatype",
    "kind",
    "category",
  ];
  const FILE_TMDB_TYPE_KEYS = ["tmdbtype", "tmdbmediatype"];
  const FILE_YEAR_KEYS = [
    "year",
    "releaseyear",
    "firstairyear",
    "firstairdate",
    "premiereyear",
  ];
  const FILE_SEASON_KEYS = ["season", "seasonnumber", "seasonindex"];
  const FILE_EPISODE_KEYS = ["episode", "episodenumber", "episodeindex"];
  const FILE_DATE_KEYS = [
    "watchedat",
    "watcheddate",
    "watchedon",
    "date",
    "lastwatched",
    "viewedat",
    "playedat",
    "timestamp",
    "time",
  ];
  const FILE_TMDB_ID_KEYS = ["tmdbid", "tmdb"];
  const FILE_TMDB_YEAR_KEYS = ["tmdbyear"];

  const FILE_TV_TYPES =
    /^(tv|tvshow|tvseries|show|shows|series|serie|episode)$/;
  const FILE_MOVIE_TYPES = /^(movie|movies|film|films|feature|featurefilm)$/;

  /** lower-case, punctuation-free column/key name ("watchedAt" -> "watchedat"). */
  function normalizeKey(key) {
    return String(key == null ? "" : key)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  /** Copies a row/object with all keys normalized (values untouched). */
  function normalizeKeys(obj) {
    const out = {};
    for (const k of Object.keys(obj)) {
      const key = normalizeKey(k);
      if (key && out[key] === undefined) out[key] = obj[k];
    }
    return out;
  }

  /** First non-empty value of `keys` in the normalized object. */
  function pickField(obj, keys) {
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return null;
  }

  function toTrimmedString(v) {
    if (v === undefined || v === null) return "";
    return String(v).replace(/\s+/g, " ").trim();
  }

  function toIntOrNull(v) {
    if (v === undefined || v === null || v === "") return null;
    const n = parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
    return isNaN(n) ? null : n;
  }

  /** Watch date of a file row as ISO-8601 (number = Unix s/ms, string = date). */
  function normalizeFileDate(v) {
    if (v === undefined || v === null || v === "") return null;
    const s = String(v).trim();
    if (/^-?\d+$/.test(s)) {
      const n = Number(s);
      // Same rule as the Netflix content script: < 1e11 => seconds.
      return toIsoDateString(n < 1e11 ? n * 1000 : n);
    }
    return toIsoDateString(s);
  }

  /** "tv" | "movie" for a type string of a file ("show", "film", "episode" …). */
  function normalizeFileType(v) {
    const s = toTrimmedString(v)
      .toLowerCase()
      .replace(/[\s_-]/g, "");
    if (!s) return null;
    if (FILE_TV_TYPES.test(s)) return "tv";
    if (FILE_MOVIE_TYPES.test(s)) return "movie";
    return null;
  }

  /**
   * Turns one raw file record (CSV row / JSON object) into the export row shape
   * used by the import. Returns null for records without a usable title.
   */
  function normalizeFileRow(raw) {
    if (!raw || typeof raw !== "object") return null;
    const o = normalizeKeys(raw);

    const tmdbTitle = toTrimmedString(pickField(o, FILE_TMDB_TITLE_KEYS));
    const title =
      toTrimmedString(pickField(o, FILE_TITLE_KEYS)) || tmdbTitle || "";
    if (!title) return null;

    const season = toIntOrNull(pickField(o, FILE_SEASON_KEYS));
    const episode = toIntOrNull(pickField(o, FILE_EPISODE_KEYS));
    let type =
      normalizeFileType(pickField(o, FILE_TYPE_KEYS)) ||
      normalizeFileType(pickField(o, FILE_TMDB_TYPE_KEYS));
    if (!type) {
      // No usable type column: a row with season+episode is an episode.
      if (typeof o.istv === "boolean") type = o.istv ? "tv" : "movie";
      else type = season != null && episode != null ? "tv" : "movie";
    }

    let year = toIntOrNull(pickField(o, FILE_YEAR_KEYS));
    if (year != null && (year < 1800 || year > 2200)) year = null;

    let tmdbId = toIntOrNull(pickField(o, FILE_TMDB_ID_KEYS));
    // Nested ID shapes used by other exporters: { ids: { tmdb: 123 } }.
    if (tmdbId == null && o.ids && typeof o.ids === "object") {
      tmdbId = toIntOrNull(o.ids.tmdb != null ? o.ids.tmdb : o.ids.tmdbid);
    }
    if (tmdbId == null && o.tmdb && typeof o.tmdb === "object") {
      tmdbId = toIntOrNull(o.tmdb.id);
    }
    if (tmdbId != null && tmdbId <= 0) tmdbId = null;

    let tmdbYear = toIntOrNull(pickField(o, FILE_TMDB_YEAR_KEYS));
    if (tmdbYear != null && (tmdbYear < 1800 || tmdbYear > 2200)) {
      tmdbYear = null;
    }

    return {
      title,
      type,
      year,
      season: type === "tv" ? season : null,
      episode: type === "tv" ? episode : null,
      watchedAt: normalizeFileDate(pickField(o, FILE_DATE_KEYS)),
      tmdbId,
      tmdbTitle: tmdbTitle || null,
      tmdbYear,
    };
  }

  /**
   * Parses CSV text (RFC 4180: quoted fields, doubled quotes, CRLF or LF,
   * optional UTF-8 BOM) into row objects keyed by the header row.
   */
  function parseCsvRows(text) {
    const s = String(text).replace(/^\uFEFF/, "");
    const cells = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      if (quoted) {
        if (ch === '"') {
          if (s.charAt(i + 1) === '"') {
            field += '"';
            i++; // escaped quote
          } else {
            quoted = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && s.charAt(i + 1) === "\n") i++; // CRLF
        row.push(field);
        field = "";
        cells.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      cells.push(row);
    }
    if (!cells.length) return [];

    const header = cells[0].map(normalizeKey);
    const rows = [];
    for (let r = 1; r < cells.length; r++) {
      const line = cells[r];
      // Skip blank lines (e.g. the trailing line break of the export).
      if (line.length === 1 && !String(line[0]).trim()) continue;
      const obj = {};
      for (let c = 0; c < header.length; c++) {
        if (header[c]) obj[header[c]] = line[c];
      }
      rows.push(obj);
    }
    return rows;
  }

  /** Row array of a JSON export: our wrapper ({ entries }) or a plain array. */
  function jsonRows(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    for (const key of [
      "entries",
      "items",
      "history",
      "rows",
      "data",
      "watched",
    ]) {
      if (Array.isArray(data[key])) return data[key];
    }
    return [];
  }

  /**
   * Parses a previously exported history file (CSV or JSON) into normalized
   * rows. Throws when JSON is malformed (CSV parsing cannot fail).
   */
  function parse(text) {
    const t = String(text == null ? "" : text)
      .replace(/^\uFEFF/, "")
      .trim();
    if (!t) return [];
    const first = t.charAt(0);
    let raw;
    if (first === "[" || first === "{") {
      raw = jsonRows(JSON.parse(t)); // throws on malformed JSON
    } else {
      raw = parseCsvRows(t);
    }
    const rows = [];
    for (const r of raw) {
      const row = normalizeFileRow(r);
      if (row) rows.push(row);
    }
    return rows;
  }

  /** Converts one normalized file row into a service-style entry. */
  function toEntry(row) {
    const isTv = row.type === "tv";
    // TMDB data from the file: the row is then matched on exactly this ID.
    const hint =
      row.tmdbId != null
        ? {
            tmdbId: row.tmdbId,
            title: row.tmdbTitle || row.title,
            year: row.tmdbYear != null ? row.tmdbYear : row.year,
          }
        : null;
    return {
      isTv,
      title: row.title,
      year: row.year,
      date: row.watchedAt,
      season: isTv ? row.season : null,
      episode: isTv ? row.episode : null,
      tmdbHint: hint,
    };
  }

  /**
   * Orders file rows newest -> oldest, exactly like a service history delivers
   * them (our own export writes them in that order). Rows without a date end up
   * last, so display order and "oldest first" mode behave identically no
   * matter in which order the file was written.
   */
  function sortNewestFirst(rows) {
    const time = (r) => (r.watchedAt ? new Date(r.watchedAt).getTime() : NaN);
    return rows.slice().sort((a, b) => {
      const ta = time(a);
      const tb = time(b);
      if (isNaN(ta) && isNaN(tb)) return 0; // stable: keep file order
      if (isNaN(ta)) return 1; // without date -> to the end (oldest)
      if (isNaN(tb)) return -1;
      return tb - ta; // newest first
    });
  }

  globalThis.WatcharrHistoryFileImport = {
    parse,
    toEntry,
    sortNewestFirst,
  };
})();
