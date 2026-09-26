/*
 * History workspace (background) – orchestration.
 *
 * Loads the viewing history of the selected service through its content script
 * (background/history/loader.js), builds the comparison list
 * "service ↔ Watcharr" (background/history/matcher.js), imports the selected
 * entries (background/history/importer.js) and exports the complete history to
 * a file (background/history/exporter.js).
 *
 * Exposes `WatcharrHistory`, which is what background.js talks to. Loaded as a
 * classic script; all modules it uses must be loaded before it.
 */
"use strict";

const WatcharrHistory = (() => {
  const { log, logErr, toIsoDateString } = globalThis.WatcharrUtil;
  const userError = WatcharrErrors.create;
  const loader = globalThis.WatcharrHistoryLoader;
  const matcher = globalThis.WatcharrHistoryMatcher;
  const importer = globalThis.WatcharrHistoryImporter;
  const exporter = globalThis.WatcharrHistoryExporter;
  const fileImport = globalThis.WatcharrHistoryFileImport;
  const fileExport = globalThis.WatcharrHistoryFileExport;

  // Every service view is a separate list entry (no grouping by series).
  const BATCH_SIZE = 20;
  // Safety cap for "oldest first": the services normally end with an empty page
  // much earlier – this only guards against an endless loop.
  const MAX_HISTORY_PAGES = 500;

  let items = []; // entries loaded so far (1 service view = 1 row)
  const itemMap = new Map(); // key -> item, for larger histories
  let page = 0; // next service page to load
  let total = 0; // entries loaded so far
  let done = false; // complete service history loaded?
  let loading = false; // batch currently loading?
  let loadError = null; // last load error (message)
  let loadErrorCode = null; // stable i18n code of the last load error
  let seq = 0; // sequence for stable item keys
  let oldestFirst = false; // show the history oldest first?
  let delivered = 0; // oldest-first: entries already handed to the UI
  let cancelRequested = false; // abort a long load / export
  // Running file export (same page crawl as "oldest first", but WITHOUT
  // Watcharr lookups – so it also works without a Watcharr connection).
  let exportRunning = false;
  let exportCount = 0; // entries collected so far
  // Progress detail: phase ("collect" = crawling, "match" = adding TMDB data),
  // rows looked up, rows matched, row total.
  let exportPhase = "";
  let exportProcessed = 0;
  let exportMatched = 0;
  let exportTotal = 0;

  let serviceId = "netflix"; // service whose history is loaded
  let source = "service"; // "service" (open tab) | "file" (imported file)
  let fileRows = []; // parsed rows of the loaded file
  let fileName = ""; // name of the loaded file (shown on the history page)
  // Identifies one fresh load: paged content scripts (Prime Video) reset their
  // internal buffer when it changes.
  let historyLoadId = 0;

  /* ------------------------------------------------------------------ *
   * Session settings
   * ------------------------------------------------------------------ */

  /** Sets the display order for the next load / more (session-only). */
  function setOldestFirst(v) {
    oldestFirst = !!v;
  }

  /** Selects the service whose history is loaded (id from WatcharrServices). */
  function setService(id) {
    if (WatcharrServices.byId(id)) serviceId = id;
  }

  /** Chooses where the next load comes from: "service" or "file". */
  function setSource(v) {
    source = v === "file" ? "file" : "service";
  }

  /** Requests that a running "oldest first" full load / export be aborted. */
  function cancelHistoryLoad() {
    cancelRequested = true;
  }

  /* ------------------------------------------------------------------ *
   * Entries
   * ------------------------------------------------------------------ */

  /** Builds a list entry from a service view / file row (no grouping). */
  function entryToItem(entry) {
    const isTv = !!entry.isTv;
    return {
      key: "h" + seq++,
      isTv,
      title: entry.title,
      year: entry.year || null,
      // Release year AS REPORTED BY THE SERVICE (display only). It falls back to
      // `year` when the service reports one and it is already the search year
      // (Netflix/Jellyfin movies) – never derived from the Watcharr match.
      providerYear:
        entry.providerYear != null ? entry.providerYear : entry.year || null,
      date: toIsoDateString(entry.date),
      season: isTv && entry.season != null ? entry.season : null,
      episode: isTv && entry.episode != null ? entry.episode : null,
      // Season/episode AS REPORTED BY THE SERVICE. `season`/`episode` above are
      // the EFFECTIVE numbers used for matching and importing (they can be
      // derived when the service has no data left for a title), while these two
      // are what the provider side of the comparison renders – strictly the
      // service's own data, never anything Watcharr or a derivation contributed.
      providerSeason: isTv && entry.season != null ? entry.season : null,
      providerEpisode: isTv && entry.episode != null ? entry.episode : null,
      // Provider-side data. It is shown AS-IS on the left of the comparison
      // and is never derived from the Watcharr match (see
      // history/history.js) – title/year/episode of the row belong to the
      // service that reported them.
      episodeTitle: entry.episodeTitle || null,
      providerId: entry.providerId != null ? String(entry.providerId) : null,
      providerType: entry.providerType || null,
      // Reason code from the provider when it could not report a season/episode
      // (shown as a warning on the row, see history/history.js).
      providerNote: entry.providerNote || null,
      // Language the service reported this entry's title in – the episode name
      // is looked up in that language (see background/tmdb-site.js).
      providerLanguage: entry.providerLanguage || null,
      // true when season/episode had to be derived (not reported by the service)
      episodeDerived: false,
      // what the derivation used: "date" (exact watch date) or "name" (episode name)
      episodeSource: null,
      // TMDB data known in advance (imported file): the row is matched on
      // exactly this TMDB id instead of guessing by title/year.
      tmdbHint: entry.tmdbHint || null,
      match: null,
      matchError: null,
      matchErrorCode: null,
      // Name of the matched episode (TMDB, through Watcharr) – only for
      // episode rows and independent of their watched status.
      matchEpisodeName: null,
      episodeStatus: null, // null | "FINISHED" | "WATCHING" | …
      episodeStatusKnown: false, // false = unknown (lookup failed / no episode)
      episodeDateMatched: false, // FINISHED at exactly this date+time
      watcharrDate: null, // recorded watch date of that exact match
      selected: false,
      status: "pending",
      error: null,
      errorCode: null,
      resolved: false,
    };
  }

  /** Serializes an item for the history page (JSON-safe subset). */
  function serializeItem(item) {
    return {
      key: item.key,
      isTv: item.isTv,
      title: item.title,
      year: item.year,
      providerYear: item.providerYear,
      date: item.date,
      season: item.season,
      episode: item.episode,
      providerSeason: item.providerSeason,
      providerEpisode: item.providerEpisode,
      episodeTitle: item.episodeTitle,
      providerId: item.providerId,
      providerType: item.providerType,
      providerNote: item.providerNote || null,
      episodeDerived: !!item.episodeDerived,
      episodeSource: item.episodeSource || null,
      match: item.match,
      matchError: item.matchError,
      matchErrorCode: item.matchErrorCode || null,
      matchEpisodeName: item.matchEpisodeName,
      episodeStatus: item.episodeStatus,
      episodeStatusKnown: item.episodeStatusKnown,
      episodeDateMatched: item.episodeDateMatched,
      watcharrDate: item.watcharrDate,
      selected: item.selected,
      status: item.status,
      error: item.error,
      errorCode: item.errorCode || null,
    };
  }

  /**
   * One page of entries for the CURRENT source:
   *  - "service": fetched from the open service tab (content script),
   *  - "file":    slice of the loaded file (paging is purely local).
   */
  async function entriesForPage(pageIndex) {
    if (source !== "file") {
      return loader.fetchPage(serviceId, historyLoadId, pageIndex);
    }
    const start = pageIndex * BATCH_SIZE;
    const slice = fileRows.slice(start, start + BATCH_SIZE);
    log(
      "entriesForPage (file): page",
      pageIndex,
      "->",
      slice.length,
      "of",
      fileRows.length,
    );
    return {
      entries: slice.map(fileImport.toEntry),
      done: start + BATCH_SIZE >= fileRows.length,
    };
  }

  /** Page cap of a full crawl (a loaded file has as many pages as it needs). */
  function maxPages() {
    return source === "file"
      ? Math.ceil(fileRows.length / BATCH_SIZE) + 1
      : MAX_HISTORY_PAGES;
  }

  /** Resolves one entry against Watcharr (TMDB search + episode status). */
  async function resolveItem(item) {
    if (item.resolved) return;
    try {
      if (item.tmdbHint) {
        // Imported file: the TMDB id is known, so match exactly this entry.
        item.match = await matcher.resolveMatchByTmdbId(item);
        item.matchError = item.match
          ? null
          : "TMDB ID " + item.tmdbHint.tmdbId + " not found in Watcharr";
        item.matchErrorCode = item.match ? null : "tmdb_not_found";
      } else {
        // Title/year match through the typed Watcharr search (see
        // background/history/matcher.js – a year only filters in typed
        // searches, so "multi" is not used for the first attempt).
        item.match = await matcher.searchWatcharr(
          item.title,
          item.year,
          item.isTv,
        );
        item.matchError = item.match ? null : "no match in Watcharr";
        item.matchErrorCode = item.match ? null : "no_match";
      }
      // Series: the service sometimes reports no season/episode (a delisted
      // title has no catalog data at all, e.g. on Netflix). Then the episode is
      // derived automatically, cheapest source first – see
      // matcher.deriveEpisode (watch date, positional name, TMDB episode list
      // in the reported language, TMDB names via Watcharr).
      if (item.match) {
        if (await matcher.deriveEpisode(item)) item.episodeDerived = true;
      }
      // Series: is exactly THIS episode already watched in Watcharr?
      await matcher.resolveItemEpisodeStatus(item);
    } catch (err) {
      item.matchError = err.message;
      item.matchErrorCode = (err && err.userCode) || null;
    }
    // Nothing is pre-selected – the user chooses what to import.
    item.selected = false;
    item.resolved = true;
  }

  /* ------------------------------------------------------------------ *
   * Loading
   * ------------------------------------------------------------------ */

  /**
   * Starts a fresh load: the first BATCH_SIZE entries of the selected service
   * (or of the loaded file), with their matches resolved. Further entries come
   * later via `more()` while scrolling.
   */
  async function load() {
    log("load: starting history load for", serviceId);

    // A running export owns the service page buffer.
    if (exportRunning) {
      throw userError("export_running", "An export is already running.");
    }
    const settings = await WatcharrSettings.get();
    if (!settings.watcharrUrl || !settings.token) {
      logErr("load: Watcharr not configured");
      throw userError(
        "not_configured",
        "Watcharr is not configured. Please log in through settings first.",
      );
    }

    // Reset state (and the episode cache, so a "reload" shows fresh Watcharr
    // status, e.g. after an import).
    items = [];
    itemMap.clear();
    page = 0;
    total = 0;
    done = false;
    loading = false;
    loadError = null;
    loadErrorCode = null;
    seq = 0;
    delivered = 0;
    cancelRequested = false;
    matcher.clearCache();
    historyLoadId++;

    const result = oldestFirst
      ? await loadEntireHistory()
      : await fetchMore(BATCH_SIZE);

    log("load: first page loaded, total", result.total, "done", result.done);
    return {
      items: result.items,
      total: result.total,
      done: result.done,
      cancelled: !!result.cancelled,
      // Where this list came from (the page shows the file name in file mode).
      source,
      file: source === "file" ? fileName : "",
      fileTotal: source === "file" ? fileRows.length : 0,
    };
  }

  /** Loads the next batch, resolves the matches and returns it. */
  async function fetchMore(limit) {
    if (loading || done) return { items: [], total, done };
    loading = true;
    loadError = null;
    loadErrorCode = null;
    log("fetchMore: loading", serviceId, "page", page);
    try {
      const { entries, done: pageDone } = await entriesForPage(page);
      const newItems = entries.slice(0, limit).map(entryToItem);

      if (newItems.length) {
        await Promise.all(newItems.map((item) => resolveItem(item)));
        items.push(...newItems);
        for (const item of newItems) itemMap.set(item.key, item);
        total = items.length;
        page++;
        log(
          "fetchMore: +" + newItems.length + " entries (total " + total + ")",
        );
      }

      // The last page of a service may STILL carry entries (`done` together with
      // rows – Prime Video ends its history with a partial page), so the rows of
      // that page are taken along before stopping.
      done = !!pageDone || entries.length === 0;
      if (done) log("fetchMore: last page reached, total", total);

      return { items: newItems.map(serializeItem), total, done };
    } finally {
      loading = false;
    }
  }

  /**
   * Oldest-first mode: loads the COMPLETE history of the selected service and
   * serves it to the UI starting with the oldest entry. Metadata enrichment
   * happens per page in the content script; the Watcharr match lookup runs
   * lazily per delivered chunk (same number of requests as the incremental
   * mode, just when the rows are actually shown).
   */
  async function loadEntireHistory() {
    if (loading) return { items: [], total, done };
    loading = true;
    loadError = null;
    try {
      log("loadEntireHistory: loading complete", serviceId, "history …");
      let pages = 0;
      while (!done && pages < maxPages() && !cancelRequested) {
        const { entries, done: pageDone } = await entriesForPage(page);
        if (cancelRequested) break; // aborted while the page was fetched

        if (entries.length) {
          for (const entry of entries) {
            const item = entryToItem(entry);
            items.push(item);
            itemMap.set(item.key, item);
          }
          page++;
          pages++;
        }
        // Stop after an empty page or when the service reports the end – a
        // final partial page (done + rows, e.g. Prime Video) is kept.
        if (pageDone || !entries.length) done = true;
      }

      if (cancelRequested) {
        log("loadEntireHistory: aborted by user");
        return { cancelled: true, items: [], total, done: false };
      }

      // Page 0 is the newest entry, so `items` is newest -> oldest right now.
      items.reverse();
      total = items.length;
      log("loadEntireHistory: complete history loaded (", total, "entries)");
      return await deliverBatch();
    } finally {
      loading = false;
    }
  }

  /** Oldest-first: returns the next chunk of the loaded history. */
  async function deliverBatch() {
    const chunk = items.slice(delivered, delivered + BATCH_SIZE);
    delivered += chunk.length;
    log("deliverBatch:", chunk.length, "entries (", delivered, "/", total, ")");
    await Promise.all(chunk.map((item) => resolveItem(item)));
    return {
      items: chunk.map(serializeItem),
      total,
      done: delivered >= items.length,
    };
  }

  /** Load next batch for the history page (inline errors instead of throw). */
  async function more() {
    const withLoadError = (result) => ({
      items: result.items || [],
      total: result.total != null ? result.total : total,
      done: !!result.done,
      error: loadError,
      errorCode: loadErrorCode,
    });

    try {
      // While an export crawls the history, the page buffer in the content
      // script belongs to the export – no interleaved page requests.
      if (exportRunning) return withLoadError({ items: [], done });

      if (oldestFirst) {
        if (loading || delivered >= items.length) {
          return withLoadError({ items: [], done: true });
        }
        return withLoadError(await deliverBatch());
      }
      return withLoadError(await fetchMore(BATCH_SIZE));
    } catch (err) {
      logErr("more: error:", err.message);
      loadError = err.message;
      loadErrorCode = (err && err.userCode) || null;
      return withLoadError({ items: [], done });
    }
  }

  /* ------------------------------------------------------------------ *
   * Import / rematch
   * ------------------------------------------------------------------ */

  /**
   * Overrides an item: a new match from a search result chosen by the user
   * and/or a corrected season/episode (episode rows). Either part may be
   * omitted – a pure season/episode correction keeps the existing match.
   */
  async function rematch(key, result, episode) {
    const item = itemMap.get(key) || items.find((x) => x.key === key);
    if (!item) return null;
    if (!itemMap.has(item.key)) itemMap.set(item.key, item);

    // Optional correction of season/episode (rows of a series). Season 0
    // (specials) is valid, an episode number starts at 1. Movies are never
    // affected, and a null field leaves the current value untouched.
    if (episode && item.isTv) {
      const season = Number(episode.season);
      const number = Number(episode.episode);
      if (episode.season != null && Number.isInteger(season) && season >= 0) {
        item.season = season;
      }
      if (episode.episode != null && Number.isInteger(number) && number >= 1) {
        item.episode = number;
      }
    }

    // A search result replaces the match; without one the match is kept.
    if (result && result.ids) {
      item.match = matcher.resultToMatch(result);
      item.matchError = item.match ? null : "no match";
      item.matchErrorCode = item.match ? null : "no_match";
    }
    // The user decided: a corrected season/episode or a new match means the
    // AUTOMATIC derivation (see the matcher) is no longer what the row's
    // numbers are based on, so its "determined automatically" marker goes away.
    if ((episode && item.isTv) || (result && result.ids)) {
      item.episodeDerived = false;
      item.episodeSource = null;
    }
    // A new match for an episode row still WITHOUT numbers is derived again for
    // that series (the numbers of the previous match must not be carried over).
    if (result && result.ids && item.isTv && !episode) {
      if (await matcher.deriveEpisode(item)) item.episodeDerived = true;
    }
    // Episode status for the (possibly new) match (display only).
    await matcher.resolveItemEpisodeStatus(item);
    // A new match is a new state: reset the import status so the row becomes
    // selectable again when the new match is not in Watcharr yet.
    item.status = "pending";
    item.error = null;
    item.errorCode = null;
    item.selected = !!item.match;
    return serializeItem(item);
  }

  /** Imports the selected entries (keys from the history page). */
  async function importItems(keys) {
    const entries = [];
    for (const key of keys) {
      const item = itemMap.get(key) || items.find((x) => x.key === key);
      if (!item) continue;
      if (!itemMap.has(item.key)) itemMap.set(item.key, item);
      entries.push(item);
    }
    return importer.importItems(entries);
  }

  /* ------------------------------------------------------------------ *
   * Export
   * ------------------------------------------------------------------ */

  /** Number of service entries fetched so far (progress display). */
  function getLoadProgress() {
    return exportRunning ? exportCount : items.length;
  }

  /** Progress detail of a running export (phase + match counters). */
  function getExportProgress() {
    return {
      running: exportRunning,
      phase: exportPhase,
      processed: exportProcessed,
      matched: exportMatched,
      total: exportTotal,
    };
  }

  /**
   * Loads the COMPLETE history of the selected service for a FILE EXPORT and –
   * optionally – adds the TMDB data of every entry. Walks the same pages as
   * `loadEntireHistory()`, but never writes to Watcharr; without
   * `options.enrich` it needs no Watcharr connection at all.
   * `cancelHistoryLoad()` aborts crawl and matching.
   */
  async function collectForExport(options) {
    const enrich = !!(options && options.enrich);
    if (exportRunning) {
      throw userError("export_running", "An export is already running.");
    }
    if (loading) {
      throw userError(
        "history_busy",
        "The history is currently being loaded – please try again afterwards.",
      );
    }

    // Fail fast: without a Watcharr connection no TMDB lookup is possible.
    // Better than crawling the whole history first and failing afterwards.
    let client = null;
    if (enrich) {
      const settings = await WatcharrSettings.get();
      if (!settings.watcharrUrl || !settings.token) {
        throw userError(
          "not_configured",
          "Watcharr is not configured – TMDB data cannot be added.",
        );
      }
      client = new WatcharrClient(settings);
    }

    const svc = WatcharrServices.byId(serviceId) || WatcharrServices.list[0];
    exportRunning = true;
    exportCount = 0;
    exportPhase = "collect";
    exportProcessed = 0;
    exportMatched = 0;
    exportTotal = 0;
    cancelRequested = false;
    historyLoadId++; // paged content scripts reset their buffer

    log(
      "collectForExport: collecting complete",
      svc && svc.id,
      "history",
      enrich ? "(with TMDB data)" : "(without TMDB data)",
    );

    const rows = [];
    try {
      let finished = false;
      let pages = 0;
      let pageIndex = 0;
      while (!finished && pages < MAX_HISTORY_PAGES && !cancelRequested) {
        const { entries, done: pageDone } = await loader.fetchPage(
          serviceId,
          historyLoadId,
          pageIndex,
        );
        if (cancelRequested) break; // aborted while the page was fetched

        for (const entry of entries) {
          rows.push(fileExport.entryToExportRow(entry, svc));
        }
        exportCount = rows.length;
        // Only an empty page is a sure end – a last page may carry rows AND
        // report done (e.g. Prime Video).
        finished = !!pageDone || entries.length === 0;
        pageIndex++;
        pages++;
      }
      exportTotal = rows.length;

      if (enrich && rows.length && !cancelRequested) {
        exportPhase = "match";
        const result = await exporter.enrich(rows, client, {
          shouldStop: () => cancelRequested,
          onProgress: (processed, matched) => {
            exportProcessed = processed;
            exportMatched = matched;
          },
        });
        exportMatched = result.matched;
      }

      if (cancelRequested) {
        log("collectForExport: aborted by user after", rows.length, "entries");
        return { cancelled: true, rows, total: rows.length };
      }

      log("collectForExport: done –", rows.length, "entries collected");
      // `truncated` = the safety cap stopped the crawl before the service
      // reported the end of the history (the UI warns about it).
      return {
        rows,
        total: rows.length,
        done: true,
        truncated: !finished,
        enriched: enrich,
        matched: exportMatched,
      };
    } finally {
      exportRunning = false;
      exportPhase = "";
    }
  }

  /* ------------------------------------------------------------------ *
   * Import from a file
   * ------------------------------------------------------------------ */

  /**
   * Loads the history from a FILE instead of the open service tab and enters
   * file mode. From here on everything behaves as usual: the rows are matched
   * against Watcharr, shown on the page and importable.
   */
  async function loadFromFile(text, name) {
    if (exportRunning) {
      throw userError("export_running", "An export is already running.");
    }
    if (loading) {
      throw userError(
        "history_busy",
        "The history is currently being loaded – please try again afterwards.",
      );
    }

    let rows;
    try {
      rows = fileImport.parse(text);
    } catch (err) {
      logErr("loadFromFile: parsing failed ->", err.message);
      throw userError(
        "file_unreadable",
        "The file could not be read: " + (err.message || String(err)),
        { reason: err.message || String(err) },
      );
    }
    if (!rows.length) {
      throw userError(
        "file_empty",
        "The file contains no usable entries (CSV or JSON export expected).",
      );
    }

    log("loadFromFile:", name || "(file)", "->", rows.length, "entries");
    source = "file";
    fileRows = fileImport.sortNewestFirst(rows);
    fileName = name || "";
    return await load();
  }

  return {
    load,
    more,
    rematch,
    importItems,
    setOldestFirst,
    setService,
    setSource,
    cancelHistoryLoad,
    getLoadProgress,
    getExportProgress,
    collectForExport,
    loadFromFile,
  };
})();
