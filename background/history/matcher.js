/*
 * Match a service history entry against Watcharr (TMDB search) and check
 * whether the specific episode is already recorded there.
 *
 * Everything in here works with ONE item/row at a time and keeps no state
 * besides the per-TMDB-id episode cache, which is cleared on every fresh
 * history load (see background/history/index.js).
 */
"use strict";

(function () {
  const { log, logErr, normTitle, epKey, toEpochSeconds } =
    globalThis.WatcharrUtil;
  const userError = WatcharrErrors.create;

  async function getSettings() {
    return WatcharrSettings.get();
  }

  /** TMDB search through the user's Watcharr instance. */
  async function searchWatcharr(title, year) {
    const settings = await getSettings();
    if (!settings.watcharrUrl || !settings.token) {
      throw userError("not_configured", "Watcharr is not configured.");
    }
    const client = new WatcharrClient(settings);
    const query = year ? title + " year:" + year : title;
    const data = await client.search(query, "multi");
    return (data && data.results) || [];
  }

  /** Best guess from a TMDB search result list (title, then first of type). */
  function pickBest(results, title, isTv) {
    const wantType = isTv ? "tmdb_tv" : "tmdb_movie";
    let pool = results.filter((r) => r.type === wantType);
    if (!pool.length) pool = results.slice();
    const norm = (s) => (s || "").toLowerCase().trim();
    for (const r of pool) {
      if (norm(r.name) === norm(title)) return r;
    }
    return pool[0] || null;
  }

  /** The search result carrying exactly this TMDB id (or null). */
  function pickByTmdbId(results, tmdbId) {
    const want = Number(tmdbId);
    if (!Number.isInteger(want)) return null;
    for (const r of results) {
      if (r && r.ids && Number(r.ids.tmdb) === want) return r;
    }
    return null;
  }

  /** Watcharr search result -> the match object used by the history page. */
  function resultToMatch(result) {
    if (!result || !result.ids) return null;
    // Depending on the Watcharr version the id may arrive as a string.
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

  /**
   * Resolves a row whose TMDB id is already known (imported file) by searching
   * the file's title and using the result with EXACTLY that id – no guessing,
   * no fallback to another medium. The result also carries the Watcharr state
   * (`watched`), so the import can update an existing entry instead of creating
   * a duplicate.
   */
  async function resolveMatchByTmdbId(item) {
    const hint = item.tmdbHint;
    if (!hint || hint.tmdbId == null) return null;

    // Try the file's TMDB title first, then the service's title.
    const names = [];
    if (hint.title) names.push(hint.title);
    if (item.title && normTitle(hint.title) !== normTitle(item.title)) {
      names.push(item.title);
    }

    const queries = [];
    const push = (q) => {
      if (q && queries.indexOf(q) === -1) queries.push(q);
    };
    for (const name of names) {
      if (hint.year) push(name + " year:" + hint.year);
      else if (item.year) push(name + " year:" + item.year);
      push(name);
    }

    const client = new WatcharrClient(await getSettings());
    for (const query of queries) {
      let results = [];
      try {
        const data = await client.search(query, "multi");
        results = (data && data.results) || [];
      } catch (err) {
        // One failed query must not abort the whole lookup.
        logErr(
          "resolveMatchByTmdbId: search failed for",
          query,
          "->",
          err.message,
        );
        continue;
      }
      const hit = pickByTmdbId(results, hint.tmdbId);
      if (hit) {
        log("resolveMatchByTmdbId: TMDB", hint.tmdbId, "resolved via", query);
        return resultToMatch(hit);
      }
    }
    return null;
  }

  /**
   * Episode status cache per TMDB id: many history rows belong to the same
   * series, so each series is queried once. The value is a Promise, so parallel
   * resolutions share the same request.
   */
  const watchedEpisodesCache = new Map();

  function clearCache() {
    watchedEpisodesCache.clear();
  }

  async function getWatchedEpisodes(tmdbId) {
    if (watchedEpisodesCache.has(tmdbId)) {
      return watchedEpisodesCache.get(tmdbId);
    }

    const pending = (async () => {
      const client = new WatcharrClient(await getSettings());
      const data = await client.getWatchedShow(tmdbId);
      const watched = data && data.watched;
      const raw =
        watched && Array.isArray(watched.watchedEpisodes)
          ? watched.watchedEpisodes
          : [];

      const episodes = raw.map((e) => ({
        seasonNumber: Number(e.seasonNumber),
        episodeNumber: Number(e.episodeNumber),
        status: e.status || "FINISHED",
      }));

      // Exact watch events per episode: FINISHED activities whose customDate is
      // set (= the watchedDate we passed to the API) – i.e. the exact date+time
      // the episode was recorded as finished.
      const finishedByEp = new Map(); // epKey -> Set<epoch seconds>
      const activities =
        watched && Array.isArray(watched.activity) ? watched.activity : [];
      for (const activity of activities) {
        if (
          !activity ||
          (activity.type !== "EPISODE_ADDED" &&
            activity.type !== "EPISODE_STATUS_CHANGED")
        ) {
          continue;
        }
        if (!activity.customDate) continue; // only exact-dated events count

        let detail = null;
        try {
          detail = JSON.parse(activity.data || "");
        } catch (_) {
          continue;
        }
        if (!detail || detail.status !== "FINISHED") continue;
        if (detail.season == null || detail.episode == null) continue;

        const seconds = toEpochSeconds(activity.customDate);
        if (seconds == null) continue;
        const key = epKey(detail.season, detail.episode);
        if (!finishedByEp.has(key)) finishedByEp.set(key, new Set());
        finishedByEp.get(key).add(seconds);
      }

      return { ok: true, episodes, finishedByEp };
    })().catch((err) => {
      logErr("getWatchedEpisodes: error for tmdbId", tmdbId, "->", err.message);
      return {
        ok: false,
        episodes: [],
        finishedByEp: new Map(),
        error: err.message,
      };
    });

    watchedEpisodesCache.set(tmdbId, pending);
    return pending;
  }

  /**
   * Checks whether the specific episode of the matched series is already
   * recorded in Watcharr at THIS exact date+time and writes the result onto the
   * item:
   *  - episodeStatus:      current status of the episode (null = not watched),
   *  - episodeDateMatched: a FINISHED activity exists for the exact date+time,
   *  - episodeStatusKnown: false = unknown (lookup failed / no episode info).
   */
  async function resolveItemEpisodeStatus(item) {
    item.episodeStatus = null;
    item.episodeDateMatched = false;
    item.episodeStatusKnown = false;

    if (!(
      item.isTv &&
      item.match &&
      item.match.watchedId &&
      item.season != null &&
      item.episode != null
    )) {
      return;
    }

    const result = await getWatchedEpisodes(item.match.tmdbId);
    if (!result.ok) return; // unknown -> the UI shows its fallback

    const episode = result.episodes.find(
      (e) => e.seasonNumber === item.season && e.episodeNumber === item.episode,
    );
    item.episodeStatus = episode ? episode.status : null;

    const rowSeconds = toEpochSeconds(item.date);
    const recorded = result.finishedByEp.get(epKey(item.season, item.episode));
    item.episodeDateMatched = !!(
      rowSeconds != null &&
      recorded &&
      recorded.has(rowSeconds)
    );
    item.episodeStatusKnown = true;
  }

  globalThis.WatcharrHistoryMatcher = {
    searchWatcharr,
    pickBest,
    pickByTmdbId,
    resultToMatch,
    resolveMatchByTmdbId,
    resolveItemEpisodeStatus,
    clearCache,
  };
})();
