/*
 * Jellyfin – scrobbler content script.
 *
 * Detects what is playing in the Jellyfin web client (movie vs. series,
 * season/episode), resolves the TMDB ID and keeps the Watcharr watchlist up to
 * date:
 *   – series start          -> create show as "WATCHING"
 *   – episode > threshold   -> mark episode as watched (FINISHED)
 *   – movie > threshold     -> mark movie as FINISHED
 *
 * Jellyfin is self-hosted and its web client is served from the same origin as
 * its API, so – unlike Netflix/Prime Video – everything uses plain same-origin
 * fetches:
 *   – the playing item comes from `GET /Sessions` (NowPlayingItem),
 *   – the playback position comes from the page's <video> element,
 *   – the login (server, access token, user id) is read from the web client's
 *     own localStorage entry ("jellyfin_credentials"), so the user does not
 *     have to log in again.
 *
 * The server URL is user-configured, so the manifest cannot list a fixed match
 * pattern: the background registers this script dynamically for the configured
 * server (browser.scripting.registerContentScripts).
 *
 * Only playback of this web client is scrobbled – not playback on other devices
 * (TV app, phone, …), which this script cannot observe.
 *
 * All Watcharr API calls go through the background script, so the Watcharr
 * token never reaches the content script / the Jellyfin page.
 */
"use strict";

