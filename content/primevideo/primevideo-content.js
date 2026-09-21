/*
 * Amazon Prime Video – Scrobbler Content Script.
 *
 * Detects what's currently playing on Prime Video (movie vs. series,
 * season/episode), searches for the corresponding medium via the user's
 * Watcharr instance (TMDB ID) and keeps the Watcharr watchlist up to date:
 *   – Series starts            -> Create show as "WATCHING"
 *   – Episode > Threshold      -> Mark episode as watched (FINISHED)
 *   – Movie > Threshold        -> Mark movie as "FINISHED"
 *
 * Unlike Netflix, Prime Video's player is a normal HTML5 <video> element in
 * the DOM and the running item (title / "Season 1, Ep. 4 …") is shown in the
 * player UI – so no MAIN-world probe is needed. Everything is read directly
 * from the page (mirrors the Amazon Prime implementation of Universal Trakt
 * Scrobbler).
 *
 * All Watcharr API calls go through the Background Script (message router),
 * so the token never ends up in the Content Script / on the Prime Video page.
 */
"use strict";

(function () {
  // Idempotency guard: if the Content Script is already running on this page
  // (e.g., injected afterwards via browser.scripting), don't start again.
  if (window.__watcharrPrimeContentInstalled__) return;
  window.__watcharrPrimeContentInstalled__ = true;

  const POLL_INTERVAL_MS = 1500;
  const DEFAULT_THRESHOLD = 90;

  // Only create an item in Watcharr as "WATCHING" after this cumulative
  // playback time – prevents briefly clicked videos (e.g. trailers) from
  // cluttering the watchlist. (5 minutes)
  const WATCHING_AFTER_SECONDS = 300;

  // ---------------------------------------------------------------------------
  // Settings (come from Background via browser.storage.local)
  // ---------------------------------------------------------------------------
  const settings = {
    loaded: false,
    enabled: true,
    configured: false,
    threshold: DEFAULT_THRESHOLD,
  };

  function applySettings(s) {
    if (!s) return;
    settings.enabled = s.enabled !== false;
    settings.threshold =
      typeof s.threshold === "number" && s.threshold > 0 && s.threshold <= 100
        ? s.threshold
        : DEFAULT_THRESHOLD;
    settings.configured =
      typeof s.configured === "boolean"
        ? s.configured
        : !!(s.watcharrUrl && s.token);
    settings.loaded = true;
  }

  async function loadSettings() {
    try {
      const resp = await browser.runtime.sendMessage({
        type: "watcharr:getState",
      });
      if (resp && resp.ok) applySettings(resp.settings);
    } catch (_) {
      settings.loaded = true;
      settings.configured = false;
    }
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings)
      applySettings(changes.settings.newValue);
  });

  // ---------------------------------------------------------------------------
  // Playback & item detection (read directly from the page)
  // ---------------------------------------------------------------------------
  // Selectors of Prime Video's HTML5 player (mirrors UTS).
  const PLAYER_VIDEO_SELECTOR =
    ".dv-player-fullscreen video:not(.tst-video-overlay-player-html5)";
  const TITLE_SELECTOR = ".atvwebplayersdk-title-text";
  const SUBTITLE_SELECTOR = ".atvwebplayersdk-subtitle-text";
  // "Season 1, Ep. 4 The Ghouls" / "Staffel 1, Folge 4 …" (DE accounts)
  const EPISODE_RE =
    /(?:Season|Staffel)\s+(\d+),?\s*(?:Ep\.?|Episode|Folge)\s*(\d+)\s*(.*)/i;

  /** The currently active Prime Video <video> element (or null). */
  function readVideo() {
    const v =
      document.querySelector(PLAYER_VIDEO_SELECTOR) ||
      document.querySelector("video");
    if (!v) return null;
    if (!isFinite(v.duration) || v.duration <= 0) return null;
    return v;
  }

  /** True while any player <video> exists (even if its duration isn't loaded yet). */
  function videoElementExists() {
    return !!(
      document.querySelector(PLAYER_VIDEO_SELECTOR) ||
      document.querySelector("video")
    );
  }

  /**
   * Prime Video reports `currentTime`/`duration` in seconds; this guards
   * against the (rare) millisecond variant Netflix used to ship.
   */
  function normalizeUnits(v) {
    if (!v || typeof v.duration !== "number" || v.duration <= 100000) return v;
    return {
      currentTime:
        typeof v.currentTime === "number"
          ? v.currentTime / 1000
          : v.currentTime,
      duration: v.duration / 1000,
      progress: Math.min(100, (v.currentTime / v.duration) * 100),
      isPaused: v.paused,
      playing: !v.paused && !v.ended,
      ended: !!v.ended,
    };
  }

  function readPlayback() {
    const v = readVideo();
    if (!v) return null;
    return normalizeUnits({
      currentTime: v.currentTime || 0,
      duration: v.duration,
      progress: Math.min(100, (v.currentTime / v.duration) * 100),
      isPaused: v.paused,
      playing: !v.paused && !v.ended,
      ended: !!v.ended,
    });
  }

  /**
   * Reads the currently playing item from the player UI:
   *   title    -> series/movie title  (.atvwebplayersdk-title-text)
   *   subtitle -> "Season 1, Ep. 4 The Ghouls" (series) or empty (movie)
   *
   * Returns a metadata object (same shape as Netflix' metadata) or null when
   * no player item is currently shown (e.g. homepage / trailer preview).
   */
  function readDomItem() {
    const v = readVideo();
    const playerContainer = v && v.closest('[id^="dv-web-player"]');
    const ctx = playerContainer || document;
    const titleEl = ctx.querySelector(TITLE_SELECTOR);
    if (!titleEl) return null;
    const title = (titleEl.textContent || "").trim();
    if (!title) return null;
    const subtitleEl = ctx.querySelector(SUBTITLE_SELECTOR);
    const subtitle = subtitleEl ? (subtitleEl.textContent || "").trim() : "";
    const m = subtitle.match(EPISODE_RE);
    if (m) {
      return {
        type: "tv",
        title,
        year: null,
        seasonNumber: parseInt(m[1], 10),
        episodeNumber: parseInt(m[2], 10),
        episodeTitle: (m[3] || "").trim(),
      };
    }
    return {
      type: "movie",
      title,
      year: null,
      seasonNumber: null,
      episodeNumber: null,
      episodeTitle: null,
    };
  }

  /** Stable state key for an item (per video/identity). */
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

  // ---------------------------------------------------------------------------
  // State per Prime Video item (keyed by identity, see above)
  // ---------------------------------------------------------------------------
  const items = new Map(); // identity -> item
  let currentKey = null; // identity of the item currently playing

  function ensureItem(key) {
    let item = items.get(key);
    if (!item) {
      item = {
        key,
        metadata: null,
        metadataFailed: false,
        tmdb: null,
        searching: false,
        watchedId: null,
        watchedStatus: null,
        adding: false,
        markedEpisodes: new Set(),
        markedEpisodesWatching: new Set(),
        movieFinished: false,
        lastProgress: -1,
        watchedSeconds: 0,
        lastCurrentTime: null,
      };
      items.set(key, item);
    }
    return item;
  }

  // ---------------------------------------------------------------------------
  // Watcharr interaction (identical to the Netflix content script)
  // ---------------------------------------------------------------------------
  function pickBestMatch(results, meta) {
    const norm = (s) => (s || "").toLowerCase().trim();
    const wantType =
      meta.type === "movie"
        ? "tmdb_movie"
        : meta.type === "tv"
          ? "tmdb_tv"
          : null;
    let pool = wantType
      ? results.filter((r) => r.type === wantType)
      : results.slice();
    if (!pool.length) pool = results.slice();

    // 1. exact title match
    for (const r of pool) {
      if (norm(r.name) === norm(meta.title)) return r;
    }
    // 2. title + year
    if (meta.year) {
      for (const r of pool) {
        const y = parseYear(r);
        if (y && y === meta.year) return r;
      }
    }
    // 3. first hit of correct type
    return pool[0] || null;
  }

  function parseYear(r) {
    if (r.year) {
      const y = parseInt(r.year, 10);
      if (!isNaN(y)) return y;
    }
    if (r.releaseDate) {
      const y = parseInt(String(r.releaseDate).slice(0, 4), 10);
      if (!isNaN(y)) return y;
    }
    return null;
  }

  async function searchAndPick(title, year, type) {
    const candidates = [];
    candidates.push(year ? title + " year:" + year : title);
    if (year) candidates.push(title);

    for (const q of candidates) {
      let resp;
      try {
        resp = await browser.runtime.sendMessage({
          type: "watcharr:search",
          query: q,
        });
      } catch (_) {
        return null;
      }
      if (!resp || !resp.ok) continue;
      const results = (resp.data && resp.data.results) || [];
      const best = pickBestMatch(results, { title, year, type });
      if (best) return best;
    }
    return null;
  }

  async function resolveTmdb(item) {
    const meta = item.metadata;
    const best = await searchAndPick(meta.title, meta.year, meta.type);
    if (!best || !best.ids || !best.ids.tmdb) return false;

    item.tmdb = {
      tmdbId: Number(best.ids.tmdb),
      contentType: best.type === "tmdb_movie" ? "movie" : "tv",
      name: best.name || meta.title,
    };
    // If the medium is already in the Watcharr list, search returns
    // the `watched` entry right away.
    if (best.watched && best.watched.id) {
      item.watchedId = best.watched.id;
      item.watchedStatus = best.watched.status;
    }
    return true;
  }

  async function ensureWatched(item) {
    if (!item.tmdb || item.watchedId || item.adding) return;
    item.adding = true;
    try {
      const resp = await browser.runtime.sendMessage({
        type: "watcharr:addWatched",
        tmdbId: item.tmdb.tmdbId,
        contentType: item.tmdb.contentType,
        status: "WATCHING",
      });
      if (resp && resp.ok && resp.data && resp.data.id) {
        item.watchedId = resp.data.id;
        item.watchedStatus = resp.data.status || "WATCHING";
      }
    } finally {
      item.adding = false;
    }
  }

  async function markWatching(item) {
    if (!item.watchedId || item.adding || item.movieFinished) return;
    item.adding = true;
    try {
      const resp = await browser.runtime.sendMessage({
        type: "watcharr:updateWatched",
        id: item.watchedId,
        patch: { status: "WATCHING" },
      });
      if (resp && resp.ok) item.watchedStatus = "WATCHING";
    } finally {
      item.adding = false;
    }
  }

  async function markMovieFinished(item) {
    if (!item.watchedId) return;
    if (item.watchedStatus === "FINISHED") {
      item.movieFinished = true;
      return;
    }
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:updateWatched",
      id: item.watchedId,
      patch: { status: "FINISHED" },
    });
    if (resp && resp.ok) {
      item.watchedStatus = "FINISHED";
      item.movieFinished = true;
    }
  }

  async function markEpisodeWatched(item, seasonNumber, episodeNumber) {
    if (!item.watchedId) return;
    const key = seasonNumber + ":" + episodeNumber;
    if (item.markedEpisodes.has(key)) return;
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:addEpisode",
      watchedId: item.watchedId,
      seasonNumber,
      episodeNumber,
      status: "FINISHED",
    });
    if (resp && resp.ok) item.markedEpisodes.add(key);
  }

  async function markEpisodeWatching(item, seasonNumber, episodeNumber) {
    if (!item.watchedId) return;
    const key = seasonNumber + ":" + episodeNumber;
    if (item.markedEpisodesWatching.has(key)) return;
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:addEpisode",
      watchedId: item.watchedId,
      seasonNumber,
      episodeNumber,
      status: "WATCHING",
    });
    if (resp && resp.ok) item.markedEpisodesWatching.add(key);
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  let ticking = false;

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (!settings.loaded) await loadSettings();
      if (!settings.enabled || !settings.configured) return;

      const pb = readPlayback();
      const ident = readDomItem();
      let key = ident ? identityKey(ident) : null;

      // The player UI can hide its title overlay (or the video can be between
      // two loads with a not-yet-finite duration) while the same video keeps
      // playing – then keep the current item instead of resetting the state.
      if (
        !key &&
        currentKey &&
        items.has(currentKey) &&
        (pb || videoElementExists())
      ) {
        key = currentKey;
      }

      if (!key) {
        // Not watching anything on Prime Video anymore.
        if (items.size) items.clear();
        currentKey = null;
        return;
      }

      if (key !== currentKey) currentKey = key;
      const item = ensureItem(key);
      if (ident && !item.metadata) {
        item.metadata = ident;
      }

      // 0) Capture cumulative playback time: the counter only runs when the
      //    playback position advances – i.e., is actively playing.
      if (pb && pb.currentTime != null && isFinite(pb.currentTime)) {
        if (
          item.lastCurrentTime != null &&
          pb.currentTime > item.lastCurrentTime
        ) {
          item.watchedSeconds += pb.currentTime - item.lastCurrentTime;
        }
        item.lastCurrentTime = pb.currentTime;
      } else {
        item.lastCurrentTime = null;
      }

      // 1) Metadata (already set from the DOM identity when the item started).
      if (!item.metadata && !item.metadataFailed) {
        item.metadata = readDomItem();
        if (!item.metadata) item.metadataFailed = true;
      }
      if (!item.metadata) return;

      // 2) Resolve TMDB ID via Watcharr search
      if (!item.tmdb && !item.searching) {
        item.searching = true;
        try {
          await resolveTmdb(item);
        } finally {
          item.searching = false;
        }
      }
      if (!item.tmdb) return;

      // 3) Ensure in Watcharr watchlist – only after the video has been
      //    watched for longer than WATCHING_AFTER_SECONDS.
      if (item.watchedSeconds > WATCHING_AFTER_SECONDS) {
        const isTv = item.tmdb && item.tmdb.contentType === "tv";
        if (!item.watchedId) {
          await ensureWatched(item);
        } else if (pb && pb.progress < settings.threshold) {
          if (isTv) {
            const sn = item.metadata && item.metadata.seasonNumber;
            const en = item.metadata && item.metadata.episodeNumber;
            if (sn != null && en != null) {
              await markEpisodeWatching(item, sn, en);
            }
          } else if (
            !item.movieFinished &&
            item.watchedStatus !== "WATCHING" &&
            !item.adding
          ) {
            await markWatching(item);
          }
        }
      }
      if (!item.watchedId) return;

      if (!pb) return;

      // 4) Evaluate progress. Once the medium reaches the threshold it is
      //    marked – even while paused (e.g., stopped at 95 %).
      const isMovie = item.tmdb.contentType === "movie";
      const atThreshold = pb.progress >= settings.threshold;
      if (isMovie) {
        if (!item.movieFinished && atThreshold) {
          await markMovieFinished(item);
        }
      } else {
        const sn = item.metadata.seasonNumber;
        const en = item.metadata.episodeNumber;
        if (sn != null && en != null && atThreshold) {
          await markEpisodeWatched(item, sn, en);
        }
      }
      item.lastProgress = pb.progress;
    } finally {
      ticking = false;
    }
  }

  setInterval(tick, POLL_INTERVAL_MS);

  // ---------------------------------------------------------------------------
  // Amazon Prime Video history (for the history page / Watcharr import)
  // ---------------------------------------------------------------------------
  // Endpoints & headers mirror the Amazon Prime implementation of Universal
  // Trakt Scrobbler (deviceTypeID etc. were captured from real traffic).
  const DEVICE_ID = "1a740c71-27ac-409a-a360-549a3dadacc6";
  const DEVICE_TYPE_ID = "AOAGZA014O5RE";

  const api = {
    active: false,
    failed: false,
    error: null,
    hostUrl: "https://www.primevideo.com",
    apiUrl: "https://atv-ps.primevideo.com",
    profileUrl: null,
    historyUrl: null,
    itemUrl: null,
  };

  /**
   * Runs an Amazon API request through the BACKGROUND script.
   *
   * The content script's own fetch is bound by the page's CORS, so requests
   * to the cross-origin Amazon API hosts (atv-ps.primevideo.com etc.) are
   * blocked with a "NetworkError". The background fetch is not subject to the
   * page CORS and – thanks to the <all_urls> host permission – sends the
   * user's Prime Video session cookies, so it behaves like the page itself.
   */
  async function amazonJson(url) {
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:primevideo:api",
      url,
    });
    if (!resp || !resp.ok) {
      if (resp && resp.status) {
        throw new Error("Amazon API request failed (HTTP " + resp.status + ")");
      }
      const err = new Error(
        (resp && resp.error) || "Amazon API request failed.",
      );
      // The background names the host it was not allowed to reach. Carried as a
      // stable code so the history page can translate it AND remember the host,
      // asking for exactly that origin on the next "Reload" click.
      if (resp && resp.blockedOrigin) {
        err.userCode = "network_blocked";
        err.userParams = { origin: resp.blockedOrigin };
      }
      throw err;
    }
    try {
      return JSON.parse(resp.text);
    } catch (_) {
      throw new Error("Amazon API returned invalid JSON.");
    }
  }

  /**
   * Determines the account's marketplace/region and the matching API hosts,
   * exactly like UTS does (GetAppStartupConfig -> homeRegion).
   */
  async function ensureApi() {
    if (api.active) return;
    if (api.failed)
      throw api.error || new Error("Amazon session could not be activated.");

    try {
      const configUrl =
        api.apiUrl +
        "/cdp/usage/GetAppStartupConfig?deviceID=&deviceTypeID=" +
        DEVICE_TYPE_ID +
        "&firmware=1&gascEnabled=false&version=1";
      const config = await amazonJson(configUrl);
      const region = (
        (config.customerConfig && config.customerConfig.homeRegion) ||
        ""
      ).toLowerCase();
      const host =
        (config.territoryConfig &&
          config.territoryConfig.defaultVideoWebsite) ||
        api.hostUrl;

      api.hostUrl = host;
      api.apiUrl = host
        .replace("www.", "")
        .replace(
          "//",
          "//atv-ps" + (region === "na" ? "" : "-" + region) + ".",
        );

      const apiPath = /https:\/\/(?:www\.)?amazon\./.test(host)
        ? "/gp/video/api"
        : "/region/" + region + "/api";

      api.profileUrl = host + apiPath + "/getProfiles";
      api.historyUrl =
        host + apiPath + "/getWatchHistorySettingsPage?widgetArgs=%7B{args}%7D";
      api.itemUrl =
        api.apiUrl +
        "/cdp/catalog/GetPlaybackResources?asin={id}&consumptionType=Streaming&desiredResources=CatalogMetadata&deviceID=" +
        DEVICE_ID +
        "&deviceTypeID=" +
        DEVICE_TYPE_ID +
        "&firmware=1&gascEnabled=true&resourceUsage=CacheResources&videoMaterialType=Feature&titleDecorationScheme=primary-content&uxLocale=en_US";

      api.active = true;
    } catch (err) {
      api.failed = true;
      api.error = new Error(
        "Prime Video session could not be determined – please log in to Prime Video. (" +
          (err.message || String(err)) +
          ")",
      );
      // Keep the stable code/params of the original failure (a blocked host is
      // actionable in the UI – see amazonJson).
      api.error.userCode = (err && err.userCode) || null;
      api.error.userParams = (err && err.userParams) || null;
      throw api.error;
    }
  }

  /** Recursively flattens nested history items down to single views. */
  function flattenHistoryItems(list) {
    const out = [];
    for (const it of list || []) {
      if (it.children && it.children.length > 0) {
        out.push(...flattenHistoryItems(it.children));
      } else if (it && it.gti) {
        out.push(it);
      }
    }
    return out;
  }

  const amazonMetadataCache = new Map();

  async function getAmazonMetadata(id) {
    if (amazonMetadataCache.has(id)) return amazonMetadataCache.get(id);
    const p = (async () => {
      try {
        const meta = await amazonJson(
          api.itemUrl.replace("{id}", encodeURIComponent(id)),
        );
        const cm = meta && meta.catalogMetadata;
        const cat = cm && cm.catalog;
        if (!cm || !cat || !cat.id || !cat.title) return null;
        const ancestors =
          cm.family && Array.isArray(cm.family.tvAncestors)
            ? cm.family.tvAncestors
            : [];
        const seasonCat = ancestors[0] && ancestors[0].catalog;
        const showCat = ancestors[1] && ancestors[1].catalog;
        return {
          id: cat.id,
          entityType: cat.entityType || "",
          // Some media append a version tag, e.g. "Movie [dubbed/de]" (#342).
          title: (cat.title || "").replace(/ \[[\w.]+\/[\w.]+\]$/, ""),
          episodeNumber:
            typeof cat.episodeNumber === "number" ? cat.episodeNumber : null,
          seasonNumber:
            seasonCat && typeof seasonCat.seasonNumber === "number"
              ? seasonCat.seasonNumber
              : null,
          showTitle:
            showCat && showCat.title
              ? showCat.title.replace(/ \[[\w.]+\/[\w.]+\]$/, "")
              : null,
        };
      } catch (_) {
        return null;
      }
    })();
    amazonMetadataCache.set(id, p);
    return p;
  }

  // Incremental loading state for the history page: pages are requested by an
  // ever increasing page number within one `loadId`; the loadId resets the
  // buffer when a brand-new history load starts (e.g. "Reload").
  const HISTORY_PAGE_SIZE = 20;

  // Gentle pacing for the history crawl (mirrors the Netflix content script):
  // ONE pause before a new Amazon history page is pulled – i.e. before every
  // UI page of 20 entries that is not already buffered. This keeps e.g. the
  // "oldest first" full load from crawling through hundreds of Amazon pages at
  // full speed. The parallel metadata enrichment WITHIN a page is NOT
  // throttled, so the page itself still loads quickly.
  const HISTORY_PAGE_GAP_MS = 500;
  let lastHistoryPageAt = 0;
  async function historyThrottle() {
    const now = Date.now();
    const wait = lastHistoryPageAt + HISTORY_PAGE_GAP_MS - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHistoryPageAt = Date.now();
  }

  const historyState = {
    loadId: null,
    started: false,
    reachedEnd: false,
    nextToken: "",
    raw: [], // { gti, time } – newest first, as returned by Amazon
  };

  async function fetchRawHistoryPage() {
    const args = historyState.nextToken
      ? "%22nextToken%22%3A%22" + historyState.nextToken + "%22"
      : "";
    const data = await amazonJson(api.historyUrl.replace("{args}", args));
    const widget = (data.widgets || []).find(
      (w) => w.widgetType === "watch-history",
    );
    if (!widget) {
      historyState.reachedEnd = true;
      return;
    }
    const content = widget.content && widget.content.content;
    if (!content || !content.titles) {
      historyState.reachedEnd = true;
      return;
    }
    const flat = [];
    for (const group of content.titles) {
      for (const it of flattenHistoryItems(group.titles)) {
        flat.push({ gti: it.gti, time: it.time });
      }
    }
    historyState.raw.push(...flat);
    historyState.nextToken = content.nextToken || "";
    if (!content.nextToken) historyState.reachedEnd = true;
  }

  /**
   * Runs `fn` over `items` with at most `limit` parallel workers and returns
   * the results in input order. Prime Video needs one metadata request PER
   * history entry (Amazon only exposes per-ASIN metadata – unlike Netflix,
   * which returns a whole show in one call), so enriching 20 rows
   * sequentially would be very slow.
   */
  async function mapConcurrent(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    };
    const workers = [];
    const n = Math.min(limit, items.length);
    for (let w = 0; w < n; w++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  /** Converts one raw history item into a history-page entry (with metadata). */
  async function enrichRawItem(raw) {
    const meta = await getAmazonMetadata(raw.gti);
    if (!meta) return null;
    if (meta.entityType === "Trailer") return null;
    const date = new Date(raw.time);
    const iso = isNaN(date.getTime()) ? null : date.toISOString();
    if (meta.entityType === "TV Show" || meta.entityType === "Bonus Content") {
      return {
        date: iso,
        isTv: true,
        title: meta.showTitle || meta.title,
        year: null,
        season: meta.seasonNumber,
        episode: meta.episodeNumber,
      };
    }
    return {
      date: iso,
      isTv: false,
      title: meta.title,
      year: null,
      season: null,
      episode: null,
    };
  }

  /** Returns ONE page (HISTORY_PAGE_SIZE entries) of the Prime Video history. */
  async function fetchHistoryPageForUi(page, loadId) {
    if (loadId != null && historyState.loadId !== loadId) {
      historyState.loadId = loadId;
      historyState.started = false;
      historyState.reachedEnd = false;
      historyState.nextToken = "";
      historyState.raw = [];
    }
    if (!historyState.started) {
      await ensureApi();
      historyState.started = true;
    }
    // One pause per UI page before the crawl pulls a new Amazon page (no
    // pause when the requested page is already buffered).
    if (
      historyState.raw.length < (page + 1) * HISTORY_PAGE_SIZE &&
      !historyState.reachedEnd
    ) {
      await historyThrottle();
    }
    // Pull Amazon pages until enough raw entries exist for the requested page.
    while (
      historyState.raw.length < (page + 1) * HISTORY_PAGE_SIZE &&
      !historyState.reachedEnd
    ) {
      await fetchRawHistoryPage();
    }
    const start = page * HISTORY_PAGE_SIZE;
    const slice = historyState.raw.slice(start, start + HISTORY_PAGE_SIZE);
    // One metadata request per entry (Amazon metadata is per-ASIN) – run them
    // in parallel (limited concurrency, order preserved).
    const enriched = await mapConcurrent(slice, 6, enrichRawItem);
    const entries = enriched.filter(Boolean);
    const done =
      historyState.reachedEnd &&
      start + HISTORY_PAGE_SIZE >= historyState.raw.length;
    return { status: "ok", entries, done };
  }

  // ---------------------------------------------------------------------------
  // Popup request: report the current element
  // ---------------------------------------------------------------------------
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "watcharr:getCurrentItem") {
      sendResponse(currentSummary());
      return false;
    }
    // Ping: checks if the Content Script is reachable in the tab.
    if (msg && msg.type === "watcharr:ping") {
      sendResponse({ status: "ok" });
      return false;
    }
    // For the history page: fetch ONE page (20 entries) incrementally.
    if (msg && msg.type === "watcharr:fetchHistoryPage") {
      fetchHistoryPageForUi(msg.page || 0, msg.loadId)
        .then(sendResponse)
        .catch((err) => {
          sendResponse({
            status: "error",
            error: err.message || String(err),
            // Stable code + params (e.g. the host the browser blocked) – the
            // background passes them through to the history page.
            errorCode: (err && err.userCode) || null,
            errorParams: (err && err.userParams) || null,
          });
        });
      return true; // asynchronous response
    }
  });

  function currentSummary() {
    const item = currentKey ? items.get(currentKey) : null;
    const pb = item ? readPlayback() : null;
    return {
      videoId: currentKey,
      title: item
        ? item.tmdb
          ? item.tmdb.name
          : item.metadata
            ? item.metadata.title
            : null
        : null,
      type: item
        ? item.tmdb
          ? item.tmdb.contentType
          : item.metadata
            ? item.metadata.type
            : null
        : null,
      seasonNumber: item && item.metadata ? item.metadata.seasonNumber : null,
      episodeNumber: item && item.metadata ? item.metadata.episodeNumber : null,
      episodeTitle: item && item.metadata ? item.metadata.episodeTitle : null,
      progress: pb ? Math.round(pb.progress) : null,
      isPaused: pb ? pb.isPaused : null,
      watchedStatus: item ? item.watchedStatus : null,
      movieFinished: item ? item.movieFinished : false,
      watchedSeconds: item ? Math.round(item.watchedSeconds) : null,
      watchingAfterSeconds: WATCHING_AFTER_SECONDS,
      threshold: settings.threshold,
    };
  }

  // Let's go
  loadSettings();
  tick();
})();
