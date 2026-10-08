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
  const {
    log,
    logErr,
    normTitle,
    normName,
    nameSimilarity,
    FUZZY_MIN_SIMILARITY,
    titleVariants,
    episodeKeys,
    addEpisodeToIndex,
    lookupName,
    mapWithConcurrency,
    createLimiter,
    positionKey,
    POSITION_PREFIX,
    epKey,
    toEpochSeconds,
  } = globalThis.WatcharrUtil;

  // How many season requests (Watcharr season details) may run at once – see
  // getSeriesEpisodeIndex and the TMDB module's own limit for its pages.
  const SEASON_CONCURRENCY = 5;
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
   *     other medium type) – the last resort,
   *  4. the REDUCED title forms as "multi" (see titleVariants): TMDB's search
   *     only hits when every token of the query is part of the title, so a
   *     service title carrying an extra "&"/article finds nothing otherwise.
   *     Those hits are title-verified (`reduced: true` -> pickExactTitle).
   *
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
    for (const reduced of titleVariants(name)) {
      queries.push({ query: reduced, type: "multi", reduced: true });
    }
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
   * Title-verified pick for a REDUCED query (see titleVariants / buildQueries).
   *
   * A reduced query carries fewer words than the service reported, so its hit
   * list is broader and `pickBest`'s "take the first candidate" fallback must
   * NOT apply – it would silently match a different title. A hit is accepted
   * only when the candidate's own name IS the service title; a mere spelling
   * difference is accepted but flagged `ambiguous`, which makes the history page
   * ask the user to check the match.
   */
  function pickExactTitle(results, title, isTv, year) {
    const wantType = isTv ? "tmdb_tv" : "tmdb_movie";
    let pool = results.filter((r) => r.type === wantType);
    if (!pool.length) pool = results.slice();

    const named = pool.filter((r) => nameSimilarity(r.name, title) >= 1);
    if (named.length) {
      // Same name: the year decides between same-titled media (remakes).
      const wantYear = Number(year) || null;
      if (wantYear) {
        const exact = named.find((r) => resultYear(r) === wantYear);
        if (exact) return exact;
      }
      return named[0];
    }

    let close = null;
    let best = 0;
    for (const r of pool) {
      const score = nameSimilarity(r.name, title);
      if (score > best) {
        best = score;
        close = r;
      }
    }
    if (close && best >= FUZZY_MIN_SIMILARITY) {
      close.ambiguous = true;
      return close;
    }
    return null;
  }

  /**
   * Searches TMDB directly (see background/tmdb.js) and adds what TMDB cannot
   * know: whether a candidate is already on the user's Watcharr list, with which
   * status (that is what keeps the import from creating a duplicate and what
   * makes the "already on my list" tie-break work).
   *
   * The result shape is exactly Watcharr's search shape, so every consumer of
   * the old search keeps working unchanged.
   */
  async function searchOnline(query, searchType) {
    const results = await WatcharrTmdb.search(query, searchType);
    return enrichWithListState(results);
  }

  // Candidates asked for their list state at most (see enrichWithListState).
  const MAX_ENRICHED_RESULTS = 3;

  /**
   * Fills `watched` into the candidates a picker may choose between: the ones
   * carrying the searched title (a different-titled candidate cannot win a
   * comparison based on the title anyway), capped so a broad search cannot
   * trigger dozens of requests.
   */
  async function enrichWithListState(results) {
    if (!results.length) return results;
    const settings = await getSettings();
    if (!settings.watcharrUrl || !settings.token) return results;

    const client = new WatcharrClient(settings);
    await Promise.all(
      results.slice(0, MAX_ENRICHED_RESULTS).map(async (result) => {
        const tmdbId = Number(result.ids && result.ids.tmdb);
        if (!Number.isInteger(tmdbId) || tmdbId <= 0) return;
        const contentType = result.type === "tmdb_movie" ? "movie" : "tv";
        const watched = await client.getWatchedState(tmdbId, contentType);
        if (watched && watched.id) result.watched = watched;
      }),
    );
    return results;
  }

  /**
   * TMDB match for one entry (or null when nothing was found). Runs
   * `buildQueries` in order and returns the first match. A single failing
   * query variant only skips that variant – the error is re-thrown when NO
   * variant produced a match, so connection/auth problems stay visible.
   */
  async function searchTmdb(title, year, isTv) {
    let failed = null;
    for (const { query, type, reduced } of buildQueries(title, year, isTv)) {
      let results = [];
      try {
        results = await searchOnline(query, type);
      } catch (err) {
        logErr("searchTmdb: search failed for", query, "->", err.message);
        if (!failed) failed = err;
        continue;
      }
      log(
        "searchTmdb:",
        type,
        JSON.stringify(query),
        "->",
        results.length,
        "results",
      );
      const pick = reduced ? pickExactTitle : pickBest;
      const match = resultToMatch(pick(results, title, isTv, year));
      if (match) {
        log("searchTmdb: matched TMDB", match.tmdbId, "via", query);
        return match;
      }
    }
    if (failed) throw failed;
    logErr(
      "searchTmdb: NO match for",
      JSON.stringify(title),
      "year",
      year,
      isTv ? "(series)" : "(movie)",
    );
    return null;
  }

  /**
   * Fills the Watcharr list state into a match. This is the ONE part of a match
   * that must never come from the cache: whether the title is already on the
   * list – and with which status – changes with every import (see the file
   * header of background/match-cache.js).
   *
   * For a series this is the same `/content/tv/:id` the episode status and the
   * season list need, so it costs no extra request (both are cached by TMDB id).
   */
  async function fillWatchedState(match) {
    const settings = await getSettings();
    if (!settings.watcharrUrl || !settings.token) return match;
    const client = new WatcharrClient(settings);
    const state = await client.getWatchedStateResult(
      match.tmdbId,
      match.contentType,
    );
    // The lookup itself failed: the extension does NOT KNOW whether the title is
    // on the list. Saying "not on the list" here (as `null` would) makes the row
    // promise an import that then collides with the existing entry (Watcharr
    // answers such a create with a 403), so the state is marked as unknown and
    // the page says so (see history/history.js).
    if (!state.ok) {
      match.watchedStateUnknown = true;
      return match;
    }
    // A successful read also withdraws an earlier "unknown" (e.g. after the
    // user re-picked the match of a row whose state once failed).
    match.watchedStateUnknown = false;
    const watched = state.watched;
    if (watched && watched.id) {
      match.watchedId = watched.id;
      match.watchedStatus = watched.status || null;
      // Date the Watcharr entry itself carries: adding a movie with a watch
      // date set it, and for movies it is the only place that date is stored
      // (unlike episodes, which keep it on their activity).
      match.watchedCreatedAt = watched.createdAt || null;
    }
    return match;
  }

  /**
   * TMDB match of a provider title – the entry point for the history rows and
   * the file export. The PERSISTENT cache comes first (background/match-cache.js):
   * a title that was matched once – automatically or by the user in "Change
   * match" – is answered from there without a single TMDB request, and only a
   * miss runs `searchTmdb`.
   *
   * `options.fillWatched` (default true) adds the Watcharr list state. Callers
   * that only need the TMDB identity – the file export – skip it.
   */
  async function matchTitle(title, year, isTv, options) {
    const fillWatched = !options || options.fillWatched !== false;
    const cached = await WatcharrMatchCache.lookupMatch(title, year, isTv);
    // The user marked this title as "no match" ("Change match"): that decision
    // counts, so no TMDB search may guess a match again.
    if (cached === WatcharrMatchCache.UNMATCHED) {
      log(
        "matchTitle:",
        JSON.stringify(title),
        "-> deliberately left unmatched",
      );
      return null;
    }
    if (cached) {
      log(
        "matchTitle:",
        JSON.stringify(title),
        "-> cached TMDB",
        cached.tmdbId,
      );
      return fillWatched ? await fillWatchedState(cached) : cached;
    }
    const match = await searchTmdb(title, year, isTv);
    if (match) {
      await WatcharrMatchCache.storeMatch(title, year, isTv, match);
      return fillWatched ? await fillWatchedState(match) : match;
    }
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
      watchedCreatedAt: (result.watched && result.watched.createdAt) || null,
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

    // The user's decisions beat the file's TMDB id: "no match" (see
    // rememberUnmatched) keeps the row unmatched, and a match the user picked
    // is the correction of what the file says – the next load must show it
    // again instead of silently falling back to the file's id.
    const prior = await WatcharrMatchCache.lookupMatch(
      item.title,
      item.year,
      item.isTv,
    );
    if (prior === WatcharrMatchCache.UNMATCHED) {
      log(
        "resolveMatchByTmdbId:",
        JSON.stringify(item.title),
        "-> deliberately left unmatched",
      );
      // The sentinel, not `null`: "the user removed this match" is a different
      // state than "the file's id was not found" – the caller labels the row
      // accordingly (`unmatched` vs `tmdb_not_found`).
      return WatcharrMatchCache.UNMATCHED;
    }
    if (prior && prior.manual) {
      log(
        "resolveMatchByTmdbId:",
        JSON.stringify(item.title),
        "-> user-picked TMDB",
        prior.tmdbId,
      );
      return await fillWatchedState(prior);
    }

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

    for (const query of queries) {
      let results = [];
      try {
        results = await searchOnline(query, "multi");
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
        // The list state MUST be filled for exactly this id: the search only
        // enriched its first few results (see enrichWithListState), and a title
        // like "Naked" has the right entry further down the list – without this
        // the row claims "will be added" although the entry is already there.
        return await fillWatchedState(resultToMatch(hit));
      }
    }
    return null;
  }

  /**
   * The Watcharr entry of one series (`GET /content/tv/<id>`), fetched ONCE per
   * TMDB id – the watched episodes, the season list and the episode names all
   * come from this one response, so a series is never requested twice.
   *
   * Resolves `{ ok, show }`; `ok:false` means the request failed (unknown),
   * which callers must not confuse with "the series has no episodes".
   */
  const showCache = new Map(); // tmdbId -> Promise<{ok, show}>

  function getShow(tmdbId) {
    if (showCache.has(tmdbId)) return showCache.get(tmdbId);

    const pending = (async () => {
      const client = new WatcharrClient(await getSettings());
      return { ok: true, show: await client.getWatchedShow(tmdbId) };
    })().catch((err) => {
      logErr("getShow: error for tmdbId", tmdbId, "->", err.message);
      return { ok: false, show: null };
    });

    showCache.set(tmdbId, pending);
    return pending;
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
    seriesSeasonsCache.clear();
    showCache.clear();
    movieWatchedCache.clear();
    if (globalThis.WatcharrTmdb) globalThis.WatcharrTmdb.clearCache();
    clearContentCache();
  }

  // Ceiling for all Watcharr requests at once: the seasons of one series are
  // fetched in parallel and so are the rows of DIFFERENT series, so this keeps a
  // big import from hammering the user's Watcharr instance.
  const watcharrLimit = createLimiter(6);

  /** episodeNumber -> episode name of one season (or null when unavailable). */
  function getSeasonEpisodes(tmdbId, seasonNumber) {
    const key = tmdbId + ":" + seasonNumber;
    if (seasonEpisodesCache.has(key)) return seasonEpisodesCache.get(key);

    const pending = (async () => {
      const episodes = await WatcharrTmdb.seasonEpisodes(tmdbId, seasonNumber);
      if (!episodes) return null;
      const titles = new Map();
      for (const ep of episodes) {
        if (!ep || ep.episode == null || !ep.title) continue;
        titles.set(Number(ep.episode), ep.title);
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

  /** Name of one episode from TMDB, or null. */
  async function getEpisodeName(tmdbId, seasonNumber, episodeNumber) {
    const titles = await getSeasonEpisodes(tmdbId, seasonNumber);
    if (!titles) return null;
    return titles.get(Number(episodeNumber)) || null;
  }

  /**
   * Fills in season/episode for a row whose SERVICE reported none – derived from
   * the data Watcharr already has: if exactly ONE episode of the matched series
   * is recorded with this row's watch date (the watch time the service
   * reported), then that episode is the one that was watched.
   *
   * This is not a guess: the episode is identified by a date+time match within
   * DATE_MATCH_TOLERANCE_SECONDS (services and Watcharr can differ by hours,
   * e.g. because of timezones), and nothing is set when the date matches
   * several episodes or none. It recovers the numbering for titles a service
   * does not report (episode) data for any more, as long as the watch is
   * already known to Watcharr.
   */
  const DATE_MATCH_TOLERANCE_SECONDS = 6 * 60 * 60;

  async function resolveEpisodeFromDate(item) {
    if (!item.isTv || !item.match) return false;
    if (item.season != null && item.episode != null) return false;
    const seconds = toEpochSeconds(item.date);
    if (seconds == null) return false;

    // A series without recorded episodes has nothing to match against, and the
    // result is "unknown" (not "no episodes") when the lookup itself failed.
    const result = await getWatchedEpisodes(item.match.tmdbId);
    if (!result.ok || !result.finishedByEp.size) return false;

    const hits = [];
    for (const [key, dates] of result.finishedByEp) {
      for (const epoch of dates.keys()) {
        if (Math.abs(Number(epoch) - seconds) <= DATE_MATCH_TOLERANCE_SECONDS) {
          const [season, episode] = String(key).split(":");
          hits.push({ season: Number(season), episode: Number(episode) });
          break;
        }
      }
    }
    if (hits.length !== 1) return false;
    const hit = hits[0];
    if (!Number.isInteger(hit.season) || !Number.isInteger(hit.episode)) {
      return false;
    }

    item.season = hit.season;
    item.episode = hit.episode;
    item.episodeSource = "date";
    log(
      "resolveEpisodeFromDate:",
      JSON.stringify(item.title),
      item.date,
      "-> S" + hit.season + "E" + hit.episode,
    );
    return true;
  }

  /** Seasons of one series (cached) as `{ number, episodeCount }` – see
   *  seasonSummary. The counts are what make the request-free positional fast
   *  path below possible. */
  const seriesSeasonsCache = new Map(); // tmdbId -> Promise<SeasonSummary[]>

  /**
   * Seasons of a Watcharr show entry as `{ number, episodeCount }`, taken from
   * TMDB's own overview that Watcharr caches. Pure - no request.
   */
  function seasonSummary(show) {
    const seasons = Array.isArray(show && show.seasons) ? show.seasons : [];
    return seasons
      .map((s) => ({
        number: Number(s && s.number),
        episodeCount: Number(s && s.episodeCount) || 0,
      }))
      .filter((s) => Number.isInteger(s.number));
  }

  function getSeriesSeasons(tmdbId) {
    if (seriesSeasonsCache.has(tmdbId)) return seriesSeasonsCache.get(tmdbId);

    const pending = (async () => {
      const { ok, show } = await getShow(tmdbId);
      if (!ok) return [];
      return seasonSummary(show);
    })().catch((err) => {
      logErr("getSeriesSeasons: error for tmdbId", tmdbId, "->", err.message);
      return [];
    });

    seriesSeasonsCache.set(tmdbId, pending);
    return pending;
  }

  /**
   * Season numbers a name lookup has to consider: the seasons that still hold
   * episodes. An empty season (announced, not aired yet) can never contain the
   * episode, so its page is not fetched at all.
   */
  function seasonsToSearch(seasons) {
    const withEpisodes = seasons.filter((s) => s.episodeCount > 0);
    const pool = withEpisodes.length ? withEpisodes : seasons;
    return pool.map((s) => s.number);
  }

  /**
   * Resolves a POSITIONAL episode name WITHOUT a single request: "Pilot" is the
   * first episode, "Staffel 3 Folge 7" the seventh of season 3, and "Folge 7" is
   * unambiguous when the series has only ONE season with episodes. The season
   * list including the episode counts comes from Watcharr, so nothing has to be
   * fetched for this.
   *
   * A position the show does not have (empty season, number beyond the episode
   * count) resolves to nothing - never to a guess.
   */
  function positionalEpisode(item, seasons) {
    const key = positionKey(episodeProbeName(item));
    if (!key || key.indexOf(POSITION_PREFIX) !== 0) return null;
    const body = key.slice(POSITION_PREFIX.length);
    const byNumber = new Map(seasons.map((s) => [s.number, s]));
    const fits = (season, episode) =>
      !!season && season.episodeCount > 0 && episode <= season.episodeCount;

    if (body === "first") {
      // A series' pilot IS its first episode, whatever it is called.
      return fits(byNumber.get(1), 1) ? { season: 1, episode: 1 } : null;
    }
    const withSeason = body.match(/^s(\d+)e(\d+)$/);
    if (withSeason) {
      const season = Number(withSeason[1]);
      const episode = Number(withSeason[2]);
      return fits(byNumber.get(season), episode) ? { season, episode } : null;
    }
    const withoutSeason = body.match(/^e(\d+)$/);
    if (withoutSeason) {
      // Without a season the number is only usable when the show has one.
      const usable = seasons.filter((s) => s.episodeCount > 0);
      if (usable.length !== 1) return null;
      const episode = Number(withoutSeason[1]);
      return fits(usable[0], episode)
        ? { season: usable[0].number, episode }
        : null;
    }
    return null;
  }

  /**
   * The name to match an episode by: the service's episode title without a
   * series-name prefix.
   *
   * Netflix labels a pilot "Dexter – Pilot" ("<Series> – <Episode>", also seen
   * with ":", "|" and "-"), and that prefix would keep the name from
   * matching. It is only removed when the leading part IS the series name – an
   * episode title that merely starts with the series name ("Psych macht Musik:
   * Weltstars singen …") keeps its full name, because that IS the title.
   */
  function episodeProbeName(item) {
    const raw = String(item.episodeTitle || "").trim();
    if (!raw) return "";
    // A dash/pipe only separates when whitespace follows, so a hyphenated title
    // ("Spider-Man") is never split; a colon may sit directly on the name.
    const parts = raw.split(/\s*(?:[-–—|]\s+|:\s*)/);
    if (parts.length < 2) return raw;
    const head = normName(parts[0]);
    const series = normName(item.title);
    if (!head || !series || head !== series) return raw;
    const rest = parts.slice(1).join(" - ").trim();
    return rest || raw;
  }

  /**
   * Derives the season/episode of a series row whose SERVICE reported none – the
   * whole automatic resolution, cheapest source first:
   *
   *   1. the watch DATE: an episode of this series recorded in Watcharr at
   *      exactly this watch time (deterministic, no guessing),
   *   2. a POSITIONAL name ("Pilot", "Folge 7", "Staffel 3 Folge 7"): answered
   *      from Watcharr's season list alone – NO request at all,
   *   3. the PERSISTENT cache: this episode name was already resolved for this
   *      series (see background/match-cache.js) – an episode's number never
   *      changes, so nothing is fetched,
   *   4. the episode NAME in TMDB's episode list, in the extension's display
   *      language and in the language the service reported (season pages
   *      fetched in parallel). The second language only runs when the first list
   *      carried nothing but generic labels – TL;DR: one round instead of two
   *      for every row that cannot be resolved anyway (TMDB falls back to the
   *      original episode name per episode, so a real English title is already
   *      in the localized list when no translation exists). A hit is cached.
   *
   * Nothing is ever guessed – every step needs an exact (or, for names, uniquely
   * close) match, see the individual functions.
   */
  async function deriveEpisode(item) {
    if (!item.isTv || !item.match || !item.episodeTitle) return false;
    if (item.season != null && item.episode != null) {
      // The numbers are already known. A correction the USER made for this very
      // episode name still wins over them: the source (an imported file, or a
      // service that has no data left) reports its own numbers, and the user's
      // "Change match" correction is the better data.
      const decision = await WatcharrMatchCache.lookupEpisode(
        item.match.tmdbId,
        episodeProbeName(item),
      );
      if (!decision || !decision.manual) return false;
      reportEpisode(item, decision, "manual");
      log(
        "deriveEpisode:",
        JSON.stringify(item.title),
        JSON.stringify(item.episodeTitle),
        "(user's correction) -> S" + decision.season + "E" + decision.episode,
      );
      return true;
    }

    // 1. the exact watch date
    if (await resolveEpisodeFromDate(item)) return true;

    // 2. what the name means as a position
    const seasons = await getSeriesSeasons(item.match.tmdbId);
    if (!seasons.length) return false;
    const positional = positionalEpisode(item, seasons);
    if (positional) {
      reportEpisode(item, positional);
      log(
        "deriveEpisode:",
        JSON.stringify(item.title),
        JSON.stringify(item.episodeTitle),
        "(position, no request) -> S" +
          positional.season +
          "E" +
          positional.episode,
      );
      return true;
    }

    // 3. by NAME, over TMDB's episode lists. The PERSISTENT cache comes first:
    //    this episode name was resolved for this series before (by TMDB or by
    //    the user) and an episode's number never changes – the season pages are
    //    then not fetched again.
    const probe = episodeProbeName(item);
    // A very short name is not a usable key ("Pilot" is fine, "1" is not).
    if (normName(probe).length >= 3) {
      const tmdbId = item.match.tmdbId;
      const known = await WatcharrMatchCache.lookupEpisode(tmdbId, probe);
      if (known) {
        reportEpisode(item, known);
        log(
          "deriveEpisode:",
          JSON.stringify(item.title),
          JSON.stringify(item.episodeTitle),
          "(cached) -> S" + known.season + "E" + known.episode,
        );
        return true;
      }

      // 4. the episode name in TMDB's episode list, in the language the
      //    service reported it in (season pages fetched in parallel).
      const seasonNumbers = seasonsToSearch(seasons);
      const languages = [];
      const addLanguage = async (value) => {
        const tag = WatcharrTmdb.languageTag(value);
        if (tag && languages.indexOf(tag) === -1) languages.push(tag);
      };
      await addLanguage(await WatcharrTmdb.displayLanguage());
      await addLanguage(item.providerLanguage);

      for (const language of languages) {
        const result = await WatcharrTmdb.findEpisode(
          tmdbId,
          seasonNumbers,
          language,
          probe,
        );
        if (result.hit) {
          reportEpisode(item, result.hit);
          await WatcharrMatchCache.storeEpisode(
            tmdbId,
            probe,
            result.hit.season,
            result.hit.episode,
          );
          log(
            "deriveEpisode:",
            JSON.stringify(item.title),
            JSON.stringify(item.episodeTitle),
            "(" + language + ")",
            "-> S" + result.hit.season + "E" + result.hit.episode,
          );
          return true;
        }
        // Only a season list with GENERIC labels ("Folge 4") leaves room for
        // another language: where real names were seen, the name simply is not
        // part of this series, and a second round would find the same.
        if (result.hasRealTitles || !result.responses) return false;
      }
    }
    return false;
  }

  /** Writes a resolved episode onto the item and marks where it came from. */
  function reportEpisode(item, hit, source) {
    item.season = hit.season;
    item.episode = hit.episode;
    item.episodeSource = source || "name";
  }

  /**
   * Keeps the user's decision for later loads ("Change match"): the match they
   * picked and the numbers they corrected are the best data there is, so they
   * go into the persistent cache (background/match-cache.js) and the next load
   * needs neither a TMDB search nor a derivation for this title.
   *
   * The episode is stored under the same name the derivation looks up
   * (`episodeProbeName`, i.e. without a series-name prefix), so both sides
   * always meet on the same key.
   */
  async function rememberDecision(item) {
    if (!item || !item.match) return;
    await WatcharrMatchCache.storeMatch(
      item.title,
      item.year,
      item.isTv,
      item.match,
      // The user decided: this entry stays binding for the title, even when the
      // file/Service reports another year or an id of its own (see
      // resolveMatchByTmdbId and match-cache.lookupMatch).
      { manual: true },
    );
    if (item.isTv && item.season != null && item.episode != null) {
      // A row without a name has no key – storeEpisode ignores it then.
      await WatcharrMatchCache.storeEpisode(
        item.match.tmdbId,
        episodeProbeName(item),
        item.season,
        item.episode,
        // The user decided these numbers: they also beat the numbers a file or
        // the service reports for this episode (see deriveEpisode).
        { manual: true },
      );
    }
  }

  /**
   * Forgets the user's decision for this row ("reset" in "Change match"): the
   * stored match of the title and the stored season/episode of its episode
   * NAME are dropped, so the next resolution searches TMDB and derives the
   * numbers again instead of answering from the cache
   * (see background/match-cache.js).
   *
   * The episode is keyed by the TMDB id of the match that is being forgotten,
   * so the id is read BEFORE the match is dropped.
   */
  async function forgetDecision(item) {
    if (!item) return;
    const tmdbId = item.match && item.match.tmdbId;
    await WatcharrMatchCache.forgetMatch(item.title, item.isTv);
    if (item.isTv && tmdbId) {
      await WatcharrMatchCache.forgetEpisode(tmdbId, episodeProbeName(item));
    }
  }

  /**
   * Keeps the user's "no match" decision ("Change match" -> no match) in the
   * persistent cache: the title is stored as DELIBERATELY unmatched, so the
   * next load neither searches TMDB again nor shows a guessed match
   * (see background/match-cache.js). An explicit "no match" supersedes the
   * previous decision for this title, so that entry is dropped first.
   *
   * The episode cache is left alone: it is keyed by TMDB id + episode NAME and
   * stays valid for the series, independent of whether this row is matched.
   */
  async function rememberUnmatched(item) {
    if (!item) return;
    await WatcharrMatchCache.forgetMatch(item.title, item.isTv);
    await WatcharrMatchCache.storeUnmatched(item.title, item.isTv);
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

  /**
   * All watch dates Watcharr holds for a MOVIE, newest first: the entry's own
   * creation date plus the `customDate` of its watch events.
   *
   * The creation date is needed because Watcharr only stores the watch date of
   * a movie there (`POST /watched` sets the entry's date; unlike an episode, the
   * movie's activity carries no date), while a rewatch ("play") is a later
   * activity whose date the Watcharr UI stores on the activity itself.
   */
  async function getMovieWatchDates(match) {
    const dates = [];
    const add = (iso) => {
      if (iso && toEpochSeconds(iso) != null && dates.indexOf(iso) === -1) {
        dates.push(iso);
      }
    };
    add(match.watchedCreatedAt);
    for (const iso of await getWatchDates(match.watchedId)) add(iso);
    dates.sort((a, b) => toEpochSeconds(b) - toEpochSeconds(a));
    return dates;
  }

  /**
   * The date out of `dates` that is within DATE_MATCH_TOLERANCE_SECONDS of `iso`
   * and closest to it, or null when none is close enough. Used to tell "this
   * very watch is already recorded" from "only another watch of it is".
   */
  function closestRecordedDate(dates, iso) {
    const seconds = toEpochSeconds(iso);
    if (seconds == null) return null;
    let best = null;
    let bestDelta = Infinity;
    for (const candidate of dates) {
      const candidateSeconds = toEpochSeconds(candidate);
      if (candidateSeconds == null) continue;
      const delta = Math.abs(candidateSeconds - seconds);
      if (delta <= DATE_MATCH_TOLERANCE_SECONDS && delta < bestDelta) {
        bestDelta = delta;
        best = candidate;
      }
    }
    return best;
  }

  async function getWatchedEpisodes(tmdbId) {
    if (watchedEpisodesCache.has(tmdbId)) {
      return watchedEpisodesCache.get(tmdbId);
    }

    const pending = (async () => {
      const { ok, show } = await getShow(tmdbId);
      if (!ok) return { ok: false, episodes: [], finishedByEp: new Map() };
      const watched = show && show.watched;
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
      return { ok: false, episodes: [], finishedByEp: new Map() };
    });

    watchedEpisodesCache.set(tmdbId, pending);
    return pending;
  }

  /**
   * Fills the Watcharr-side episode/movie state of one matched item:
   *  - episodeStatus:      current status of the episode (null = not watched),
   *  - watchDateMatched:   THIS watch (date+time, within ±6 h – see
   *                        DATE_MATCH_TOLERANCE_SECONDS) is already recorded,
   *  - watcharrDate:       the date Watcharr recorded for this watch (the
   *                        matching one, otherwise the latest known),
   *  - episodeStatusKnown: false = unknown (lookup failed / no episode info)
   *                        – episodes only; a movie's date never "fails".
   */
  async function resolveItemEpisodeStatus(item) {
    item.episodeStatus = null;
    item.watchDateMatched = false;
    item.episodeStatusKnown = false;
    item.matchEpisodeName = null;
    // Watch date Watcharr actually holds for this entry – Watcharr-side data
    // (shown on the right side in exact matching mode only).
    item.watcharrDate = null;

    if (!item.match) return;

    // MOVIES: one Watcharr entry per movie, so every further watch of it is an
    // activity. Exact matching compares this row's date against all of them.
    if (!item.isTv) {
      if (!item.match.watchedId) return;
      const dates = await getMovieWatchDates(item.match);
      const matched = closestRecordedDate(dates, item.date);
      item.watchDateMatched = matched != null;
      item.watcharrDate = matched != null || !dates.length ? matched : dates[0];
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

    const recorded = result.finishedByEp.get(epKey(item.season, item.episode));
    // "Exactly this watch" = a FINISHED activity within the date tolerance, so
    // services and Watcharr may differ by up to 6 hours (e.g. timezones) and
    // still count as the same watch. The closest date wins.
    const matched =
      recorded && recorded.size
        ? closestRecordedDate(Array.from(recorded.values()), item.date)
        : null;
    item.watchDateMatched = matched != null;
    if (recorded && recorded.size) {
      // The matching watch, or otherwise the latest date Watcharr holds for
      // this episode (dates on the right side are always Watcharr's own data).
      if (matched != null) {
        item.watcharrDate = matched;
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
    matchTitle,
    buildQueries,
    searchType,
    resultYear,
    isOnList,
    pickBest,
    pickExactTitle,
    pickByTmdbId,
    resultToMatch,
    fillWatchedState,
    searchOnline,
    resolveMatchByTmdbId,
    resolveItemEpisodeStatus,
    resolveEpisodeFromDate,
    deriveEpisode,
    rememberDecision,
    forgetDecision,
    rememberUnmatched,
    getEpisodeName,
    getWatchDates,
    clearCache,
  };
})();