(function () {
  // Idempotency guard: an already running content script (e.g. injected later
  // via browser.scripting) must not start twice.
  if (window.__watcharrJellyfinContentInstalled__) return;
  window.__watcharrJellyfinContentInstalled__ = true;

  const POLL_INTERVAL_MS = 1500;
  // The server refreshes a session's position only every few seconds, so the
  // (cheap, same-origin) /Sessions call runs less often than the DOM poll.
  const SESSION_POLL_INTERVAL_MS = 2000;
  const DEFAULT_THRESHOLD = 90;
  // An item is only created as "WATCHING" after this much cumulative playback
  // – prevents briefly clicked videos from cluttering the watchlist.
  const WATCHING_AFTER_SECONDS = 300;
  const HISTORY_PAGE_SIZE = 20; // page size for the history page
  const TICKS_PER_SECOND = 10000000; // Jellyfin durations are .NET ticks (100 ns)
  // localStorage key the Jellyfin web client uses for its servers + logins.
  const CREDENTIALS_KEY = "jellyfin_credentials";

  /** Builds an Error carrying the stable i18n code used by the history page. */
  function jfError(code, message) {
    const e = new Error(message || code);
    e.jellyfinCode = code;
    return e;
  }

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
  // Jellyfin login of THIS web client (server URL + access token + user id)
  // ---------------------------------------------------------------------------
  const jellyfin = { ok: false, base: "", token: "", userId: "" };

  function stripSlashes(s) {
    return String(s == null ? "" : s).replace(/\/+$/, "");
  }

  /** Base path of a stored server address ("" for a server at the root). */
  function basePathOf(address) {
    try {
      const u = new URL(String(address), location.origin);
      const p = stripSlashes(u.pathname);
      return p === "/" ? "" : p;
    } catch (_) {
      return "";
    }
  }

  /**
   * Reads the Jellyfin login out of the web client's own localStorage. The
   * API base URL is built from the CURRENT page origin (plus the server's base
   * path, for installations behind a reverse proxy sub-path) so that every
   * request is a plain same-origin fetch – no CORS involved.
   */
  function readJellyfinLogin() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(CREDENTIALS_KEY);
    } catch (_) {
      return null;
    }
    if (!raw) return null;
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return null;
    }
    const servers = data && Array.isArray(data.Servers) ? data.Servers : [];
    const usable = servers.filter((s) => s && s.AccessToken && s.UserId);
    if (!usable.length) return null;

    // Prefer the entry that points at the origin this page is served from.
    const here = usable.filter((s) => {
      if (!s.ManualAddress) return false;
      try {
        return (
          new URL(String(s.ManualAddress), location.origin).origin ===
          location.origin
        );
      } catch (_) {
        return false;
      }
    });
    const srv = here[0] || usable[0];
    const basePath =
      here.length > 0 && srv.ManualAddress ? basePathOf(srv.ManualAddress) : "";
    return {
      base: location.origin + basePath,
      token: String(srv.AccessToken),
      userId: String(srv.UserId),
    };
  }

  /**
   * Returns the (cached) login. While nothing is cached the localStorage is
   * re-read on every call, so logging in *after* the page was opened starts
   * working without a reload.
   */
  function getLogin() {
    if (jellyfin.ok) return jellyfin;
    const login = readJellyfinLogin();
    jellyfin.ok = !!login;
    jellyfin.base = login ? login.base : "";
    jellyfin.token = login ? login.token : "";
    jellyfin.userId = login ? login.userId : "";
    return jellyfin;
  }

  /** Drops the cached login (e.g. after the token was rejected). */
  function forgetLogin() {
    jellyfin.ok = false;
    jellyfin.base = "";
    jellyfin.token = "";
    jellyfin.userId = "";
  }

  /**
   * Same-origin GET against the Jellyfin API. The access token is sent in the
   * standard `Authorization` header (Jellyfin's MediaBrowser scheme).
   */
  async function jellyfinJson(path, params) {
    const login = getLogin();
    if (!login.ok)
      throw jfError(
        "jellyfin_not_logged_in",
        "No Jellyfin login found – please log in to Jellyfin in this browser.",
      );
    let url = login.base + path;
    if (params) {
      const qs = new URLSearchParams();
      for (const key of Object.keys(params)) {
        if (params[key] != null) qs.set(key, String(params[key]));
      }
      const s = qs.toString();
      if (s) url += "?" + s;
    }
    let resp;
    try {
      resp = await fetch(url, {
        method: "GET",
        credentials: "omit",
        headers: { Authorization: 'MediaBrowser Token="' + login.token + '"' },
      });
    } catch (err) {
      throw jfError(
        "jellyfin_unavailable",
        "Jellyfin server could not be reached: " + (err.message || String(err)),
      );
    }
    if (resp.status === 401 || resp.status === 403) {
      forgetLogin(); // token expired/invalid -> re-read next time
      throw jfError(
        "jellyfin_not_logged_in",
        "Jellyfin rejected the session – please log in again.",
      );
    }
    if (!resp.ok) {
      throw jfError(
        "jellyfin_api_failed",
        "Jellyfin API request failed (HTTP " + resp.status + ").",
      );
    }
    try {
      return await resp.json();
    } catch (_) {
      throw jfError(
        "jellyfin_api_failed",
        "Jellyfin API returned an invalid response.",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Currently playing item (server session)
  // ---------------------------------------------------------------------------
  const nowPlayingState = { at: 0, session: null };

  /** True for the session of a Jellyfin *web* client (see file header). */
  function isWebClientSession(s) {
    return /jellyfin\s*web/i.test((s && s.Client) || "");
  }

  /**
   * The session of this user's Jellyfin web client that has a NowPlayingItem,
   * or null. Cached for SESSION_POLL_INTERVAL_MS.
   */
  async function getNowPlaying(force) {
    const login = getLogin();
    if (!login.ok) return null;
    const now = Date.now();
    if (!force && now - nowPlayingState.at < SESSION_POLL_INTERVAL_MS) {
      return nowPlayingState.session;
    }
    const sessions = await jellyfinJson("/Sessions");
    nowPlayingState.at = Date.now();
    let session = null;
    if (Array.isArray(sessions)) {
      const mine = sessions.filter(
        (s) =>
          s &&
          s.NowPlayingItem &&
          String(s.UserId || "") === login.userId &&
          isWebClientSession(s),
      );
      // A playing session wins over a merely paused one.
      const playing = mine.filter(
        (s) => !(s.PlayState && s.PlayState.IsPaused),
      );
      session = playing[0] || mine[0] || null;
    }
    nowPlayingState.session = session;
    return session;
  }

  function numberOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** TMDB id out of a Jellyfin DTO's `ProviderIds` (or null). */
  function tmdbOf(dto) {
    const ids = dto && dto.ProviderIds;
    if (!ids) return null;
    const raw = ids.Tmdb != null ? ids.Tmdb : ids.tmdb;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /**
   * Maps a Jellyfin `NowPlayingItem` (BaseItemDto) onto our metadata shape.
   * Returns null for item types we do not scrobble (trailer, music, …).
   */
  function mapNowPlaying(dto) {
    if (!dto) return null;
    const type = String(dto.Type || "");
    if (type === "Episode") {
      const title = dto.SeriesName || dto.Name || "";
      if (!title) return null;
      return {
        type: "tv",
        title,
        // The episode's own year is not what TMDB searches for a series; the
        // series is looked up by title (and its TMDB id, when available).
        year: null,
        seasonNumber: numberOrNull(dto.ParentIndexNumber),
        episodeNumber: numberOrNull(dto.IndexNumber),
        episodeTitle: dto.Name || "",
        // `ProviderIds` holds the EPISODE's TMDB id – Watcharr needs the
        // SERIES id, which is resolved through SeriesId (cached) below.
        tmdbId: null,
        seriesId: dto.SeriesId ? String(dto.SeriesId) : null,
        seriesTmdbId: tmdbOf({ ProviderIds: dto.SeriesProviderIds }),
      };
    }
    if (type === "Movie") {
      const title = dto.Name || "";
      if (!title) return null;
      return {
        type: "movie",
        title,
        year: numberOrNull(dto.ProductionYear),
        seasonNumber: null,
        episodeNumber: null,
        episodeTitle: null,
        tmdbId: tmdbOf(dto),
        seriesId: null,
        seriesTmdbId: null,
      };
    }
    return null;
  }

  const seriesTmdbCache = new Map(); // Jellyfin series id -> Promise<tmdbId|null>

  /** TMDB id of a Jellyfin series (looked up once, then cached forever). */
  function lookupSeriesTmdb(seriesId) {
    if (!seriesId) return Promise.resolve(null);
    if (seriesTmdbCache.has(seriesId)) return seriesTmdbCache.get(seriesId);
    const p = (async () => {
      const login = getLogin();
      if (!login.ok) return null;
      try {
        const dto = await jellyfinJson(
          "/Users/" +
            encodeURIComponent(login.userId) +
            "/Items/" +
            encodeURIComponent(seriesId),
        );
        return tmdbOf(dto);
      } catch (_) {
        return null;
      }
    })();
    seriesTmdbCache.set(seriesId, p);
    return p;
  }

  // ---------------------------------------------------------------------------
  // Playback state
  // ---------------------------------------------------------------------------
  /**
   * The <video> element that is currently playing. Jellyfin Web keeps one
   * player element around while something plays; preview/hover videos never
   * play, so "playing" is a reliable discriminator.
   */
  function readVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    let idle = null;
    for (const v of videos) {
      if (!isFinite(v.duration) || v.duration <= 0) continue;
      if (!v.paused && !v.ended) return v;
      if (!idle) idle = v;
    }
    return idle;
  }

  function readPlayback() {
    const v = readVideo();
    if (!v) return null;
    const duration = v.duration;
    if (!isFinite(duration) || duration <= 0) return null;
    const currentTime = isFinite(v.currentTime) ? v.currentTime : 0;
    return {
      currentTime,
      duration,
      progress: Math.min(100, (currentTime / duration) * 100),
      isPaused: !!v.paused,
      playing: !v.paused && !v.ended,
      ended: !!v.ended,
    };
  }

  /** Playback state derived from the server session (no <video> available). */
  function playbackFromSession(session) {
    const item = session && session.NowPlayingItem;
    const ps = session && session.PlayState;
    if (!item || !ps) return null;
    const durationTicks = Number(item.RunTimeTicks || 0);
    if (!durationTicks) return null;
    const duration = durationTicks / TICKS_PER_SECOND;
    const currentTime = Number(ps.PositionTicks || 0) / TICKS_PER_SECOND;
    return {
      currentTime,
      duration,
      progress: Math.min(100, (currentTime / duration) * 100),
      isPaused: !!ps.IsPaused,
      playing: !ps.IsPaused,
      ended: false,
    };
  }

  /**
   * Combines the DOM playback state (precise, updated every frame) with the
   * session state (authoritative). The DOM value is only trusted when its
   * duration matches the session's runtime – otherwise an unrelated <video>
   * element on the page would have been picked up.
   */
  function resolvePlayback(session) {
    const fromApi = playbackFromSession(session);
    const fromDom = readPlayback();
    if (!fromDom) return fromApi;
    if (!fromApi) return fromDom;
    const ratio =
      fromApi.duration > 0 ? fromDom.duration / fromApi.duration : 1;
    return ratio > 0.9 && ratio < 1.1 ? fromDom : fromApi;
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
  // State per Jellyfin item (keyed by identity, see above)
  // ---------------------------------------------------------------------------
  const items = new Map(); // identity -> item
  let currentKey = null; // identity of the item currently playing

  function ensureItem(key) {
    let item = items.get(key);
    if (!item) {
      item = {
        key,
        metadata: null,
        tmdb: null,
        searching: false,
        watchedId: null,
        watchedStatus: null,
        adding: false,
        markedEpisodes: new Set(),
        markedEpisodesWatching: new Set(),
        movieFinished: false,
        watchedSeconds: 0,
        lastCurrentTime: null,
      };
      items.set(key, item);
    }
    return item;
  }

  // ---------------------------------------------------------------------------
  // Watcharr interaction (identical to the Netflix/Prime Video content scripts)
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

  function tmdbIdOf(result) {
    const n = Number(result && result.ids && result.ids.tmdb);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /**
   * Resolves the medium through Watcharr's TMDB search. The search result is
   * also the only way to learn whether the medium is ALREADY in Watcharr
   * (with which status) – that `watched` entry keeps our import from
   * downgrading an already finished medium.
   *
   * Jellyfin usually reports the TMDB id itself (`ProviderIds`); that id is
   * used to pick the EXACT search result (and as the last resort), so the
   * match does not depend on title/year guessing.
   */
  async function resolveTmdb(item) {
    const meta = item.metadata;
    const wantType = meta.type === "movie" ? "movie" : "tv";
    let jellyfinTmdbId = meta.tmdbId || meta.seriesTmdbId || null;
    if (!jellyfinTmdbId && meta.type === "tv" && meta.seriesId) {
      jellyfinTmdbId = await lookupSeriesTmdb(meta.seriesId);
    }

    const queries = [];
    if (meta.year) queries.push(meta.title + " year:" + meta.year);
    queries.push(meta.title);

    let best = null;
    for (const q of queries) {
      let results = [];
      try {
        const resp = await browser.runtime.sendMessage({
          type: "watcharr:search",
          query: q,
        });
        if (!resp || !resp.ok) continue;
        results = (resp.data && resp.data.results) || [];
      } catch (_) {
        continue;
      }
      if (!results.length) continue;
      if (jellyfinTmdbId) {
        best =
          results.find((r) => tmdbIdOf(r) === Number(jellyfinTmdbId)) || null;
        if (best) break;
      } else {
        best = pickBestMatch(results, meta);
        if (best) break;
      }
    }

    if (best && tmdbIdOf(best)) {
      item.tmdb = {
        tmdbId: tmdbIdOf(best),
        contentType: jellyfinTmdbId
          ? wantType
          : best.type === "tmdb_movie"
            ? "movie"
            : "tv",
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

    // Watcharr's search did not produce anything usable – but Jellyfin knows
    // the TMDB id, so it can still be scrobbled.
    if (jellyfinTmdbId) {
      item.tmdb = {
        tmdbId: Number(jellyfinTmdbId),
        contentType: wantType,
        name: meta.title,
      };
      return true;
    }
    return false;
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
  let sessionErrorLogged = false;

  /** Clears the per-item state (nothing of this service is playing anymore). */
  function resetItems() {
    if (items.size) items.clear();
    currentKey = null;
    nowPlayingState.session = null;
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (!settings.loaded) await loadSettings();
      if (!settings.enabled || !settings.configured) return;

      let session = null;
      try {
        session = await getNowPlaying();
      } catch (err) {
        if (!sessionErrorLogged) {
          sessionErrorLogged = true;
          console.warn(
            "[watcharr-scrobbler] Jellyfin session lookup failed:",
            err.message || String(err),
          );
        }
        return;
      }
      sessionErrorLogged = false;

      const ident = session ? mapNowPlaying(session.NowPlayingItem) : null;
      if (!ident) {
        resetItems();
        return;
      }

      const key = identityKey(ident);
      if (key !== currentKey) currentKey = key;
      const item = ensureItem(key);
      if (!item.metadata) item.metadata = ident;

      const pb = resolvePlayback(session);

      // 0) Capture cumulative playback time: the counter only runs while the
      //    playback position advances (i.e. while actively playing).
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

      // 1) Resolve TMDB ID via Watcharr search (+ Jellyfin's ProviderIds)
      if (!item.tmdb && !item.searching) {
        item.searching = true;
        try {
          await resolveTmdb(item);
        } finally {
          item.searching = false;
        }
      }
      if (!item.tmdb) return;

      // 2) Ensure in Watcharr – only after WATCHING_AFTER_SECONDS of playback.
      if (item.watchedSeconds > WATCHING_AFTER_SECONDS) {
        const isTv = item.tmdb.contentType === "tv";
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

      // 3) Evaluate progress. Once the medium reaches the threshold it is
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
    } finally {
      ticking = false;
    }
  }

  setInterval(tick, POLL_INTERVAL_MS);

  // ---------------------------------------------------------------------------
  // Jellyfin history (for the history page / Watcharr import)
  // ---------------------------------------------------------------------------
  // Jellyfin has no per-view log (that needs the "Playback Reporting" plugin);
  // the closest built-in equivalent is the list of items marked as played by
  // this user, sorted by their last played date.
  function historyItemToEntry(it) {
    if (!it) return null;
    const date = (it.UserData && it.UserData.LastPlayedDate) || null;
    if (it.Type === "Episode") {
      const title = it.SeriesName || it.Name;
      if (!title) return null;
      return {
        date,
        isTv: true,
        title,
        year: null,
        season: numberOrNull(it.ParentIndexNumber),
        episode: numberOrNull(it.IndexNumber),
      };
    }
    if (it.Type === "Movie") {
      if (!it.Name) return null;
      return {
        date,
        isTv: false,
        title: it.Name,
        year: numberOrNull(it.ProductionYear),
        season: null,
        episode: null,
      };
    }
    return null;
  }

  /** Returns ONE page (HISTORY_PAGE_SIZE entries) of the Jellyfin history. */
  async function fetchHistoryPageForUi(page) {
    const login = getLogin();
    if (!login.ok)
      throw jfError(
        "jellyfin_not_logged_in",
        "No Jellyfin login found – please log in to Jellyfin in this browser.",
      );
    const start = Math.max(0, page) * HISTORY_PAGE_SIZE;
    const data = await jellyfinJson(
      "/Users/" + encodeURIComponent(login.userId) + "/Items",
      {
        Recursive: "true",
        IncludeItemTypes: "Movie,Episode",
        Filters: "IsPlayed",
        SortBy: "DatePlayed",
        SortOrder: "Descending",
        StartIndex: start,
        Limit: HISTORY_PAGE_SIZE,
        ImageTypeLimit: 0,
        EnableImages: false,
      },
    );
    const raw = (data && data.Items) || [];
    const total = Number((data && data.TotalRecordCount) || 0);
    const entries = raw.map(historyItemToEntry).filter(Boolean);
    const done =
      raw.length < HISTORY_PAGE_SIZE ||
      (total > 0 && start + raw.length >= total);
    return { status: "ok", entries, done };
  }

  // ---------------------------------------------------------------------------
  // Popup / history page requests
  // ---------------------------------------------------------------------------
  function currentSummary() {
    const item = currentKey ? items.get(currentKey) : null;
    const pb = item ? resolvePlayback(nowPlayingState.session) : null;
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
    // For the history page: fetch ONE page of the Jellyfin history.
    if (msg && msg.type === "watcharr:fetchHistoryPage") {
      // A new loadId means "start over" – the Jellyfin history is queried by
      // start index, so there is no buffer that would have to be reset.
      fetchHistoryPageForUi(msg.page || 0)
        .then(sendResponse)
        .catch((err) => {
          sendResponse({
            status: "error",
            error: err.message || String(err),
            errorCode: (err && err.jellyfinCode) || null,
          });
        });
      return true; // asynchronous response
    }
    return false;
  });

  // Let's go
  loadSettings();
  tick();
})();
