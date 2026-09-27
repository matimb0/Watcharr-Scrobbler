/*
 * TMDB access for the extension – the ONE place that talks to TMDB.
 *
 * ALL TMDB data (title search, shows/seasons, episode names) is fetched here,
 * DIRECTLY from the official API – never through the user's Watcharr instance:
 *
 *  - Watcharr asks TMDB with a hardcoded `language=en-US` (server/media/tmdb/tmdb.go),
 *    so localized episode names – the key to matching titles a service does not
 *    report episode data for any more – are simply not available through it,
 *  - one hop less, and the caching/rate limiting is ours.
 *
 * Watcharr stays the source of truth for everything about the USER (is it on
 * the list, which episodes are watched, adding/updating entries).
 *
 * The API key is the user's own if one is entered in the settings, else the key
 * bundled with the extension (registered for the scrobbler) – same approach as
 * Watcharr, which ships a default key and lets admins override it.
 *
 * The language is the extension's own display language (`settings.language`,
 * else the browser's), see `displayLanguage()`.
 */
"use strict";

(function () {
  const API = "https://api.themoviedb.org/3";
  /**
   * API key shipped with the extension – registered for the scrobbler under
   * this very name, exactly like Watcharr ships one for its instances. Users who
   * prefer their own key can enter it in the settings; theirs always wins.
   *
   * It has to live in the source: the stores build from the submitted source
   * and the API needs the key on every request (a build-time secret would never
   * reach the packaged add-on).
   */
  const DEFAULT_KEY = "245d4d2d8d0f67fe4500513d4f31382a";

  /**
   * How a stored credential is sent. TMDB hands out two things and both work
   * with the same `/3/` endpoints, so the user does not have to know which one
   * they copied:
   *   - the "API Key (v3 auth)": 32 hex characters, sent as `?api_key=…`
   *   - the "API Read Access Token (v4 auth)": a JWT, sent as `Bearer` header
   */
  function authOf(key) {
    const looksLikeJwt =
      /^ey[0-9A-Za-z_-]{10,}\./.test(key) || key.split(".").length === 3;
    return looksLikeJwt ? { bearer: key } : { param: key };
  }

  const DEFAULT_LANGUAGE = "en-US";
  // Region of a language tag ("de" -> "de-DE"). Some languages are not the
  // country of the same name (English is en-US, Portuguese pt-PT, …).
  const LANGUAGE_REGIONS = {
    en: "US",
    pt: "PT",
    no: "NO",
    nb: "NO",
    zh: "CN",
    sv: "SE",
    da: "DK",
    fi: "FI",
    cs: "CZ",
    el: "GR",
    he: "IL",
    hi: "IN",
    ja: "JP",
    ko: "KR",
    ru: "RU",
    tr: "TR",
    uk: "UA",
    vi: "VN",
    id: "ID",
    ro: "RO",
    th: "TH",
  };

  // Requests at a time (all TMDB calls of the extension share this ceiling).
  const LIMIT = 6;
  const limit = WatcharrUtil.createLimiter(LIMIT);

  // TMDB content changes slowly; keep what we fetched for the session.
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  /** A cache entry is `{ at, value }`; expired entries are refetched. */
  const cache = new Map(); // key -> { at, value }

  function cached(key, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS)
      return Promise.resolve(hit.value);
    const pending = Promise.resolve()
      .then(load)
      .then((value) => {
        if (value != null) cache.set(key, { at: Date.now(), value });
        return value;
      });
    return pending;
  }

  /* ------------------------------------------------------------------ *
   * Key + language
   * ------------------------------------------------------------------ */

  /** The API key to send: the user's own if set, else the bundled one. */
  async function apiKey() {
    let fromSettings = "";
    try {
      const settings = await WatcharrSettings.get();
      fromSettings = String((settings && settings.tmdbKey) || "").trim();
    } catch (_) {
      /* no settings (e.g. an isolated test) -> bundled key */
    }
    return fromSettings || DEFAULT_KEY;
  }

  /** True when there is a key to send at all (no request involved). */
  async function available() {
    return !!(await apiKey());
  }

  /**
   * Only reachable when `DEFAULT_KEY` was left empty in this file – a bug of
   * the build, not something the user can cause (the settings field is optional
   * and never required).
   */
  function noKeyError() {
    return apiError("No TMDB API key is configured.", 0, "tmdb_no_key");
  }

  /** TMDB language tag for a language code ("de" -> "de-DE", "en" -> "en-US"). */
  function languageTag(language) {
    const raw = String(language || "").trim();
    if (!raw) return DEFAULT_LANGUAGE;
    if (/^[a-z]{2}-[A-Z]{2}$/.test(raw)) return raw;
    const base = raw.split(/[-_]/)[0].toLowerCase();
    if (!base) return DEFAULT_LANGUAGE;
    return base + "-" + (LANGUAGE_REGIONS[base] || base.toUpperCase());
  }

  /**
   * The language the extension shows its UI in – `settings.language` (chosen on
   * the settings page), else the browser's UI language. Every TMDB request uses
   * it, so titles/episode names arrive in the language the user reads.
   */
  async function displayLanguage() {
    let chosen = "";
    try {
      const settings = await WatcharrSettings.get();
      chosen = String((settings && settings.language) || "").trim();
    } catch (_) {
      /* fall through to the browser language */
    }
    if (chosen) return languageTag(chosen);
    try {
      if (browser.i18n && browser.i18n.getUILanguage) {
        return languageTag(browser.i18n.getUILanguage());
      }
    } catch (_) {
      /* no i18n API -> default */
    }
    return DEFAULT_LANGUAGE;
  }

  /* ------------------------------------------------------------------ *
   * Requests
   * ------------------------------------------------------------------ */

  /**
   * Thrown for an API answer that needs action. `code` is the stable i18n code
   * the UI maps to a translated message (see history/history.js), so the user
   * never sees a raw English sentence in the row.
   */
  function apiError(message, status, code) {
    const err = new Error(message);
    err.tmdbStatus = status;
    if (code) err.userCode = code;
    return err;
  }

  /**
   * One API call: `/3<path>` with the key and the display language applied.
   * Returns the parsed body, or null when TMDB has no such entry (404) – that
   * is a normal answer ("this show/season does not exist"), not a failure.
   */
  async function api(path, params) {
    const key = await apiKey();
    if (!key) throw noKeyError();

    const auth = authOf(key);
    const headers = auth.bearer
      ? { Authorization: "Bearer " + auth.bearer }
      : undefined;
    const url = new URL(API + path);
    if (auth.param) url.searchParams.set("api_key", auth.param);
    url.searchParams.set(
      "language",
      (params && params.language) || DEFAULT_LANGUAGE,
    );
    for (const [name, value] of Object.entries(params || {})) {
      if (name === "language" || value == null || value === "") continue;
      url.searchParams.set(name, String(value));
    }

    return limit(async () => {
      let resp;
      try {
        resp = await fetch(url.toString(), { credentials: "omit", headers });
      } catch (err) {
        throw apiError(
          "TMDB could not be reached (" + (err.message || String(err)) + ")",
          0,
          "tmdb_unreachable",
        );
      }
      if (resp.status === 404) return null;
      if (resp.status === 401 || resp.status === 403) {
        throw apiError(
          "TMDB rejected the API key (HTTP " + resp.status + ").",
          resp.status,
          "tmdb_auth",
        );
      }
      if (resp.status === 429) {
        throw apiError("TMDB rate limit reached.", 429, "tmdb_rate_limit");
      }
      if (!resp.ok) {
        throw apiError(
          "TMDB request failed (HTTP " + resp.status + ").",
          resp.status,
          "tmdb_failed",
        );
      }
      try {
        return await resp.json();
      } catch (_) {
        throw apiError("TMDB returned an invalid answer.", resp.status);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Search
   * ------------------------------------------------------------------ */

  /**
   * Search TMDB and return the results in the shape Watcharr's search returns
   * (`type`, `ids.tmdb`, `name`, `releaseDate`, `extPosterPath`), so every
   * consumer of the old search works unchanged.
   *
   * `searchType` is one of "show", "movie" or "multi". A year is passed to
   * TMDB as a real filter (`first_air_date_year` / `year`); for "multi" it is
   * ignored, because TMDB does not support it there.
   */
  async function search(query, searchType) {
    const language = await displayLanguage();
    const { title, year } = parseQuery(query);
    if (!title) return [];

    const type =
      searchType === "movie" ? "movie" : searchType === "show" ? "tv" : "multi";
    let path = "/search/" + type;
    const params = { query: title, language, include_adult: "false" };
    if (type === "tv" && year) params.first_air_date_year = year;
    if (type === "movie" && year) params.year = year;

    let data;
    try {
      data = await api(path, params);
    } catch (err) {
      // The API is the ONLY source now, so a failure must be visible: instead
      // of a silent "no results" the caller gets the error and the UI reports
      // it (see the message handler and the history page).
      WatcharrUtil.logErr(
        "tmdb.search: failed for",
        JSON.stringify(title),
        "->",
        err.message,
      );
      throw err;
    }
    const results = (data && data.results) || [];
    return results.map(toSearchResult).filter(Boolean);
  }

  /** "Title year:2024" / "Title fyear:2024" -> { title, year }. */
  function parseQuery(query) {
    const raw = String(query || "").trim();
    const match = raw.match(/\s+(?:f?year):(\d{4})\s*$/i);
    if (!match) return { title: raw, year: null };
    return {
      title: raw.slice(0, match.index).trim(),
      year: Number(match[1]),
    };
  }

  /** One TMDB search hit as a Watcharr-shaped result, or null (people, …). */
  function toSearchResult(hit) {
    if (!hit || !hit.id) return null;
    const isMovie =
      hit.media_type === "movie" || (!hit.media_type && hit.title != null);
    const isTv =
      hit.media_type === "tv" || (!hit.media_type && hit.name != null);
    if (!isMovie && !isTv) return null;

    const date = (isMovie ? hit.release_date : hit.first_air_date) || "";
    return {
      type: isMovie ? "tmdb_movie" : "tmdb_tv",
      ids: { tmdb: Number(hit.id) },
      name: (isMovie ? hit.title : hit.name) || "",
      releaseDate: date || null,
      year: date ? Number(date.slice(0, 4)) : null,
      extPosterPath: hit.poster_path || null,
    };
  }

  /* ------------------------------------------------------------------ *
   * Show + season data
   * ------------------------------------------------------------------ */

  /**
   * Seasons of one series as `{ number, episodeCount }`, straight from TMDB.
   * Returns null when the API is not usable (no key) or the show is unknown –
   * the caller then falls back to Watcharr's own copy of the same data.
   */
  async function showSeasons(tmdbId) {
    // Without a key the caller falls back to Watcharr's own copy of this data.
    if (!(await available())) return null;
    return cached("seasons:" + tmdbId, async () => {
      const data = await api("/tv/" + encodeURIComponent(tmdbId), {
        language: await displayLanguage(),
      });
      const seasons = (data && data.seasons) || [];
      if (!seasons.length) return null;
      return seasons.map((s) => ({
        number: Number(s.season_number),
        episodeCount: Number(s.episode_count) || 0,
      }));
    }).catch((err) => {
      WatcharrUtil.logErr(
        "tmdb.showSeasons: failed for",
        tmdbId,
        "->",
        err.message,
      );
      return null;
    });
  }

  /**
   * Episodes of ONE season as `{ season, episode, title }` in the given
   * language (`language` omitted = the display language). Returns null when the
   * season is unknown, `[]` when it has no episodes.
   */
  async function seasonEpisodes(tmdbId, seasonNumber, language) {
    const tag = languageTag(language || (await displayLanguage()));
    return cached(
      "season:" + tmdbId + ":" + seasonNumber + ":" + tag,
      async () => {
        const data = await api(
          "/tv/" +
            encodeURIComponent(tmdbId) +
            "/season/" +
            encodeURIComponent(seasonNumber),
          { language: tag },
        );
        const episodes = (data && data.episodes) || [];
        return episodes.map((ep) => ({
          season: Number(ep.season_number),
          episode: Number(ep.episode_number),
          title: ep.name || "",
        }));
      },
    );
  }

  /* ------------------------------------------------------------------ *
   * Episode lookup (name -> season/episode)
   * ------------------------------------------------------------------ */

  // Season pages fetched in parallel (per series). They are cached by the
  // backend anyway, so rows of the same series share the work.
  const SEASON_CONCURRENCY = 5;

  /**
   * Episode index of one series in ONE language: every episode name (plus the
   * positions a name can mean, see WatcharrUtil.episodeKeys) mapped to
   * `{ season, episode }`, and how many season pages answered.
   *
   * A name used by more than one episode is not indexed at all – an ambiguous
   * name must never resolve to a guessed episode.
   */
  async function episodeIndex(tmdbId, seasonNumbers, language) {
    const index = new Map();
    const ambiguous = new Set();
    const seen = new Set();
    let answered = 0;

    await WatcharrUtil.mapWithConcurrency(
      seasonNumbers || [],
      SEASON_CONCURRENCY,
      async (seasonNumber) => {
        const episodes = await seasonEpisodes(tmdbId, seasonNumber, language);
        if (!episodes) return;
        answered += 1;
        for (const episode of episodes) {
          const key = episode.season + ":" + episode.episode;
          if (seen.has(key)) continue;
          seen.add(key);
          WatcharrUtil.addEpisodeToIndex(
            index,
            ambiguous,
            WatcharrUtil.episodeKeys(
              episode.title,
              episode.season,
              episode.episode,
            ),
            { season: episode.season, episode: episode.episode },
          );
        }
      },
    );
    for (const key of ambiguous) index.delete(key);
    return { index, answered };
  }

  /**
   * The episode a NAME means in one series:
   * `{ hit, hasRealTitles, responses }`.
   *
   *  - `hit` is `{ season, episode }` or null,
   *  - `hasRealTitles`: the season pages carried real episode names (not only
   *    generic labels like "Folge 4") – for those a second language cannot
   *    find more, because TMDB already falls back to the original name per
   *    episode when a translation is missing,
   *  - `responses`: how many season pages answered (0 = no data at all).
   *
   * Memoized per series+language+name, so the many rows sharing an episode
   * title cost nothing.
   */
  async function findEpisode(tmdbId, seasonNumbers, language, probe) {
    const name = WatcharrUtil.normName(probe);
    if (!name) return { hit: null, hasRealTitles: false, responses: 0 };
    const tag = languageTag(language);
    const memoKey = "find:" + tmdbId + ":" + tag + ":" + name;
    const memo = cache.get(memoKey);
    if (memo && Date.now() - memo.at < CACHE_TTL_MS) return memo.value;

    const { index, answered } = await episodeIndex(tmdbId, seasonNumbers, tag);
    const hit = WatcharrUtil.lookupName(index, probe);
    const hasRealTitles = [...index.keys()].some(
      (key) => key.indexOf(WatcharrUtil.POSITION_PREFIX) !== 0,
    );
    const value = { hit, hasRealTitles, responses: answered };
    cache.set(memoKey, { at: Date.now(), value });
    if (hit) {
      WatcharrUtil.log(
        "tmdb.findEpisode:",
        tmdbId,
        "(" + tag + ")",
        JSON.stringify(probe),
        "-> S" + hit.season + "E" + hit.episode,
        "(" + answered + " season pages)",
      );
    }
    return value;
  }

  function clearCache() {
    cache.clear();
  }

  globalThis.WatcharrTmdb = {
    DEFAULT_LANGUAGE,
    apiKey,
    available,
    languageTag,
    displayLanguage,
    search,
    parseQuery,
    showSeasons,
    seasonEpisodes,
    findEpisode,
    clearCache,
  };
})();
