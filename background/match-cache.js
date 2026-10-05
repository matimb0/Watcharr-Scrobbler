/*
 * Persistent match cache.
 *
 * A title is matched to its TMDB id at most ONCE: whatever was resolved –
 * automatically during a history load or by the user through "Change match" –
 * is written here (browser.storage.local, i.e. it survives reloads and browser
 * restarts). The next load asks the cache first and only searches TMDB when
 * there is nothing stored for that title.
 *
 * What the cache may store:
 *  - `matches`:   provider title + medium -> the TMDB IDENTITY of the match
 *                 (tmdbId, contentType, name, posterPath, year, ambiguous).
 *  - `episodes`:  TMDB id + episode NAME -> the resolved season/episode. An
 *                 episode's number never changes, so the expensive name search
 *                 over TMDB's season pages runs once per name.
 *
 * What it must NEVER store: everything that describes the USER's instance –
 * whether a title is on the list, with which status, which episodes are watched,
 * which watch dates exist. All of that changes with every import and is fetched
 * fresh (see background/watcharr-client.js).
 *
 * Keys are provider data only (title, episode name), never a Watcharr id: the
 * same show is reported again with the same title on the next load, while its
 * Watcharr state may have changed completely.
 *
 * The blob is rewritten at most once per `FLUSH_DELAY_MS`: a history load
 * resolves rows in batches and one write per row would rewrite the whole cache
 * every single time.
 */
"use strict";

