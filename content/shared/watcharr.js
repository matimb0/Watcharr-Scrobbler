/*
 * Watcharr side of the scrobbler: the per-item state and every API call that
 * changes it.
 *
 * All calls go through the background script (`watcharr:*` messages), so the
 * Watcharr token never reaches the content script or the streaming page.
 *
 * The API is service-agnostic: a service fills `item.metadata` (title, type,
 * year, season/episode) and then uses the functions here. Jellyfin, which
 * already knows TMDB ids, builds on the search helpers as well.
 */
"use strict";

(function () {
  /**
   * State of ONE playing item. Every service keeps one of these per
   * video/identity; `extra` adds service-specific fields.
   */
  function createItem(key, extra) {
    return Object.assign(
      {
        key,
        metadata: null,
        // true once the metadata lookup failed for good (never retried)
        metadataFailed: false,
        tmdb: null,
        searching: false,
        watchedId: null,
        watchedStatus: null,
        adding: false,
        markedEpisodes: new Set(),
        markedEpisodesWatching: new Set(),
        movieFinished: false,
        // Cumulative playback time in seconds; lastCurrentTime tracks the
        // delta between two poll ticks.
        watchedSeconds: 0,
        lastCurrentTime: null,
      },
      extra || {},
    );
  }

  /** Release year of a Watcharr search result, or null. */
  function parseYear(result) {
    if (result.year) {
      const y = parseInt(result.year, 10);
      if (!isNaN(y)) return y;
    }
    if (result.releaseDate) {
      const y = parseInt(String(result.releaseDate).slice(0, 4), 10);
      if (!isNaN(y)) return y;
    }
    return null;
  }

  /** True when this search result is already on the user's Watcharr list. */
  function isOnList(result) {
    return !!(result && result.watched && result.watched.id);
  }

  /**
   * Best result for a title: same medium type first, then
   *  1. an exact title WITH the matching year,
   *  2. a matching year elsewhere in the wanted medium,
   *  3. an exact title that is already on the user's Watcharr list – providers
   *     like Prime Video report no year at all, so for same-titled remakes
   *     ("Road House") the entry the user already tracks is the best guess,
   *  4. the first candidate.
   * The year decides between same-titled media – "Road House" exists as 1989
   * and 2024, so the first exact title match may be the wrong one.
   */
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

    const want = norm(meta.title);
    const named = pool.filter((r) => norm(r.name) === want);
    const candidates = named.length ? named : pool;
    if (meta.year) {
      const exact = candidates.find((r) => parseYear(r) === meta.year);
      if (exact) return exact;
      const hit = pool.find((r) => parseYear(r) === meta.year);
      if (hit) return hit;
    }
    // Several same-titled media (remake!) and no usable year: prefer the one
    // already tracked in Watcharr instead of taking an arbitrary first hit.
    if (candidates.length > 1) {
      const onList = candidates.find(isOnList);
      if (onList) return onList;
    }
    return candidates[0] || null;
  }

  /** Watcharr search type for a medium type ("show" = series), or null. */
  function searchType(type) {
    return type === "movie" ? "movie" : type === "tv" ? "show" : null;
  }

  /**
   * Queries for one item, most specific first. Watcharr only evaluates the
   * inline filters (`year:`/`fyear:`) for a TYPED search – a "multi" search
   * strips them and ignores them, so the year would never be used.
   *
   *  1. typed + year filter (`fyear:` = TMDB first air year, series only),
   *  2. typed without the filter (the known year may be the episode's),
   *  3. "multi" without the filter (exists only under the other medium type).
   */
  function buildQueries(title, year, type) {
    const name = String(title || "").trim();
    if (!name) return [];
    const typed = searchType(type);
    const queries = [];
    if (typed && year) {
      const filter = (typed === "show" ? "fyear:" : "year:") + year;
      queries.push({ query: name + " " + filter, searchType: typed });
    }
    if (typed) queries.push({ query: name, searchType: typed });
    queries.push({ query: name, searchType: "multi" });
    return queries;
  }

  /**
   * Searches the user's Watcharr instance and returns the best media result
   * (or null). Runs the queries from `buildQueries` in order, so a title that
   * only exists under the other medium type is still found.
   */
  async function searchAndPick(title, year, type) {
    for (const { query, searchType: st } of buildQueries(title, year, type)) {
      let resp;
      try {
        resp = await browser.runtime.sendMessage({
          type: "watcharr:search",
          query,
          searchType: st,
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

  /** TMDB id of a Watcharr search result, or null. */
  function resultTmdbId(result) {
    const n = Number(result && result.ids && result.ids.tmdb);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /**
   * Writes a Watcharr search result into `item.tmdb`. A result that is already
   * on the user's list carries its `watched` entry, which keeps the "mark as
   * watched" logic from adding a duplicate. Returns false when the result has
   * no usable TMDB id.
   */
  function applySearchResult(item, result, fallbackTitle) {
    const tmdbId = resultTmdbId(result);
    if (!tmdbId) return false;

    item.tmdb = {
      tmdbId,
      contentType: result.type === "tmdb_movie" ? "movie" : "tv",
      name: result.name || fallbackTitle,
    };
    if (result.watched && result.watched.id) {
      item.watchedId = result.watched.id;
      item.watchedStatus = result.watched.status;
    }
    return true;
  }

  /** Default resolution: search by the item's title/year/type. */
  async function resolveTmdb(item) {
    const meta = item.metadata;
    const best = await searchAndPick(meta.title, meta.year, meta.type);
    return applySearchResult(item, best, meta.title);
  }

  /** Adds the medium to the Watcharr list as WATCHING (create if missing). */
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
   * Sets an already listed MOVIE back to WATCHING (it may have been PLANNED or
   * FINISHED before). Series are never touched here – for them the specific
   * episode is marked instead.
   */
  async function markWatching(item) {
    // A movie already finished in this session must not flip back (the ticks
    // would oscillate between WATCHING and FINISHED).
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

  /** Marks the movie as FINISHED in the Watcharr list. */
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

  /** Marks one episode with the given status (idempotent per status). */
  async function markEpisode(item, seasonNumber, episodeNumber, status) {
    if (!item.watchedId) return;
    const key = seasonNumber + ":" + episodeNumber;
    const marked =
      status === "WATCHING" ? item.markedEpisodesWatching : item.markedEpisodes;
    if (marked.has(key)) return;
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:addEpisode",
      watchedId: item.watchedId,
      seasonNumber,
      episodeNumber,
      status,
    });
    if (resp && resp.ok) marked.add(key);
  }

  /** Marks one episode as WATCHING (the series itself stays untouched). */
  function markEpisodeWatching(item, seasonNumber, episodeNumber) {
    return markEpisode(item, seasonNumber, episodeNumber, "WATCHING");
  }

  /** Marks one episode as FINISHED. */
  function markEpisodeWatched(item, seasonNumber, episodeNumber) {
    return markEpisode(item, seasonNumber, episodeNumber, "FINISHED");
  }

  globalThis.WatcharrContentApi = {
    createItem,
    parseYear,
    isOnList,
    pickBestMatch,
    searchType,
    buildQueries,
    searchAndPick,
    resultTmdbId,
    applySearchResult,
    resolveTmdb,
    ensureWatched,
    markWatching,
    markMovieFinished,
    markEpisodeWatching,
    markEpisodeWatched,
  };
})();
