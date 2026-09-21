/*
 * Netflix – scrobbler content script.
 *
 * Detects what is playing (movie vs. series, season/episode), finds the medium
 * through the user's Watcharr instance (TMDB ID) and keeps the Watcharr
 * watchlist up to date:
 *   – series start          -> create show as "WATCHING"
 *   – episode > threshold   -> mark episode as watched (FINISHED)
 *   – movie > threshold     -> mark movie as FINISHED
 *
 * All Watcharr API calls go through the background script, so the token never
 * reaches the content script / the Netflix page.
 */
"use strict";

(function () {
  // Idempotency guard: an already running content script (e.g. injected later
  // via browser.scripting) must not start twice – that would double-scrobble
  // and register duplicate message listeners.
  if (window.__watcharrContentInstalled__) return;
  window.__watcharrContentInstalled__ = true;

  const POLL_INTERVAL_MS = 1500;
  const DEFAULT_THRESHOLD = 90;

  // An item is only created as "WATCHING" after this much cumulative playback
  // – prevents briefly clicked videos from cluttering the watchlist.
  const WATCHING_AFTER_SECONDS = 300;

  // ---------------------------------------------------------------------------
  // Settings (from the background via browser.storage.local)
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
  // Playback sources
  // ---------------------------------------------------------------------------
  // Last object reported by the MAIN world probe: { sessions, session, buildIdentifier }.
  const lastProbe = { sessions: [], session: null, buildIdentifier: null };

  document.addEventListener("watcharr:netflix:playback", (e) => {
    const d = e.detail || {};
    lastProbe.sessions = Array.isArray(d.sessions) ? d.sessions : [];
    if (d.session) lastProbe.session = d.session;
    if (d.session && d.session.buildIdentifier) {
      lastProbe.buildIdentifier = d.session.buildIdentifier;
    }
  });

  // Fallback: the <video> element of the page (if the probe doesn't work).
  function readVideoFallback() {
    const v = document.querySelector("video");
    if (!v) return null;
    if (!isFinite(v.duration) || v.duration <= 0) return null;
    return {
      currentTime: v.currentTime || 0,
      duration: v.duration,
      progress: Math.min(100, (v.currentTime / v.duration) * 100),
      isPaused: v.paused,
      playing: !v.paused,
      videoId: null,
    };
  }

  /**
   * Netflix reports currentTime/duration in seconds OR milliseconds depending
   * on the version. Normalizes both to seconds (duration > 100000 is clearly ms
   * – Netflix has no title longer than ~27.7 hours in seconds).
   */
  function normalizePlaybackUnits(pb) {
    if (!pb || typeof pb.duration !== "number" || pb.duration <= 100000)
      return pb;
    return {
      currentTime:
        typeof pb.currentTime === "number"
          ? pb.currentTime / 1000
          : pb.currentTime,
      duration: pb.duration / 1000,
      progress: pb.progress != null ? pb.progress : 0,
      isPaused: pb.isPaused,
      playing: pb.playing,
      videoId: pb.videoId,
    };
  }

  /**
   * Selects the playback info to use:
   *   1. the session whose videoId matches the /watch/<id> URL (avoids
   *      trailers),
   *   2. otherwise the <video> element (only if no foreign session is active).
   */
  function pickPlayback(videoId) {
    const match = lastProbe.sessions.find(
      (s) => s.videoId && String(s.videoId) === videoId,
    );
    if (match) return match;

    const foreignActive = lastProbe.sessions.some(
      (s) => s.playing && s.videoId && String(s.videoId) !== videoId,
    );
    if (foreignActive) return null; // Trailer/preview playing -> don't scrobble

    return readVideoFallback();
  }

  function getVideoId() {
    const m = window.location.pathname.match(/\/watch\/(\d+)/);
    return m ? m[1] : null;
  }

  // ---------------------------------------------------------------------------
  // Netflix metadata (movie or series, title, season/episode)
  // ---------------------------------------------------------------------------
  const metadataPromises = new Map();

  async function fetchNetflixMetadata(videoId) {
    try {
      const url =
        "https://www.netflix.com/nq/website/memberapi/release/metadata?languages=en-US&movieid=" +
        videoId;
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) return null;
      const data = await resp.json();
      const video = data && data.video;
      if (!video || !video.title) return null;

      const meta = {
        type:
          video.type === "movie"
            ? "movie"
            : video.type === "show"
              ? "tv"
              : null,
        title: video.title,
        year: video.year || null,
        seasonNumber: null,
        episodeNumber: null,
        episodeTitle: null,
      };

      if (meta.type === "tv") {
        const seasons = Array.isArray(video.seasons) ? video.seasons : [];
        outer: for (const season of seasons) {
          const eps = Array.isArray(season.episodes) ? season.episodes : [];
          for (const ep of eps) {
            if (String(ep.id) === String(videoId)) {
              meta.seasonNumber =
                typeof season.seq === "number" ? season.seq : null;
              meta.episodeNumber = typeof ep.seq === "number" ? ep.seq : null;
              meta.episodeTitle = ep.title || null;
              break outer;
            }
          }
        }
        // Fallback to currentEpisode
        if (meta.seasonNumber == null && video.currentEpisode) {
          const ce = video.currentEpisode;
          meta.seasonNumber =
            ce.season && typeof ce.season.seq === "number"
              ? ce.season.seq
              : typeof ce.seq === "number"
                ? ce.seq
                : null;
          meta.episodeNumber = typeof ce.seq === "number" ? ce.seq : null;
          meta.episodeTitle = ce.title || null;
        }
      }
      return meta;
    } catch (_) {
      return null;
    }
  }

  function getMetadata(videoId) {
    let p = metadataPromises.get(videoId);
    if (!p) {
      p = fetchNetflixMetadata(videoId).catch(() => null);
      metadataPromises.set(videoId, p);
    }
    return p;
  }

  // DOM fallback for the title (if the metadata API is blocked).
  function readDomMetadata() {
    const h4 = document.querySelector(
      ".video-title h4, .title-info-wrapper h4, .player-title h4",
    );
    if (!h4) return null;
    const span = document.querySelector(
      ".video-title span, .title-info-wrapper span, .player-title span",
    );
    return {
      type: null,
      title: h4.textContent.trim(),
      year: null,
      seasonNumber: null,
      episodeNumber: null,
      episodeTitle: span ? span.textContent.trim() : null,
    };
  }

  // ---------------------------------------------------------------------------
  // State per Netflix video
  // ---------------------------------------------------------------------------
  const items = new Map(); // videoId -> item

  function ensureItem(videoId) {
    let item = items.get(videoId);
    if (!item) {
      item = {
        videoId,
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
        // Cumulative playback time in seconds, measured by playback position
        // progress (lastCurrentTime tracks the delta between ticks).
        watchedSeconds: 0,
        lastCurrentTime: null,
      };
      items.set(videoId, item);
    }
    return item;
  }

  // ---------------------------------------------------------------------------
  // Watcharr interaction
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

  /**
   * Searches for a title via the Watcharr instance and returns the best
   * media result (or null). `type` is "movie" | "tv" | null.
   */
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

  /**
   * Sets the status of an already existing MOVIE in
   * Watcharr to "WATCHING" – e.g., if it was previously PLANNED/FINISHED and is now
   * being watched again. Only for movies: For series, the specific
   * episode is marked instead (markEpisodeWatching), never the series itself.
   */
  async function markWatching(item) {
    // Never reset a movie that was already marked as FINISHED in this session
    // back to WATCHING (otherwise the ticks would oscillate).
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

  /**
   * Marks a specific TV episode as WATCHING – the status of the series
   * itself remains unchanged (for series, the episode counts, not the
   * entire series).
   */
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
  // History synchronization (Netflix history -> Watcharr)
  // ---------------------------------------------------------------------------
  // Gentle pacing for the history crawl: ONE delay before every history page
  // (a page = HISTORY_PAGE_SIZE = 20 entries). Keeps e.g. the "oldest first"
  // full load from crawling hundreds of pages at full speed without slowing the
  // incremental scroll mode (already human-paced). Lookups WITHIN a page run
  // without an extra delay.
  const HISTORY_PAGE_GAP_MS = 500;
  let lastHistoryPageAt = 0;
  async function historyThrottle() {
    const now = Date.now();
    const wait = lastHistoryPageAt + HISTORY_PAGE_GAP_MS - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHistoryPageAt = Date.now();
  }

  /**
   * Netflix session from the injected probe (authURL, userGuid,
   * BUILD_IDENTIFIER). Fallback: parse /settings/viewed/ HTML.
   */
  async function getNetflixSession() {
    if (lastProbe.session && lastProbe.session.userGuid) {
      return lastProbe.session;
    }
    try {
      const resp = await fetch("https://www.netflix.com/settings/viewed/", {
        credentials: "include",
      });
      if (!resp.ok) return null;
      const html = await resp.text();
      const match = html.match(
        /"userInfo":\{"data":\{[^}]*"userGuid":"([^"]+)"/,
      );
      if (!match || !match[1]) return null;
      return { userGuid: match[1], buildIdentifier: null };
    } catch (_) {
      return null;
    }
  }

  /**
   * Fetches a page of the Netflix history via the aui/pathEvaluator endpoint.
   * This is the same endpoint that UTS uses – the old
   * `/api/shakti/.../viewingactivity` now returns 404.
   * On transient errors, it retries so no page is lost.
   */
  async function fetchHistoryPage(session, page, pageSize) {
    const callPath = '["aui","viewingActivity",' + page + "," + pageSize + "]";
    const url =
      "https://www.netflix.com/api/aui/pathEvaluator/web/%5E2.0.0?method=call&callPath=" +
      encodeURIComponent(callPath) +
      "&falcor_server=0.1.0";
    const body =
      "param=" + encodeURIComponent(JSON.stringify({ guid: session.userGuid }));
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-netflix.request.routing":
        '{"path":"/nq/aui/endpoint/%5E1.0.0-web/pathEvaluator","control_tag":"auinqweb"}',
    };
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await historyThrottle(); // one delay per history page (20 entries)
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body,
          credentials: "include",
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        const viewed =
          data &&
          data.jsonGraph &&
          data.jsonGraph.aui &&
          data.jsonGraph.aui.viewingActivity &&
          data.jsonGraph.aui.viewingActivity.value &&
          data.jsonGraph.aui.viewingActivity.value.viewedItems;
        return Array.isArray(viewed) ? viewed : [];
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    throw lastErr || new Error("History page could not be loaded");
  }

  /** Raw metadata (single metadata endpoint) with cache per Netflix ID. */
  const rawMetadataCache = new Map();
  async function fetchRawMetadata(id) {
    if (rawMetadataCache.has(id)) return rawMetadataCache.get(id);
    const p = (async () => {
      try {
        const url =
          "https://www.netflix.com/nq/website/memberapi/release/metadata?languages=en-US&movieid=" +
          encodeURIComponent(id);
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) return null;
        const data = await resp.json();
        const video = data && data.video;
        return video && video.type ? { video } : null;
      } catch (_) {
        return null;
      }
    })();
    rawMetadataCache.set(id, p);
    return p;
  }

  /**
   * Netflix viewing activity reports `date` in Unix milliseconds. (A previous
   * version multiplied by 1000 unconditionally, producing absurd years and
   * HTTP 400 from Watcharr.) Values in seconds are accepted as fallback.
   */
  function netflixDate(ts) {
    const n = Number(ts);
    if (!isFinite(n) || n <= 0) return null;
    return new Date(n < 1e11 ? n * 1000 : n); // < 1e11 => seconds, otherwise ms
  }

  /**
   * ISO-8601 string for a Netflix view date.
   * Sent as a STRING (not a Date object): whether a Date survives the
   * message channel differs between Firefox and Chrome – a string is safe.
   */
  function isoDate(ts) {
    const d = netflixDate(ts);
    return d ? d.toISOString() : null;
  }

  /**
   * Enriches raw history items with metadata (year, title, and for series
   * season/episode) – analogous to UTS: one metadata request per unique ID.
   */
  async function enrichHistoryItems(items) {
    const enriched = [];
    for (const it of items) {
      if (!it || it.movieID == null) continue;
      const isTv = "series" in it && it.series != null;
      const metaId = isTv ? String(it.series) : String(it.movieID);
      const raw = await fetchRawMetadata(metaId);
      const video = raw && raw.video;

      if (isTv) {
        let season = null;
        let episode = null;
        if (video && video.type === "show") {
          const seasons = Array.isArray(video.seasons) ? video.seasons : [];
          outer: for (const s of seasons) {
            const eps = Array.isArray(s.episodes) ? s.episodes : [];
            for (const ep of eps) {
              if (String(ep.id) === String(it.movieID)) {
                season = typeof s.seq === "number" ? s.seq : null;
                episode = typeof ep.seq === "number" ? ep.seq : null;
                break outer;
              }
            }
          }
        }
        enriched.push({
          date: it.date ? isoDate(it.date) : null,
          isTv: true,
          title: it.seriesTitle || it.title || (video && video.title) || "",
          year: video ? video.year : null,
          season,
          episode,
        });
      } else {
        enriched.push({
          date: it.date ? isoDate(it.date) : null,
          isTv: false,
          title: it.title || (video && video.title) || "",
          year: video ? video.year : null,
          season: null,
          episode: null,
        });
      }
    }
    return enriched.filter((e) => e.title);
  }

  // Incremental loading: always fetch only 20 entries per Netflix call.
  const HISTORY_PAGE_SIZE = 20;

  /** Returns ONE page of history (20 entries) for incremental loading. */
  async function fetchHistoryPageForUi(page) {
    const session = await getNetflixSession();
    if (!session || !session.userGuid) {
      return {
        status: "error",
        error:
          "Netflix session could not be determined – please log in to Netflix.",
      };
    }
    const raw = await fetchHistoryPage(session, page, HISTORY_PAGE_SIZE);
    const entries = await enrichHistoryItems(raw);
    return { status: "ok", entries, done: raw.length === 0 };
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

      const videoId = getVideoId();
      if (!videoId) {
        // Not on /watch/ page anymore -> reset state.
        if (items.size) items.clear();
        return;
      }

      const item = ensureItem(videoId);
      const pb = normalizePlaybackUnits(pickPlayback(videoId));

      // 0) Capture cumulative playback time: the counter only runs while the
      //    playback position advances (i.e. while actively playing). More robust
      //    than pause/playing flags, which Netflix does not report reliably in
      //    every session state version. Runs in parallel with metadata/TMDB
      //    resolution.
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

      // 1) Get metadata
      if (!item.metadata && !item.metadataFailed) {
        item.metadata = await getMetadata(videoId);
        if (!item.metadata) item.metadata = readDomMetadata();
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

      // 3) Ensure in Watcharr – only after WATCHING_AFTER_SECONDS of playback.
      //    Series and movies are handled differently:
      //      – series: the status of the SPECIFIC episode is set, the series
      //        itself stays untouched,
      //      – movie:  status WATCHING (created if missing).
      if (item.watchedSeconds > WATCHING_AFTER_SECONDS) {
        const isTv = item.tmdb && item.tmdb.contentType === "tv";
        if (!item.watchedId) {
          // Create element (even if progress is already above
          // finish threshold) so it can be marked as watched
          // afterwards.
          await ensureWatched(item);
        } else if (pb && pb.progress < settings.threshold) {
          // Only set "WATCHING" while progress is BELOW the
          // finish threshold – if the video is already done (>= threshold),
          // it's marked as watched directly and no longer set to WATCHING.
          if (isTv) {
            // Series: only mark the specific episode as WATCHING.
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
        // If season/episode is unknown (e.g. Netflix collections), just leave
        // the status as "WATCHING" – the show has already been created.
      }
    } finally {
      ticking = false;
    }
  }

  setInterval(tick, POLL_INTERVAL_MS);

  // ---------------------------------------------------------------------------
  // Popup request: report the currently playing item
  // ---------------------------------------------------------------------------
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "watcharr:getCurrentItem") {
      sendResponse(currentSummary());
      return false;
    }
    // Ping: checks if the content script is reachable in the tab.
    if (msg && msg.type === "watcharr:ping") {
      sendResponse({ status: "ok" });
      return false;
    }
    // For the history page: fetch ONE page (20 entries) incrementally.
    if (msg && msg.type === "watcharr:fetchHistoryPage") {
      fetchHistoryPageForUi(msg.page || 0)
        .then(sendResponse)
        .catch((err) => {
          sendResponse({ status: "error", error: err.message || String(err) });
        });
      return true; // asynchronous response
    }
  });

  function currentSummary() {
    const videoId = getVideoId();
    const item = videoId ? items.get(videoId) : null;
    const pb = item ? pickPlayback(videoId) : null;
    return {
      videoId,
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