(function () {
  const { log, logErr, normTitle, normName } = globalThis.WatcharrUtil;

  const STORAGE_KEY = "matchCache";
  // Bumping this drops an incompatible stored blob instead of misreading it.
  const VERSION = 1;

  /**
   * Answer of `lookupMatch` for a title the user DELIBERATELY left unmatched
   * ("Change match" -> no match): a stored decision, not a cache miss – the
   * caller must not search TMDB again.
   */
  const UNMATCHED = { unmatched: true };
  // One budget for the whole cache – a stored TITLE and a stored EPISODE cost
  // the same to keep (a few dozen bytes) and save the same (one TMDB request),
  // so there is no reason to reserve room for one kind at the expense of the
  // other. The oldest entries go first when the budget is used up (LRU); the
  // cache is a shortcut, not a database.
  const MAX_ENTRIES = 10000;
  const FLUSH_DELAY_MS = 500;

  /** The live state; written back debounced. */
  const state = { v: VERSION, matches: {}, episodes: {} };

  let ready = null; // Promise of the one-time load
  let flushTimer = null; // pending debounced write

  /* ------------------------------------------------------------------ *
   * Storage
   * ------------------------------------------------------------------ */

  /** Reads the stored blob once per background lifetime. */
  function load() {
    if (ready) return ready;
    ready = (async () => {
      try {
        const data = await browser.storage.local.get(STORAGE_KEY);
        const stored = data && data[STORAGE_KEY];
        if (!stored || stored.v !== VERSION) return; // nothing/old -> stay empty
        if (stored.matches) state.matches = stored.matches;
        if (stored.episodes) state.episodes = stored.episodes;
        log(
          "matchCache:",
          Object.keys(state.matches).length,
          "matches,",
          Object.keys(state.episodes).length,
          "episodes loaded",
        );
      } catch (err) {
        logErr("matchCache: could not be read ->", err.message);
      }
    })();
    return ready;
  }

  /** Schedules the write-back (coalesces a whole batch of stores into one). */
  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch(() => {});
    }, FLUSH_DELAY_MS);
  }

  /** Writes the current state to storage right now. */
  async function flush() {
    await load();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: state });
    } catch (err) {
      logErr("matchCache: could not be written ->", err.message);
    }
  }

  /* ------------------------------------------------------------------ *
   * Keys
   * ------------------------------------------------------------------ */

  /** Cache key of a provider title – medium included ("Road House" is a movie,
   *  the series of the same name must not hit the movie's entry). */
  function matchKey(title, isTv) {
    const name = normTitle(title);
    if (!name) return "";
    return (isTv ? "tv" : "movie") + "|" + name;
  }

  /** Cache key of one episode name of one series. */
  function episodeKey(tmdbId, episodeTitle) {
    const id = Number(tmdbId);
    const name = normName(episodeTitle);
    if (!Number.isInteger(id) || id <= 0 || !name) return "";
    return id + "|" + name;
  }

  /**
   * Keeps the cache inside its budget, dropping the least recently used entries.
   *
   * Deliberately ONE list over both kinds: an episode competes with a title for
   * the same budget, so a series with hundreds of episodes cannot push the
   * titles out (and the other way round). Evicting per kind would let one kind
   * fill up while the other stays half empty.
   */
  function evict() {
    const kinds = [state.matches, state.episodes];
    let excess = kinds.reduce(
      (sum, store) => sum + Object.keys(store).length,
      0,
    );
    excess -= MAX_ENTRIES;
    if (excess <= 0) return;

    const all = [];
    for (const store of kinds) {
      for (const key of Object.keys(store)) {
        all.push({ store, key, at: store[key].at || 0 });
      }
    }
    all.sort((a, b) => a.at - b.at);
    const dropped = excess;
    for (const entry of all) {
      if (excess-- <= 0) break;
      delete entry.store[entry.key];
    }
    log("matchCache: dropped", dropped, "of the oldest entries");
  }

  /* ------------------------------------------------------------------ *
   * Matches
   * ------------------------------------------------------------------ */

  /**
   * Cached TMDB match of a provider title, `UNMATCHED` when the user decided
   * that this title has no match at all, or null when nothing is stored.
   *
   * The stored year guards against same-titled remakes ("Road House" 1989 vs
   * 2024): when the provider reports a year and the cached match is from a
   * different one, the entry does not apply and the title is searched again –
   * a miss costs one request, a wrong match would cost the user an import into
   * the wrong entry.
   *
   * The returned object is fresh apart from the identity: the Watcharr state
   * (`watchedId`, `watchedStatus`, `watchedCreatedAt`) is NOT part of the cache
   * (see the file header) and is filled by the caller.
   */
  async function lookupMatch(title, year, isTv) {
    await load();
    const key = matchKey(title, isTv);
    const entry = key && state.matches[key];
    if (!entry) return null;
    // A stored "no match" decision (see storeUnmatched) – not a miss.
    if (!entry.m) return UNMATCHED;
    if (!entry.m.tmdbId) return null;

    const wantYear = Number(year) || null;
    const haveYear = Number(entry.m.year) || null;
    if (wantYear && haveYear && wantYear !== haveYear) {
      log(
        "matchCache:",
        JSON.stringify(title),
        "year",
        wantYear,
        "!= cached",
        haveYear,
        "-> searching again",
      );
      return null;
    }

    entry.at = Date.now(); // keep the entry warm (LRU)
    schedule();
    return {
      tmdbId: entry.m.tmdbId,
      contentType: entry.m.contentType === "movie" ? "movie" : "tv",
      name: entry.m.name || null,
      posterPath: entry.m.posterPath || null,
      year: entry.m.year == null ? null : String(entry.m.year),
      ambiguous: !!entry.m.ambiguous,
      watchedId: null,
      watchedStatus: null,
      watchedCreatedAt: null,
    };
  }

  /**
   * Stores (or replaces) the match of a provider title – called for an
   * automatically resolved match as well as for the result the user picked in
   * "Change match".
   */
  async function storeMatch(title, year, isTv, match) {
    await load();
    const key = matchKey(title, isTv);
    const tmdbId = match && Number(match.tmdbId);
    if (!key || !Number.isInteger(tmdbId) || tmdbId <= 0) return;
    state.matches[key] = {
      at: Date.now(),
      m: {
        tmdbId,
        contentType: match.contentType === "movie" ? "movie" : "tv",
        name: match.name || null,
        posterPath: match.posterPath || null,
        // TMDB's own year of the match – the value `lookupMatch` compares the
        // provider's year against.
        year: match.year == null ? null : String(match.year),
        ambiguous: !!match.ambiguous,
      },
    };
    evict();
    schedule();
    log("matchCache: stored", JSON.stringify(title), "->", tmdbId);
  }

  /**
   * Stores the decision "this title is deliberately NOT matched" – the user's
   * counterpart to a picked match. `lookupMatch` answers it with `UNMATCHED`
   * instead of null, so the title is not searched and not auto-guessed again on
   * the next load (see matcher.matchTitle).
   */
  async function storeUnmatched(title, isTv) {
    await load();
    const key = matchKey(title, isTv);
    if (!key) return;
    state.matches[key] = { at: Date.now(), m: null };
    evict();
    schedule();
    log("matchCache: stored 'no match' for", JSON.stringify(title));
  }

  /**
   * Drops the stored match of one provider title – used by "reset to
   * automatic", which wants the next resolution to search TMDB again instead
   * of answering with the (possibly user-picked) cached entry. Removing the
   * entry also undoes a stored "no match" decision (see storeUnmatched).
   */
  async function forgetMatch(title, isTv) {
    await load();
    const key = matchKey(title, isTv);
    if (!key || !state.matches[key]) return;
    delete state.matches[key];
    schedule();
    log("matchCache: forgot match", JSON.stringify(title));
  }

  /* ------------------------------------------------------------------ *
   * Episodes
   * ------------------------------------------------------------------ */

  /** Season/episode that was resolved for this episode NAME of this series, or
   *  null (see matcher.deriveEpisode). */
  async function lookupEpisode(tmdbId, episodeTitle) {
    await load();
    const key = episodeKey(tmdbId, episodeTitle);
    const entry = key && state.episodes[key];
    if (!entry) return null;
    entry.at = Date.now();
    schedule();
    return { season: entry.s, episode: entry.e };
  }

  /** Stores the season/episode of one episode name (derived by TMDB or set by
   *  the user). */
  async function storeEpisode(tmdbId, episodeTitle, season, episode) {
    await load();
    const key = episodeKey(tmdbId, episodeTitle);
    const s = Number(season);
    const e = Number(episode);
    // Season 0 (specials) is valid, an episode number starts at 1.
    if (
      !key ||
      !Number.isInteger(s) ||
      s < 0 ||
      !Number.isInteger(e) ||
      e < 1
    ) {
      return;
    }
    const known = state.episodes[key];
    if (known && known.s === s && known.e === e) return; // unchanged
    state.episodes[key] = { at: Date.now(), s, e };
    evict();
    schedule();
    log(
      "matchCache: stored episode",
      JSON.stringify(episodeTitle),
      "of TMDB",
      tmdbId,
      "-> S" + s + "E" + e,
    );
  }

  /**
   * Drops the stored season/episode of one episode name of one series – used
   * by "reset to automatic" so a corrected number does not come back out of
   * the cache (see deriveEpisode).
   */
  async function forgetEpisode(tmdbId, episodeTitle) {
    await load();
    const key = episodeKey(tmdbId, episodeTitle);
    if (!key || !state.episodes[key]) return;
    delete state.episodes[key];
    schedule();
    log("matchCache: forgot episode", JSON.stringify(episodeTitle));
  }

  /* ------------------------------------------------------------------ *
   * Maintenance
   * ------------------------------------------------------------------ */

  /** Drops every cached match and episode (nothing else depends on them). */
  async function clear() {
    await load();
    state.matches = {};
    state.episodes = {};
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    try {
      await browser.storage.local.remove(STORAGE_KEY);
      log("matchCache: cleared");
    } catch (err) {
      logErr("matchCache: could not be cleared ->", err.message);
    }
  }

  /** Number of cached entries (diagnostics/tests): titles and episodes, plus
   *  their sum – `MAX_ENTRIES` applies to the sum. */
  async function size() {
    await load();
    const matches = Object.keys(state.matches).length;
    const episodes = Object.keys(state.episodes).length;
    return { matches, episodes, total: matches + episodes };
  }

  globalThis.WatcharrMatchCache = {
    UNMATCHED,
    lookupMatch,
    storeMatch,
    storeUnmatched,
    forgetMatch,
    lookupEpisode,
    storeEpisode,
    forgetEpisode,
    flush,
    clear,
    size,
  };
})();
