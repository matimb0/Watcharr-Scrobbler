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
    seriesEpisodeIndexCache.clear();
    seriesSeasonsCache.clear();
    showCache.clear();
    movieWatchedCache.clear();
    if (globalThis.WatcharrTmdbSite) globalThis.WatcharrTmdbSite.clearCache();
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
      const client = new WatcharrClient(await getSettings());
      const data = await watcharrLimit(() =>
        client.getSeasonDetails(tmdbId, seasonNumber),
      );
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
   * Episode index of one series: normalized episode NAME -> { season, episode }.
   * Built once per TMDB id from every season of the show (TMDB, through
   * Watcharr), so the names of the seasons are shared with the episode-name
   * cache above.
   *
   * The seasons are queried in PARALLEL (see WatcharrUtil.mapWithConcurrency) –
   * one request per season is unavoidable, but they must not run one after
   * another.
   *
   * A title carried by MORE than one episode is dropped from the index, so an
   * ambiguous name can never resolve to a guessed episode. Lookups go through
   * `lookupName`, which also accepts a close spelling.
   */
  const seriesEpisodeIndexCache = new Map(); // tmdbId -> Promise<Map|null>

  function getSeriesEpisodeIndex(tmdbId) {
    if (seriesEpisodeIndexCache.has(tmdbId)) {
      return seriesEpisodeIndexCache.get(tmdbId);
    }

    const pending = (async () => {
      const { ok, show } = await getShow(tmdbId);
      if (!ok) return null;
      const seasons = seasonSummary(show);
      const index = new Map();
      const ambiguous = new Set();
      await mapWithConcurrency(seasons, SEASON_CONCURRENCY, async (season) => {
        const titles = await getSeasonEpisodes(tmdbId, season.number);
        if (!titles) return;
        for (const [episodeNumber, name] of titles) {
          // Indexed under the episode name AND its position (see util.js), so a
          // row whose service labels the episode differently still matches.
          addEpisodeToIndex(
            index,
            ambiguous,
            episodeKeys(name, season.number, Number(episodeNumber)),
            { season: season.number, episode: Number(episodeNumber) },
          );
        }
      });
      for (const key of ambiguous) index.delete(key);
      return index;
    })().catch((err) => {
      logErr(
        "getSeriesEpisodeIndex: error for tmdbId",
        tmdbId,
        "->",
        err.message,
      );
      return null;
    });

    seriesEpisodeIndexCache.set(tmdbId, pending);
    return pending;
  }

  /**
   * Fills in season/episode for a row whose SERVICE reported none – derived from
   * the data Watcharr already has: if exactly ONE episode of the matched series
   * is recorded with this row's watch date (the watch time the service
   * reported), then that episode is the one that was watched.
   *
   * This is not a guess: the episode is identified by an exact date+time match
   * (a small tolerance covers services that report seconds differently), and
   * nothing is set when the date matches several episodes or none. It recovers
   * the numbering for titles a service does not report (episode) data for any
   * more, as long as the watch is already known to Watcharr.
   */
  const DATE_TOLERANCE_SECONDS = 120;

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
        if (Math.abs(Number(epoch) - seconds) <= DATE_TOLERANCE_SECONDS) {
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
   *   3. the episode NAME in TMDB's episode list, in the language the service
   *      reported it in (season pages fetched in parallel),
   *   4. the same name in the default language, but ONLY when the localized list
   *      carried nothing but generic labels – TL;DR: one round instead of two
   *      for every row that cannot be resolved anyway (TMDB falls back to the
   *      original episode name per episode, so a real English title is already
   *      in the localized list when no translation exists),
   *   5. the episode names Watcharr serves (same TMDB catalogue) – only as a
   *      safety net when TMDB's website could not be reached at all.
   *
   * Steps 3/4 also skip step 5: the same catalogue cannot match where TMDB's own
   * pages did not, so the extra requests are not spent.
   *
   * Nothing is ever guessed – every step needs an exact (or, for names, uniquely
   * close) match, see the individual functions.
   */
  async function deriveEpisode(item) {
    if (!item.isTv || !item.match || !item.episodeTitle) return false;
    if (item.season != null && item.episode != null) return false;

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

    // 3. + 4. by name, over TMDB's episode lists
    const Tmdb = globalThis.WatcharrTmdbSite;
    const probe = episodeProbeName(item);
    // A very short name is not a usable key ("Pilot" is fine, "1" is not).
    if (Tmdb && normName(probe).length >= 3) {
      const seasonNumbers = seasonsToSearch(seasons);
      const tmdbId = item.match.tmdbId;
      const first = Tmdb.languageTag(
        item.providerLanguage || Tmdb.uiLanguage(),
      );
      const fallback = Tmdb.languageTag(Tmdb.defaultLanguage || "en-US");

      const languages = [first];
      // The default language only adds a chance when the localized list had
      // nothing but generic labels (see the function comment).
      if (fallback !== first) languages.push(fallback);

      let answered = false;
      for (const language of languages) {
        const result = await Tmdb.findEpisode(
          tmdbId,
          seasonNumbers,
          language,
          probe,
        );
        answered = answered || result.responses > 0;
        if (result.hit) {
          reportEpisode(item, result.hit);
          log(
            "deriveEpisode:",
            JSON.stringify(item.title),
            JSON.stringify(item.episodeTitle),
            "(" + language + ")",
            "-> S" + result.hit.season + "E" + result.hit.episode,
          );
          return true;
        }
        if (result.hasRealTitles || !result.responses) break;
      }
      // TMDB's own pages were read: Watcharr serves the same catalogue, so the
      // name fallback below cannot find more than they did.
      if (answered) return false;
    }

    // 5. safety net: the episode names Watcharr serves
    return resolveEpisodeFromTitle(item, probe);
  }

  /** Writes a resolved episode onto the item and marks where it came from. */
  function reportEpisode(item, hit, source) {
    item.season = hit.season;
    item.episode = hit.episode;
    item.episodeSource = source || "name";
  }

  /**
   * Last resort when TMDB's website is not usable (host permission declined, an
   * outage): the same name lookup against the episode names Watcharr serves
   * (TMDB en-US). Positional names never reach this point – they are answered
   * from the season list before any request (see positionalEpisode).
   *
   * Every season of a series is queried once and in PARALLEL (cached, and reset
   * per history load), and the index is shared by all rows of that series.
   */
  async function resolveEpisodeFromTitle(item, probe) {
    const name = String(probe == null ? episodeProbeName(item) : probe);
    // A one-character title ("Pilot" is fine, "1" is not) is not a usable key.
    if (normName(name).length < 3) return false;

    const index = await getSeriesEpisodeIndex(item.match.tmdbId);
    const hit = index && lookupName(index, name);
    if (!hit) return false;

    reportEpisode(item, hit);
    log(
      "resolveEpisodeFromTitle:",
      JSON.stringify(item.title),
      JSON.stringify(item.episodeTitle),
      "-> S" + hit.season + "E" + hit.episode,
    );
    return true;
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
    resolveEpisodeFromDate,
    deriveEpisode,
    getEpisodeName,
    getWatchDates,
    clearCache,
  };
})();
