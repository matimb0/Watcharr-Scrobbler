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

  /**
   * Watcharr search type of a medium. Inline filters in the query
   * (`year:`/`fyear:`) are ONLY evaluated for a TYPED search – a "multi"
   * search strips them and ignores them (see buildQueries).
   */
  function searchType(isTv) {
    return isTv ? "show" : "movie";
  }

  /** Release year (movie) / first air year (series) of a result, or null. */
  function resultYear(result) {
    const raw = result && (result.releaseDate || result.year);
    if (raw == null) return null;
    const year = parseInt(String(raw).slice(0, 4), 10);
    return isNaN(year) ? null : year;
  }

  /**
   * Queries for one entry, most specific first:
   *  1. typed search + year filter (`year:` for movies, `fyear:` = TMDB first
   *     air year for series),
   *  2. typed search without the filter (the service's year may be the
   *     episode's year or differ from TMDB's),
   *  3. "multi" search without the filter (the entry exists only under the
   *     other medium type) – the last resort.
   * Steps 2/3 also cover Watcharr versions that do not know typed searches or
   * filters yet: an unknown filter only stays in the query text and finds
   * nothing, and the next variant still runs.
   */
  function buildQueries(title, year, isTv) {
    const name = String(title || "").trim();
    if (!name) return [];
    const typed = searchType(isTv);
    const queries = [];
    if (year) {
      const filter = (isTv ? "fyear:" : "year:") + year;
      queries.push({ query: name + " " + filter, type: typed });
    }
    queries.push({ query: name, type: typed });
    queries.push({ query: name, type: "multi" });
    return queries;
  }

  /** True when this search result is already on the user's Watcharr list. */
  function isOnList(result) {
    return !!(result && result.watched && result.watched.id);
  }

  /** Compact "name (year)" description of a search result, for logs. */
  function describeResult(result) {
    if (!result) return "(none)";
    return (
      (result.name || "?") +
      " (" +
      (resultYear(result) == null ? "?" : resultYear(result)) +
      ")" +
      (isOnList(result) ? " [on list]" : "")
    );
  }

  /**
   * Best guess from a TMDB search result list:
   *  1. exact title WITH the matching year (only against the wanted medium),
   *  2. matching year anywhere in the wanted medium,
   *  3. exact title that is already on the user's Watcharr list – providers
   *     like Prime Video report no year at all, so for same-titled remakes
   *     ("Road House") the entry the user already tracks is the best guess,
   *  4. first candidate.
   * The year decides between same-titled entries – "Road House" exists as 1989
   * and 2024 – and step 3 covers the case where no year is known at all.
   */
  function pickBest(results, title, isTv, year) {
    const wantType = isTv ? "tmdb_tv" : "tmdb_movie";
    let pool = results.filter((r) => r.type === wantType);
    if (!pool.length) pool = results.slice();
    const norm = (s) => (s || "").toLowerCase().trim();
    const want = norm(title);
    const named = pool.filter((r) => norm(r.name) === want);
    const candidates = named.length ? named : pool;
    const wantYear = Number(year) || null;

    if (wantYear) {
      const exact = candidates.find((r) => resultYear(r) === wantYear);
      if (exact) return exact;
      const hit = pool.find((r) => resultYear(r) === wantYear);
      if (hit) return hit;
    }

    // Several same-titled media (remake!) and no usable year: prefer the one
    // already tracked in Watcharr instead of taking an arbitrary first hit.
    if (candidates.length > 1) {
      log(
        "pickBest:",
        title,
        "year" + (wantYear || "?"),
        "->",
        candidates.map(describeResult).join(", "),
      );
      const onList = candidates.find(isOnList);
      if (onList) return onList;
      // Nothing distinguishes them: the first hit is a guess, so the row is
      // flagged (the history page then asks the user to check the match).
      const first = candidates[0];
      if (first) first.ambiguous = true;
      return first || null;
    }
    return candidates[0] || null;
  }

  /**
   * Watcharr/TMDB match for one entry (or null when nothing was found). Runs
   * `buildQueries` in order and returns the first match. A single failing
   * query variant only skips that variant – the error is re-thrown when NO
   * variant produced a match, so connection/auth problems stay visible.
   */
  async function searchWatcharr(title, year, isTv) {
    const settings = await getSettings();
    if (!settings.watcharrUrl || !settings.token) {
      throw userError("not_configured", "Watcharr is not configured.");
    }
    const client = new WatcharrClient(settings);
    let failed = null;
    for (const { query, type } of buildQueries(title, year, isTv)) {
      let results = [];
      try {
        const data = await client.search(query, type);
        results = (data && data.results) || [];
      } catch (err) {
        logErr("searchWatcharr: search failed for", query, "->", err.message);
        if (!failed) failed = err;
        continue;
      }
      log(
        "searchWatcharr:",
        type,
        JSON.stringify(query),
        "->",
        results.length,
        "results",
      );
      const match = resultToMatch(pickBest(results, title, isTv, year));
      if (match) {
        log("searchWatcharr: matched TMDB", match.tmdbId, "via", query);
        return match;
      }
    }
    if (failed) throw failed;
    logErr(
      "searchWatcharr: NO match for",
      JSON.stringify(title),
      "year",
      year,
      isTv ? "(series)" : "(movie)",
    );
    return null;
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

  /**
   * Watcharr search result -> the match object used by the history page. */
  function resultToMatch(result) {
    if (!result || !result.ids) return null;
    // Depending on the Watcharr version the id may arrive as a string.
    const tmdbId = Number(result.ids.tmdb);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
    const year = resultYear(result);
    return {
      tmdbId,
      contentType: result.type === "tmdb_movie" ? "movie" : "tv",
      name: result.name || null,
      posterPath: result.extPosterPath || result.poster_path || null,
      year: year == null ? null : String(year),
      // Set by pickBest when the choice between same-titled entries had to be
      // guessed (see there) – the history page then asks to verify the match.
      ambiguous: !!result.ambiguous,
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

    // Deliberately "multi": the EXACT TMDB id is applied to the results below,
    // so the broadest result set is the best one here (a wrong `type` in the
    // file must not hide the entry). Watcharr ignores inline `year:` filters
    // for "multi" searches – harmless, the id is what counts.
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

  /**
   * Episode titles per "tmdbId:season": the watched entry carries only
   * season/episode numbers, so the names come from TMDB's season details
   * (through Watcharr) – one request per season of a series.
   */
  const seasonEpisodesCache = new Map();

  function clearCache() {
    watchedEpisodesCache.clear();
    seasonEpisodesCache.clear();
    movieWatchedCache.clear();
  }

  /** episodeNumber -> episode name of one season (or null when unavailable). */
  function getSeasonEpisodes(tmdbId, seasonNumber) {
    const key = tmdbId + ":" + seasonNumber;
    if (seasonEpisodesCache.has(key)) return seasonEpisodesCache.get(key);

    const pending = (async () => {
      const client = new WatcharrClient(await getSettings());
      const data = await client.getSeasonDetails(tmdbId, seasonNumber);
      // The season route hands through TMDB's own response, so the episode
      // fields are snake_case (`episode_number`, `name`) – camelCase is only
      // read as a fallback in case a Watcharr version reforms them.
      const episodes = (data && (data.episodes || data.Episodes)) || [];
      const titles = new Map();
      for (const ep of episodes) {
        if (!ep) continue;
        const number =
          ep.episode_number != null ? ep.episode_number : ep.episodeNumber;
        const name = ep.name || ep.episodeName;
        if (number == null || !name) continue;
        titles.set(Number(number), name);
      }
      return titles;
    })().catch((err) => {
      logErr(
        "getSeasonEpisodes: error for tmdbId",
        tmdbId,
        "season",
        seasonNumber,
        "->",
        err.message,
      );
      return null;
    });

    seasonEpisodesCache.set(key, pending);
    return pending;
  }

  /** Name of one episode from TMDB (through Watcharr), or null. */
  async function getEpisodeName(tmdbId, seasonNumber, episodeNumber) {
    const titles = await getSeasonEpisodes(tmdbId, seasonNumber);
    if (!titles) return null;
    return titles.get(Number(episodeNumber)) || null;
  }

  /**
   * Watch dates of one Watcharr entry (one request per entry). They come from
   * the entry's watch events (`GET /api/activity/:watchedId`, each event may
   * carry a `customDate`). Returns them as ISO strings, newest first – used for
   * MOVIES, which have no episode-style lookup.
   */
  const movieWatchedCache = new Map(); // watchedId -> Promise<string[]>

  function getWatchDates(watchedId) {
    if (movieWatchedCache.has(watchedId)) {
      return movieWatchedCache.get(watchedId);
    }

    const pending = (async () => {
      const client = new WatcharrClient(await getSettings());
      const activities = await client.getActivity(watchedId);
      const dates = [];
      for (const activity of Array.isArray(activities) ? activities : []) {
        if (!activity || !activity.customDate) continue;
        const t = new Date(activity.customDate).getTime();
        if (!isNaN(t)) dates.push({ t, iso: activity.customDate });
      }
      dates.sort((a, b) => b.t - a.t);
      return dates.map((d) => d.iso);
    })().catch((err) => {
      logErr(
        "getWatchDates: error for watchedId",
        watchedId,
        "->",
        err.message,
      );
      return [];
    });

    movieWatchedCache.set(watchedId, pending);
    return pending;
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
      // set (= the watchedDate we passed to the API). The value maps each
      // recorded epoch second to the date Watcharr stored for it, so the exact
      // matching mode can show the recorded watch date.
      const finishedByEp = new Map(); // epKey -> Map<epoch seconds, iso date>
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
        if (!finishedByEp.has(key)) finishedByEp.set(key, new Map());
        finishedByEp.get(key).set(seconds, activity.customDate);
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
   * Fills the Watcharr-side episode/movie state of one matched item:
   *  - episodeStatus:      current status of the episode (null = not watched),
   *  - episodeDateMatched: a FINISHED activity exists for the exact date+time,
   *  - watcharrDate:       the date Watcharr recorded for this watch (episodes:
   *                        the latest recorded date; movies: the latest watch
   *                        event of the movie detail page),
   *  - episodeStatusKnown: false = unknown (lookup failed / no episode info).
   */
  async function resolveItemEpisodeStatus(item) {
    item.episodeStatus = null;
    item.episodeDateMatched = false;
    item.episodeStatusKnown = false;
    item.matchEpisodeName = null;
    // Watch date Watcharr actually holds for this entry – Watcharr-side data
    // (shown on the right side in exact matching mode only).
    item.watcharrDate = null;

    if (!item.match) return;

    // MOVIES: Watcharr's watch dates come from the entry's watch events (the
    // search/watchlist DTOs carry no activity).
    if (!item.isTv) {
      if (!item.match.watchedId) return;
      const dates = await getWatchDates(item.match.watchedId);
      item.watcharrDate = dates.length ? dates[0] : null;
      return;
    }

    const isEpisode = item.season != null && item.episode != null;
    if (!isEpisode) return;

    // Name of the matched episode: the Watcharr entry only stores season and
    // episode numbers, so the name comes from TMDB (through Watcharr). This is
    // Watcharr-side data and independent of whether the episode is watched yet.
    item.matchEpisodeName = await getEpisodeName(
      item.match.tmdbId,
      item.season,
      item.episode,
    );

    if (!item.match.watchedId) return;

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
    if (recorded && recorded.size) {
      // Exactly this watch, or otherwise the latest date Watcharr holds for
      // this episode (dates on the right side are always Watcharr's own data).
      if (item.episodeDateMatched) {
        item.watcharrDate = recorded.get(rowSeconds);
      } else {
        let latest = null;
        for (const iso of recorded.values()) {
          const t = new Date(iso).getTime();
          if (!isNaN(t) && (!latest || t > latest.t)) latest = { t, iso };
        }
        item.watcharrDate = latest ? latest.iso : null;
      }
    }
    item.episodeStatusKnown = true;
  }

  globalThis.WatcharrHistoryMatcher = {
    searchWatcharr,
    buildQueries,
    searchType,
    resultYear,
    isOnList,
    pickBest,
    pickByTmdbId,
    resultToMatch,
    resolveMatchByTmdbId,
    resolveItemEpisodeStatus,
    getEpisodeName,
    getWatchDates,
    clearCache,
  };
})();
