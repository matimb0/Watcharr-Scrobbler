/*
 * History workspace (background).
 *
 * Loads the viewing history of the selected service (Netflix / Prime Video /
 * Jellyfin) through its content script, builds a comparison list
 * "service ↔ Watcharr" from it (TMDB resolution via Watcharr search), allows
 * correcting single matches and imports selected titles into Watcharr.
 *
 * Loaded as a classic script before background.js; exposes `WatcharrHistory`
 * and uses `WatcharrClient`, `WatcharrServices`, `WatcharrImportExport` and
 * `WatcharrExport`.
 */
"use strict";

const WatcharrHistory = (() => {
  // Every service view is a separate entry (no grouping by series). BATCH_SIZE
  // entries are fetched, matched and then shown at once.
  const BATCH_SIZE = 20;
  // Safety cap for "oldest first": the services normally end with an empty
  // page much earlier – this only guards against an endless loop.
  const MAX_HISTORY_PAGES = 500;
  // Parallel Watcharr/TMDB lookups while enriching an export: 4 finish a large
  // history quickly without hammering the instance.
  const EXPORT_MATCH_CONCURRENCY = 4;

  let items = []; // entries loaded so far (1 service view = 1 row)
  const itemMap = new Map(); // key -> item, for larger histories
  let page = 0; // next service page to load
  let total = 0; // entries loaded so far
  let done = false; // complete service history loaded?
  let loading = false; // batch currently loading?
  let loadError = null; // last load error (message)
  let loadErrorCode = null; // stable i18n code of the last load error
  let seq = 0; // sequence for stable item keys
  // Show the history OLDEST first? The services return newest first, so this
  // mode loads the complete history once and serves it oldest first.
  let oldestFirst = false;
  // Oldest-first mode: entries already handed to the UI. After the full load
  // `items` is stored oldest -> newest.
  let delivered = 0;
  // Set while a long "oldest first" full load runs so the user can abort it.
  let cancelRequested = false;
  // Running file export of the complete history (same page crawl as the
  // "oldest first" load, but WITHOUT Watcharr lookups – so it also works
  // without a configured Watcharr connection).
  let exportRunning = false;
  let exportCount = 0; // entries collected so far
  // Progress detail of a running export: phase ("collect" = crawling the
  // service pages, "match" = adding TMDB data), rows looked up, rows matched
  // and the row total.
  let exportPhase = "";
  let exportProcessed = 0;
  let exportMatched = 0;
  let exportTotal = 0;

  let serviceId = "netflix"; // service whose history is being loaded
  // Where the current list comes from: "service" (crawled from the open tab)
  // or "file" (entries read from an exported CSV/JSON file).
  let source = "service";
  let fileRows = []; // parsed rows of the loaded file (source === "file")
  let fileName = ""; // name of the loaded file (shown on the history page)
  // Identifies one fresh history load. Passed to the content scripts so paged
  // services (Prime Video) can reset their internal buffer. Netflix ignores it.
  let historyLoadId = 0;

  function refreshItemMap() {
    itemMap.clear();
    for (const it of items) itemMap.set(it.key, it);
  }

  const log = (...a) => console.log("[watcharr-bg]", ...a);
  const logErr = (...a) => console.error("[watcharr-bg]", ...a);

  /** Builds a user-facing Error with a stable i18n code + params. The UI
   *  translates these codes (see history/history.js) instead of showing raw
   *  extension-authored text. */
  function userError(code, message, params) {
    const e = new Error(message);
    e.userCode = code;
    e.userParams = params || {};
    return e;
  }

  const normTitle = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

  async function getSettings() {
    const d = await browser.storage.local.get("settings");
    return d.settings || {};
  }

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

  /** Requests that a running "oldest first" full-history load be aborted. */
  function cancelHistoryLoad() {
    cancelRequested = true;
  }

  /**
   * Tabs of one service. Both sources are combined because they fail for
   * different reasons: the registry's URL matching needs a readable tab URL,
   * while the URL pattern is matched by the browser itself and therefore also
   * finds tabs whose URL this context cannot see.
   */
  async function serviceCandidates(svc) {
    const byId = new Map();
    try {
      for (const t of await browser.tabs.query({})) {
        if (
          t &&
          t.id != null &&
          t.url &&
          WatcharrServices.byUrl(t.url) === svc
        ) {
          byId.set(t.id, t);
        }
      }
    } catch (_) {
      /* listing not available – the pattern query below still applies */
    }
    try {
      for (const t of await browser.tabs.query({ url: svc.urlPattern })) {
        if (t && t.id != null && !byId.has(t.id)) byId.set(t.id, t);
      }
    } catch (_) {
      /* pattern query not available */
    }
    return [...byId.values()];
  }

  /** True when the extension may inject scripts into this service's pages.
   *  Host permissions are optional in Firefox: they can be missing even though
   *  the manifest requests them, and injecting then fails. */
  async function hasHostPermission(svc) {
    if (!browser.permissions || !browser.permissions.contains) return true;
    try {
      return await browser.permissions.contains({ origins: [svc.urlPattern] });
    } catch (_) {
      return true; // cannot check – let the injection report the truth
    }
  }

  /**
   * Finds a tab of the current service where the content script is running,
   * injecting it if needed (e.g. the tab was open before the extension loaded).
   * Returns the tab id or throws.
   */
  async function ensureServiceTab() {
    // The Jellyfin server URL is part of the settings – applying them here
    // makes the service's tab pattern available in the background context.
    WatcharrServices.applySettings(await getSettings());
    const svc = WatcharrServices.byId(serviceId) || WatcharrServices.list[0];
    if (!WatcharrServices.hasTabPattern(svc)) {
      logErr("ensureServiceTab: no server configured for", svc && svc.id);
      throw userError(
        "service_not_configured",
        (svc && svc.name ? svc.name : "The service") +
          " is not configured yet. Add its server URL in the settings.",
        { service: svc && svc.name ? svc.name : "" },
      );
    }
    log("ensureServiceTab: searching for open", svc.name, "tabs …");
    const candidates = await serviceCandidates(svc);
    log(
      "ensureServiceTab: candidates:",
      candidates.map((t) => t.id + ":" + (t.url || "?")).join(", ") || "(none)",
    );
    if (!candidates.length) {
      logErr("ensureServiceTab: no open", svc.name, "tab found");
      throw userError(
        "no_service_tab",
        "No open " + svc.name + " tab found. Open " + svc.name + " and log in.",
        { service: svc.name },
      );
    }

    // 1) A tab that already runs the Content Script wins.
    for (const tab of candidates) {
      try {
        await browser.tabs.sendMessage(tab.id, { type: "watcharr:ping" });
        log("ensureServiceTab: Content Script running in tab", tab.id);
        return tab.id;
      } catch (e) {
        // No Content Script in this tab -> try next tab.
      }
    }

    // 2) Otherwise inject it. A tab opened before the extension was loaded has
    //    no Content Script yet – and the injection then needs host permission
    //    for that page, which is why the failure has to be told apart from a
    //    plain injection error: only the permission case is worth explaining
    //    (and only that one is fixed by granting access).
    const permitted = await hasHostPermission(svc);
    log(
      "ensureServiceTab: no Content Script yet | host permission for",
      svc.urlPattern,
      "=",
      permitted,
    );
    if (!permitted && browser.permissions && browser.permissions.getAll) {
      // Decisive when the injection fails: which origins are granted at all?
      try {
        const all = await browser.permissions.getAll();
        log(
          "ensureServiceTab: granted origins:",
          (all.origins || []).join(", ") || "(none)",
        );
      } catch (_) {
        /* diagnostics only */
      }
    }

    let lastError = null;
    let permissionError = false;
    for (const tab of candidates) {
      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: svc.contentScripts,
        });
        // Wait briefly so that injected scripts (and, for Netflix, the probe
        // in the MAIN world) have initialised …
        await new Promise((r) => setTimeout(r, 800));
        // … then check that the tab really answers before handing it out.
        try {
          await browser.tabs.sendMessage(tab.id, { type: "watcharr:ping" });
          log("ensureServiceTab: injected into tab", tab.id, tab.url || "?");
          return tab.id;
        } catch (e) {
          lastError = e;
          logErr(
            "ensureServiceTab: injected but not reachable in tab",
            tab.id,
            tab.url || "?",
            "->",
            e.message,
          );
        }
      } catch (e) {
        lastError = e;
        if (/host permission/i.test(e.message || "")) permissionError = true;
        logErr(
          "ensureServiceTab: injection failed in tab",
          tab.id,
          tab.url || "?",
          "->",
          e.message,
        );
      }
    }

    const reason = (lastError && lastError.message) || String(lastError || "");
    if (permissionError) {
      throw userError(
        "host_permission_missing",
        "Missing access to " + svc.name + ". (" + reason + ")",
        { service: svc.name, reason },
      );
    }
    throw userError(
      "service_tab_prepare",
      svc.name +
        " tab could not be prepared. Please reload the " +
        svc.name +
        " page and try again. (" +
        reason +
        ")",
      { service: svc.name, reason },
    );
  }

  /** Fetches one page of the service history through the content script. */
  async function historyPage(pageIndex) {
    const tabId = await ensureServiceTab();
    log(
      "historyPage: fetching",
      serviceId,
      "page",
      pageIndex,
      "from tab",
      tabId,
    );
    const resp = await browser.tabs.sendMessage(tabId, {
      type: "watcharr:fetchHistoryPage",
      page: pageIndex,
      loadId: historyLoadId,
    });
    if (!resp || resp.status !== "ok") {
      // A real reason from the service/content script (e.g. "please log in")
      // is surfaced through the translated generic wrapper in the UI; the
      // generic code is only used when there is genuinely no reply.
      const reason = (resp && resp.error) || "";
      if (reason) {
        const e = new Error(reason);
        // Content scripts may attach a stable code (e.g. Jellyfin's
        // "jellyfin_not_logged_in" or "network_blocked" with the blocked host)
        // that the history page translates.
        e.userCode = (resp && resp.errorCode) || null;
        e.userParams = (resp && resp.errorParams) || null;
        throw e;
      }
      throw userError(
        "no_service_response",
        "No response from the service tab received.",
      );
    }
    const entries = resp.entries || [];
    log(
      "historyPage: page",
      pageIndex,
      "->",
      entries.length,
      "entries, done:",
      !!resp.done,
    );
    return { entries, done: !!resp.done };
  }

  /**
   * Returns one page of entries for the CURRENT source:
   *  - "service": fetched from the open service tab (content script),
   *  - "file":    slice of the loaded file (paging is purely local).
   * The rest of the module does not need to know where an entry came from.
   */
  async function entriesForPage(pageIndex) {
    if (source !== "file") return historyPage(pageIndex);
    const start = pageIndex * BATCH_SIZE;
    const slice = fileRows.slice(start, start + BATCH_SIZE);
    log(
      "entriesForPage (file): page",
      pageIndex,
      "->",
      slice.length,
      "entries of",
      fileRows.length,
    );
    return {
      entries: slice.map(fileRowToEntry),
      done: start + BATCH_SIZE >= fileRows.length,
    };
  }
  /**
   * Normalizes a watched date from the content script to an ISO-8601 string.
   * Never assume a Date instance survives the message channel: depending on the
   * browser it may already be a string or a number, so `.toISOString()` is
   * never called on the raw value.
   */
  function toIsoDateString(v) {
    if (v == null) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
    const d = new Date(v); // ISO-8601 string or numeric ms
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /**
   * Returns an ISO-8601 string that is `minutes` before the given ISO-8601
   * string (or null when no usable date is given).
   */
  function subtractMinutes(iso, minutes) {
    if (iso == null) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getTime() - minutes * 60000).toISOString();
  }

  /** Builds a separate list entry from a service view (no grouping). */
  function entryToItem(entry) {
    const isTv = !!entry.isTv;
    return {
      key: "h" + seq++,
      isTv,
      title: entry.title,
      year: entry.year || null,
      date: toIsoDateString(entry.date),
      season: isTv && entry.season != null ? entry.season : null,
      episode: isTv && entry.episode != null ? entry.episode : null,
      // TMDB data known in advance (imported file): the row is matched on
      // exactly this TMDB ID instead of guessing by title/year.
      tmdbHint: entry.tmdbHint || null,
      match: null,
      matchError: null,
      matchErrorCode: null,
      // Status of this episode in Watcharr (null | "FINISHED" | "WATCHING" | …)
      episodeStatus: null,
      episodeStatusKnown: false, // false = unknown (fetch failed / no episode info)
      // True only when Watcharr records this exact episode as FINISHED at the
      // same date+time as this service row.
      episodeDateMatched: false,
      selected: false,
      status: "pending",
      error: null,
      errorCode: null,
      resolved: false,
    };
  }

  async function searchWatcharr(title, year) {
    const s = await getSettings();
    if (!s.watcharrUrl || !s.token)
      throw userError("not_configured", "Watcharr is not configured.");
    const c = new WatcharrClient(s);
    const query = year ? title + " year:" + year : title;
    const data = await c.search(query, "multi");
    return (data && data.results) || [];
  }

  function pickBest(results, title, isTv) {
    const wantType = isTv ? "tmdb_tv" : "tmdb_movie";
    let pool = results.filter((r) => r.type === wantType);
    if (!pool.length) pool = results.slice();
    const norm = (s) => (s || "").toLowerCase().trim();
    // exact title match first
    for (const r of pool) if (norm(r.name) === norm(title)) return r;
    return pool[0] || null;
  }

  /** Finds the search result carrying exactly this TMDB ID (or null). */
  function pickByTmdbId(results, tmdbId) {
    const want = Number(tmdbId);
    if (!Number.isInteger(want)) return null;
    for (const r of results) {
      if (r && r.ids && Number(r.ids.tmdb) === want) return r;
    }
    return null;
  }

  /**
   * Resolves a row whose TMDB ID is already known (imported file): search the
   * file's title through Watcharr and use the result with EXACTLY that TMDB ID
   * – no guessing by title, no fallback to another medium. The result also
   * carries the Watcharr state (`watched`), which the import needs to update an
   * existing entry instead of creating a duplicate. Returns null when the ID
   * cannot be resolved (the UI then offers "Change match").
   */
  async function resolveMatchByTmdbId(it) {
    const hint = it.tmdbHint;
    if (!hint || hint.tmdbId == null) return null;
    // Try the TMDB title first, then the title reported by the service.
    const names = [];
    if (hint.title) names.push(hint.title);
    if (it.title && normTitle(hint.title) !== normTitle(it.title)) {
      names.push(it.title);
    }
    const queries = [];
    const push = (q) => {
      if (q && queries.indexOf(q) === -1) queries.push(q);
    };
    for (const n of names) {
      if (hint.year) push(n + " year:" + hint.year);
      else if (it.year) push(n + " year:" + it.year);
      push(n);
    }
    const s = await getSettings();
    const c = new WatcharrClient(s);
    for (const q of queries) {
      let results = [];
      try {
        const data = await c.search(q, "multi");
        results = (data && data.results) || [];
      } catch (e) {
        logErr("resolveMatchByTmdbId: search failed for", q, "->", e.message);
        continue; // a failed query must not abort the whole lookup
      }
      const hit = pickByTmdbId(results, hint.tmdbId);
      if (hit) {
        log(
          "resolveMatchByTmdbId: TMDB",
          hint.tmdbId,
          "resolved via",
          JSON.stringify(q),
        );
        return resultToMatch(hit);
      }
    }
    return null;
  }

  function resultToMatch(result) {
    if (!result || !result.ids) return null;
    // IDs can come as string depending on Watcharr version – convert safely to number.
    const tmdbId = Number(result.ids.tmdb);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
    return {
      tmdbId,
      contentType: result.type === "tmdb_movie" ? "movie" : "tv",
      name: result.name || null,
      posterPath: result.extPosterPath || result.poster_path || null,
      year: result.releaseDate
        ? String(result.releaseDate).slice(0, 4)
        : result.year
          ? String(result.year)
          : null,
      watchedId: (result.watched && result.watched.id) || null,
      watchedStatus: (result.watched && result.watched.status) || null,
    };
  }

  /** "season:episode" lookup key for per-episode maps. */
  function epKey(season, episode) {
    return Number(season) + ":" + Number(episode);
  }

  /** Whole seconds of an ISO date (tolerates server-side ms truncation). */
  function toEpochSeconds(iso) {
    if (iso == null) return null;
    const t = new Date(iso).getTime();
    return isNaN(t) ? null : Math.floor(t / 1000);
  }

  /**
   * Episode status cache per TMDB ID: many history rows belong to the same
   * series, so each is queried only once. The value is a Promise for
   * { ok, episodes, finishedByEp }, so parallel resolutions share one request.
   */
  const watchedEpisodesCache = new Map();

  async function getWatchedEpisodes(tmdbId) {
    if (watchedEpisodesCache.has(tmdbId))
      return watchedEpisodesCache.get(tmdbId);
    const p = (async () => {
      const s = await getSettings();
      const c = new WatcharrClient(s);
      const data = await c.getWatchedShow(tmdbId);
      const w = data && data.watched;
      const raw =
        w && Array.isArray(w.watchedEpisodes) ? w.watchedEpisodes : [];
      const episodes = raw.map((e) => ({
        seasonNumber: Number(e.seasonNumber),
        episodeNumber: Number(e.episodeNumber),
        status: e.status || "FINISHED",
      }));
      // Exact watch events per episode: FINISHED activities whose customDate is
      // set (= the watchedDate we passed to the API) – i.e. the exact date+time
      // the episode was recorded as finished.
      const finishedByEp = new Map(); // epKey -> Set<epoch seconds>
      const acts = w && Array.isArray(w.activity) ? w.activity : [];
      for (const a of acts) {
        if (
          !a ||
          (a.type !== "EPISODE_ADDED" && a.type !== "EPISODE_STATUS_CHANGED")
        ) {
          continue;
        }
        if (!a.customDate) continue; // only exact-dated events count
        let d = null;
        try {
          d = JSON.parse(a.data || "");
        } catch (_) {
          continue;
        }
        if (!d || d.status !== "FINISHED") continue;
        if (d.season == null || d.episode == null) continue;
        const sec = toEpochSeconds(a.customDate);
        if (sec == null) continue;
        const key = epKey(d.season, d.episode);
        if (!finishedByEp.has(key)) finishedByEp.set(key, new Set());
        finishedByEp.get(key).add(sec);
      }
      return { ok: true, episodes, finishedByEp };
    })().catch((err) => {
      logErr("getWatchedEpisodes: Error for tmdbId", tmdbId, "->", err.message);
      return {
        ok: false,
        episodes: [],
        finishedByEp: new Map(),
        error: err.message,
      };
    });
    watchedEpisodesCache.set(tmdbId, p);
    return p;
  }

  /**
   * Checks whether the specific episode (it.season / it.episode) of the matched
   * series is already recorded in Watcharr at THIS exact date+time. Sets:
   *  - it.episodeStatus: current status of the episode (or null),
   *  - it.episodeDateMatched: true when a FINISHED activity has a customDate
   *    equal to the row's date+time (customDate = watchedDate),
   *  - it.episodeStatusKnown (false = unknown).
   */
  async function resolveItemEpisodeStatus(it) {
    it.episodeStatus = null;
    it.episodeDateMatched = false;
    it.episodeStatusKnown = false;
    if (!(
      it.isTv &&
      it.match &&
      it.match.watchedId &&
      it.season != null &&
      it.episode != null
    )) {
      return;
    }
    const res = await getWatchedEpisodes(it.match.tmdbId);
    if (!res.ok) return; // unknown -> UI shows fallback
    const ep = res.episodes.find(
      (e) => e.seasonNumber === it.season && e.episodeNumber === it.episode,
    );
    it.episodeStatus = ep ? ep.status : null; // null = episode not yet watched
    const rowSec = toEpochSeconds(it.date);
    const set = res.finishedByEp.get(epKey(it.season, it.episode));
    it.episodeDateMatched = !!(rowSec != null && set && set.has(rowSec));
    it.episodeStatusKnown = true;
  }

  /**
   * Flattens one service entry into the row shape of a history export.
   * The shape itself lives with the rest of the export code in
   * content/importexport/export-content.js (global `WatcharrExport`).
   */
  function entryToExportRow(entry, svc) {
    return WatcharrExport.entryToExportRow(entry, svc);
  }

  function serializeItem(it) {
    return {
      key: it.key,
      isTv: it.isTv,
      title: it.title,
      year: it.year,
      date: it.date,
      season: it.season,
      episode: it.episode,
      match: it.match,
      matchError: it.matchError,
      matchErrorCode: it.matchErrorCode || null,
      episodeStatus: it.episodeStatus,
      episodeStatusKnown: it.episodeStatusKnown,
      episodeDateMatched: it.episodeDateMatched,
      selected: it.selected,
      status: it.status,
      error: it.error,
      errorCode: it.errorCode || null,
    };
  }

  /**
   * Starts a fresh history load: loads the FIRST BATCH_SIZE entries from the
   * selected service, resolves their matches and returns them. Further entries
   * come later via `more()` when scrolling.
   */
  async function load() {
    log("load: starting history load for", serviceId);
    // The service page crawl of a running export must not be interleaved.
    if (exportRunning)
      throw userError("export_running", "An export is already running.");
    const s = await getSettings();
    if (!s.watcharrUrl || !s.token) {
      logErr(
        "load: Watcharr not configured (url:",
        !!s.watcharrUrl,
        "| token:",
        !!s.token,
        ")",
      );
      throw userError(
        "not_configured",
        "Watcharr is not configured. Please log in through settings first.",
      );
    }
    // Reset state (clear episode cache so a "reload"
    // provides fresh Watcharr status, e.g., after imports).
    items = [];
    itemMap.clear();
    page = 0;
    total = 0;
    done = false;
    loading = false;
    loadError = null;
    seq = 0;
    delivered = 0;
    cancelRequested = false;
    watchedEpisodesCache.clear();
    // New load -> new loadId so paged content scripts (Amazon Prime Video)
    // know that a fresh history starts and reset their internal buffer.
    historyLoadId++;

    const res = oldestFirst
      ? await loadEntireHistory()
      : await fetchMore(BATCH_SIZE);
    log("load: first page loaded, total", res.total, "done", res.done);
    return {
      items: res.items,
      total: res.total,
      done: res.done,
      cancelled: !!res.cancelled,
      // Where this list came from (the page shows the file name in file mode).
      source,
      file: source === "file" ? fileName : "",
      fileTotal: source === "file" ? fileRows.length : 0,
    };
  }

  /** Loads the next batch from the service, resolves the matches, returns it. */
  async function fetchMore(limit) {
    if (loading || done) return { items: [], total, done };
    loading = true;
    loadError = null;
    loadErrorCode = null;
    log("fetchMore: loading", serviceId, "page", page);
    try {
      const { entries, done: d } = await entriesForPage(page);
      const newItems = entries.slice(0, limit).map(entryToItem);
      if (newItems.length) {
        log("fetchMore: resolving matches for", newItems.length, "entries …");
        await Promise.all(newItems.map((it) => resolveItem(it)));
        items.push(...newItems);
        for (const it of newItems) itemMap.set(it.key, it);
        total = items.length;
        page++;
        log(
          "fetchMore: +" + newItems.length + " entries (total " + total + ")",
        );
      }
      // The last page of a service may STILL carry entries (`done` together
      // with rows – Amazon Prime Video ends its history with a partial page),
      // so the rows of that page are taken along before stopping.
      done = !!d || entries.length === 0;
      if (done) log("fetchMore: last page reached, total", total, "entries");
      return { items: newItems.map(serializeItem), total, done };
    } finally {
      loading = false;
    }
  }

  /**
   * Oldest-first mode: loads the COMPLETE history of the selected service, then
   * hands it to the UI starting with the oldest entry. Metadata enrichment
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
        const { entries, done: d } = await entriesForPage(page);
        if (cancelRequested) break; // user aborted while the page was fetched
        if (entries.length) {
          for (const entry of entries) {
            const it = entryToItem(entry);
            items.push(it);
            itemMap.set(it.key, it);
          }
          page++;
          pages++;
        }
        // Stop after an empty page or when the service reports the end – a
        // final partial page (done + rows, e.g. Amazon Prime Video) is kept.
        if (d || !entries.length) done = true;
      }
      if (cancelRequested) {
        log("loadEntireHistory: aborted by user");
        return { cancelled: true, items: [], total, done: false };
      }
      // Page 0 = newest entry, so `items` is newest -> oldest right now.
      // Flip it: items[0] = OLDEST entry -> the UI gets oldest first.
      items.reverse();
      total = items.length;
      log(
        "loadEntireHistory: complete history loaded (",
        total,
        "entries), serving oldest first",
      );
      return await deliverBatch();
    } finally {
      loading = false;
    }
  }

  /** Oldest-first: returns the next chunk of the loaded history. */
  async function deliverBatch() {
    const chunk = items.slice(delivered, delivered + BATCH_SIZE);
    delivered += chunk.length;
    log(
      "deliverBatch: delivering",
      chunk.length,
      "entries (delivered",
      delivered,
      "/",
      total,
      ")",
    );
    await Promise.all(chunk.map((it) => resolveItem(it)));
    return {
      items: chunk.map(serializeItem),
      total,
      done: delivered >= items.length,
    };
  }

  /** Number of service entries fetched so far (progress display). While an
   *  export runs it reports the collected entries instead. */
  function getLoadProgress() {
    return exportRunning ? exportCount : items.length;
  }

  /** Progress DETAIL of a running export (phase + match counters), so the UI
   *  can tell "crawling the history" apart from "adding TMDB data". */
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
   * Resolves ONE export row against TMDB through the user's Watcharr instance
   * (which proxies the TMDB search – same path the history matching uses).
   * Returns the match or null.
   *
   * `cache` holds one Promise per "title|year|type", so every episode of the
   * same series shares one lookup and a long history needs only a few requests.
   */
  function lookupExportTmdb(row, client, cache) {
    const key = normTitle(row.title) + "|" + (row.year || "") + "|" + row.type;
    if (cache.has(key)) return cache.get(key);
    const p = (async () => {
      // Same two-step query as the history matching: first with the year, then
      // a plain title search as fallback.
      const queries = row.year
        ? [row.title + " year:" + row.year, row.title]
        : [row.title];
      for (const q of queries) {
        let results = [];
        try {
          const data = await client.search(q, "multi");
          results = (data && data.results) || [];
        } catch (e) {
          // A single failed lookup must not abort the whole export – the row
          // simply stays without TMDB data.
          logErr(
            "lookupExportTmdb: search failed for",
            row.title,
            "->",
            e.message,
          );
          return null;
        }
        const match = resultToMatch(
          pickBest(results, row.title, row.type === "tv"),
        );
        if (match) return match;
      }
      return null;
    })();
    cache.set(key, p);
    return p;
  }

  /** Writes the TMDB data of a match into an export row. */
  function applyTmdbToRow(row, match) {
    if (!match) return;
    const y = match.year != null ? parseInt(String(match.year), 10) : NaN;
    row.tmdbId = match.tmdbId;
    row.tmdbType = match.contentType;
    row.tmdbTitle = match.name || null;
    row.tmdbYear = isNaN(y) ? null : y;
  }

  /**
   * Adds TMDB data (ID, type, title, year) to all export rows by searching
   * through the Watcharr instance. Runs with limited concurrency so a large
   * history does not flood the instance; `cancelRequested` aborts it.
   */
  async function enrichExportRows(rows, client) {
    const cache = new Map();
    let next = 0;
    const worker = async () => {
      while (next < rows.length && !cancelRequested) {
        const row = rows[next++];
        const match = await lookupExportTmdb(row, client, cache);
        if (cancelRequested) return;
        applyTmdbToRow(row, match);
        if (match) exportMatched++;
        exportProcessed++;
      }
    };
    const workers = [];
    const n = Math.min(EXPORT_MATCH_CONCURRENCY, rows.length);
    for (let w = 0; w < n; w++) workers.push(worker());
    await Promise.all(workers);
  }

  /**
   * Loads the COMPLETE history of the selected service for a FILE EXPORT and –
   * optionally – adds the TMDB data of every entry (resolved through Watcharr).
   *
   * Walks the same pages as `loadEntireHistory()`, but never writes to
   * Watcharr. Without `options.enrich` it needs no Watcharr connection at all.
   * `getLoadProgress()` / `getExportProgress()` report progress,
   * `cancelHistoryLoad()` aborts crawl and matching.
   */
  async function collectForExport(options) {
    const enrich = !!(options && options.enrich);
    if (exportRunning)
      throw userError("export_running", "An export is already running.");
    if (loading)
      throw userError(
        "history_busy",
        "The history is currently being loaded – please try again afterwards.",
      );
    // Fail fast: without a Watcharr connection no TMDB lookup is possible.
    // Better than crawling the whole history first and failing afterwards.
    let client = null;
    if (enrich) {
      const s = await getSettings();
      if (!s.watcharrUrl || !s.token)
        throw userError(
          "not_configured",
          "Watcharr is not configured – TMDB data cannot be added.",
        );
      client = new WatcharrClient(s);
    }
    const svc = WatcharrServices.byId(serviceId) || WatcharrServices.list[0];
    exportRunning = true;
    exportCount = 0;
    exportPhase = "collect";
    exportProcessed = 0;
    exportMatched = 0;
    exportTotal = 0;
    cancelRequested = false;
    // Fresh load id: paged content scripts (Amazon Prime Video) reset their
    // internal buffer, so the export crawls the history from the top.
    historyLoadId++;
    log(
      "collectForExport: collecting complete",
      svc && svc.id,
      "history …",
      enrich ? "(with TMDB data via Watcharr)" : "(without TMDB data)",
    );
    const rows = [];
    try {
      let finished = false;
      let pages = 0;
      let pageIndex = 0;
      while (!finished && pages < MAX_HISTORY_PAGES && !cancelRequested) {
        const { entries, done: d } = await historyPage(pageIndex);
        if (cancelRequested) break; // user aborted while the page was fetched
        for (const entry of entries) rows.push(entryToExportRow(entry, svc));
        exportCount = rows.length;
        // The last page of a service may still carry entries (`done` + rows,
        // e.g. Amazon Prime Video) – so only an empty page is a sure end.
        finished = !!d || entries.length === 0;
        pageIndex++;
        pages++;
      }
      exportTotal = rows.length;
      // Phase 2: TMDB data for the collected rows (optional).
      if (enrich && rows.length && !cancelRequested) {
        exportPhase = "match";
        log("collectForExport: resolving TMDB data for", rows.length, "rows …");
        await enrichExportRows(rows, client);
        log(
          "collectForExport: TMDB data for",
          exportMatched,
          "/",
          rows.length,
          "rows",
        );
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

  // -- Import from a file (export -> import into Watcharr) ---------------------
  // Instead of the open service tab, the list can be filled from an exported
  // CSV/JSON file. Parsing lives in
  // content/importexport/import-content.js (`WatcharrImportExport`); the parsed
  // rows become the same entries a service history delivers, so matching,
  // selection and import work unchanged. Rows carrying TMDB IDs are matched on
  // exactly those IDs.

  /** Parses an exported history file (CSV or JSON) into rows.
   *  Throws when the JSON is malformed / has no usable entries. */
  function parseExportFile(text) {
    return WatcharrImportExport.parse(text);
  }

  /** Converts one normalized file row into a service-style entry. */
  function fileRowToEntry(row) {
    return WatcharrImportExport.toEntry(row);
  }

  /** Orders file rows newest -> oldest, exactly like a service history. */
  function sortFileRowsNewestFirst(rows) {
    return WatcharrImportExport.sortNewestFirst(rows);
  }

  /** Page cap of a full history crawl: guards the service crawl against an
   *  endless loop; a loaded file has as many pages as it has entries. */
  function maxPages() {
    return source === "file"
      ? Math.ceil(fileRows.length / BATCH_SIZE) + 1
      : MAX_HISTORY_PAGES;
  }

  /**
   * Loads the history from a FILE instead of the open service tab and enters
   * file mode (`source = "file"`). From here on everything behaves as usual:
   * rows are matched against Watcharr, shown and importable.
   */
  async function loadFromFile(text, name) {
    if (exportRunning)
      throw userError("export_running", "An export is already running.");
    if (loading)
      throw userError(
        "history_busy",
        "The history is currently being loaded – please try again afterwards.",
      );
    let rows;
    try {
      rows = parseExportFile(text);
    } catch (e) {
      logErr("loadFromFile: parsing failed ->", e.message);
      throw userError(
        "file_unreadable",
        "The file could not be read: " + (e.message || String(e)),
        { reason: e.message || String(e) },
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
    fileRows = sortFileRowsNewestFirst(rows);
    fileName = name || "";
    return await load();
  }

  /** For the history page: load the next batch (inline errors instead of throw). */
  async function more() {
    try {
      // While a file export crawls the history, the service page buffer in the
      // content script belongs to the export – no interleaved page requests.
      if (exportRunning) return { items: [], total, done };
      if (oldestFirst) {
        if (loading)
          return {
            items: [],
            total,
            done: delivered >= items.length,
            error: loadError,
            errorCode: loadErrorCode,
          };
        if (delivered >= items.length)
          return {
            items: [],
            total,
            done: true,
            error: loadError,
            errorCode: loadErrorCode,
          };
        const res = await deliverBatch();
        return {
          items: res.items,
          total: res.total,
          done: res.done,
          error: loadError,
          errorCode: loadErrorCode,
        };
      }
      const res = await fetchMore(BATCH_SIZE);
      return {
        items: res.items,
        total: res.total,
        done: res.done,
        error: loadError,
        errorCode: loadErrorCode,
      };
    } catch (err) {
      logErr("more: Error:", err.message);
      loadError = err.message;
      loadErrorCode = (err && err.userCode) || null;
      return {
        items: [],
        total,
        done,
        error: err.message,
        errorCode: loadErrorCode,
      };
    }
  }

  /** Resolves an entry against Watcharr (TMDB search + episode status). */
  async function resolveItem(it) {
    if (it.resolved) return;
    try {
      if (it.tmdbHint) {
        // Imported file: the TMDB ID is known, so match exactly this entry
        // instead of guessing by title/year.
        it.match = await resolveMatchByTmdbId(it);
        it.matchError = it.match
          ? null
          : "TMDB ID " + it.tmdbHint.tmdbId + " not found in Watcharr";
        it.matchErrorCode = it.match ? null : "tmdb_not_found";
      } else {
        const results = await searchWatcharr(it.title, it.year);
        it.match = resultToMatch(pickBest(results, it.title, it.isTv));
        it.matchError = it.match ? null : "no match in Watcharr";
        it.matchErrorCode = it.match ? null : "no_match";
      }
      // Series: check if exactly THIS episode is already watched in Watcharr.
      await resolveItemEpisodeStatus(it);
    } catch (e) {
      it.matchError = e.message;
      it.matchErrorCode = (e && e.userCode) || null;
    }
    // On load, nothing is pre-selected – the user chooses
    // manually what to import (or uses "Select all").
    it.selected = false;
    it.resolved = true;
  }

  /** Override an item's match with a search result chosen by the user. */
  async function rematch(key, result) {
    const it = itemMap.get(key) || items.find((x) => x.key === key);
    if (!it) return null;
    if (it.key && !itemMap.has(it.key)) itemMap.set(it.key, it);
    it.match = resultToMatch(result);
    it.matchError = it.match ? null : "no match";
    it.matchErrorCode = it.match ? null : "no_match";
    // Determine episode status for the new match (display only).
    await resolveItemEpisodeStatus(it);
    // New match = new state: discard old import status so the
    // row becomes selectable again if the new match is not yet in Watcharr.
    it.status = "pending";
    it.error = null;
    it.errorCode = null;
    // Manually selected matches remain selected (as before).
    it.selected = !!it.match;
    return serializeItem(it);
  }

  async function importOne(c, it) {
    if (!it.match)
      return { status: "skipped", error: "no match", code: "no_match" };
    const { tmdbId, watchedId, watchedStatus } = it.match;
    const watchedDate = it.date || null;

    // ---- Series – single watched episode ----
    if (it.isTv) {
      // Does the series already exist in Watcharr? A matched/rematched row or a
      // series created earlier in this run already carries a watchedId.
      let wid = watchedId;
      if (!wid) {
        // No watchedId known – check explicitly, because creating a duplicate
        // would be an error.
        try {
          const show = await c.getWatchedShow(tmdbId);
          const existing = show && show.watched && Number(show.watched.id);
          if (existing) wid = existing;
        } catch (_) {
          // Check unavailable -> treat as new.
        }
      }
      if (wid) {
        // Series exists: only mark the specific episode as FINISHED.
        if (it.season != null && it.episode != null) {
          try {
            await c.addWatchedEpisode(
              wid,
              it.season,
              it.episode,
              "FINISHED",
              watchedDate,
            );
            return { status: "updated", episodes: 1 };
          } catch (e) {
            return {
              status: "error",
              error: e.message,
              code: (e && e.userCode) || null,
            };
          }
        }
        return { status: "updated", episodes: 0 };
      }
      // Series does NOT exist yet (only /watched endpoints, never /import):
      // 1. add the series as WATCHING with the episode's watch date MINUS one
      //    minute as its "date added", so its creation precedes the finished
      //    episode,
      // 2. mark exactly this episode as FINISHED with the original watch date.
      try {
        const seriesDate = subtractMinutes(watchedDate, 1);
        const created = await c.addWatched(
          tmdbId,
          "tv",
          "WATCHING",
          seriesDate,
        );
        const newWid = created && Number(created.id);
        if (!newWid) {
          return {
            status: "error",
            error: "Create failed (no watchedId in response)",
            code: "create_failed",
          };
        }
        if (it.season != null && it.episode != null) {
          await c.addWatchedEpisode(
            newWid,
            it.season,
            it.episode,
            "FINISHED",
            watchedDate,
          );
        }
        return {
          status: "imported",
          watchedId: newWid,
          episodes: it.season != null && it.episode != null ? 1 : 0,
        };
      } catch (e) {
        return {
          status: "error",
          error: e.message,
          code: (e && e.userCode) || null,
        };
      }
    }

    // ---- Movie ----
    if (watchedId) {
      if (watchedStatus !== "FINISHED") {
        try {
          await c.updateWatched(watchedId, { status: "FINISHED" });
        } catch (e) {
          return {
            status: "error",
            error: e.message,
            code: (e && e.userCode) || null,
          };
        }
      }
      return { status: "updated" };
    }
    // New movie: create directly as FINISHED via /watched, passing the exact
    // watch date (-> Watcharr sets "date added" to it).
    try {
      const created = await c.addWatched(
        tmdbId,
        "movie",
        "FINISHED",
        watchedDate,
      );
      const wid = created && Number(created.id);
      if (!wid) {
        return {
          status: "error",
          error: "Create failed (no watchedId in response)",
          code: "create_failed",
        };
      }
      return { status: "imported", watchedId: wid };
    } catch (e) {
      return {
        status: "error",
        error: e.message,
        code: (e && e.userCode) || null,
      };
    }
  }

  /**
   * Imports the selected titles into Watcharr.
   *
   * Selected entries are always sent ordered by watch date ASCENDING
   * (oldest first) – independent of the order the keys arrive in and of the
   * current display order. So a series imported in this run is created in
   * Watcharr with its oldest (original) watch date. Entries without a usable
   * date are sent last.
   */
  async function importItems(keys) {
    const s = await getSettings();
    if (!s.watcharrUrl || !s.token)
      throw userError("not_configured", "Watcharr is not configured.");
    const c = new WatcharrClient(s);
    const results = [];

    // Resolve the selected items and sort them oldest -> newest.
    // Items without a usable date go last (their relative order is kept).
    const ordered = [];
    for (const key of keys) {
      const it = itemMap.get(key) || items.find((x) => x.key === key);
      if (!it) continue;
      if (it.key && !itemMap.has(it.key)) itemMap.set(it.key, it);
      ordered.push(it);
    }
    ordered.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : Infinity;
      const db = b.date ? new Date(b.date).getTime() : Infinity;
      return da - db;
    });

    // When several episodes of a series that does NOT exist yet are imported
    // in one run, only the first may create it (POST /watched). Every further
    // episode of the SAME series must reuse the new watched ID.
    const createdSeries = new Map(); // tmdbId -> watchedId (created in this run)

    for (const it of ordered) {
      // Episode of a series created just above -> mark the episode on the
      // existing watched entry instead of adding the series again.
      if (
        it.isTv &&
        it.match &&
        !it.match.watchedId &&
        createdSeries.has(it.match.tmdbId)
      ) {
        it.match.watchedId = createdSeries.get(it.match.tmdbId);
      }
      const r = await importOne(c, it);
      it.status = r.status;
      it.error = r.error || null;
      it.errorCode = r.code || null;
      if (r.watchedId && it.match) {
        it.match.watchedId = r.watchedId;
        if (it.isTv) createdSeries.set(it.match.tmdbId, r.watchedId);
      }
      results.push({
        key: it.key,
        title: it.title,
        status: r.status,
        error: r.error,
        code: r.code || null,
        episodes: r.episodes,
        watchedId: r.watchedId || null,
      });
    }
    return results;
  }

  return {
    load,
    more,
    rematch,
    importItems,
    setOldestFirst,
    setService,
    cancelHistoryLoad,
    getLoadProgress,
    getExportProgress,
    collectForExport,
    loadFromFile,
    setSource,
  };
})();
