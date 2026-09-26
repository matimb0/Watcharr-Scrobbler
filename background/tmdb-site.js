/*
 * TV episode names in the user's language, straight from the TMDB website.
 *
 * Why this exists: Watcharr asks TMDB with a hardcoded `language=en-US`
 * (server/media/tmdb/tmdb.go), while the streaming services report LOCALIZED
 * episode titles – and for a title that left the catalogue that localized
 * episode title is the ONLY information left (Netflix serves no library data
 * for delisted titles any more: no year, no season, no episode). So the episode
 * name has to be looked up in the language it was reported in.
 *
 * Trakt does the same thing for its scrobblers (it resolves episodes by
 * searching the episode title), and TMDB's own website carries exactly what is
 * needed: the season page lists every episode with `data-season-number`,
 * `data-episode-number` and the localized name in the link's title attribute.
 *
 * The requests run in the BACKGROUND: the page is cross-origin to the
 * extension's pages, so the host permission (`*://*.themoviedb.org/*`, see
 * background/services.js) is needed and CORS does not apply there.
 */
"use strict";

(function () {
  const HOST = "https://www.themoviedb.org";
  // "de" -> "de-DE"; already qualified tags pass through unchanged. TMDB uses a
  // full tag, and for some languages the region is not the language code
  // (English is en-US, Portuguese pt-PT, Norwegian nb-NO, Chinese zh-CN).
  const DEFAULT_LANGUAGE = "en-US";
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

  /** TMDB language tag for a language code ("de" -> "de-DE", "en" -> "en-US"). */
  function languageTag(language) {
    const raw = String(language || "").trim();
    if (!raw) return DEFAULT_LANGUAGE;
    if (/^[a-z]{2}-[A-Z]{2}$/.test(raw)) return raw;
    const base = raw.split(/[-_]/)[0].toLowerCase();
    if (!base) return DEFAULT_LANGUAGE;
    return base + "-" + (LANGUAGE_REGIONS[base] || base.toUpperCase());
  }

  /** Language of the extension UI – the closest thing to the language the
   *  service pages report their titles in when no page language is known. */
  function uiLanguage() {
    try {
      if (browser.i18n && browser.i18n.getUILanguage) {
        return languageTag(browser.i18n.getUILanguage());
      }
    } catch (_) {
      /* no i18n API -> default below */
    }
    return DEFAULT_LANGUAGE;
  }

  /**
   * Episode list of ONE season page, as `{ season, episode, title }`.
   *
   * The anchors carry the numbers and look like
   *   <a ... data-episode-number="7" data-season-number="8"
   *      href="/tv/1447-psych/season/8/episode/7?language=de-DE"
   *      title="Psych: Staffel 8 (2014): Episode 7 - Imbiss der Tod sie scheidet">
   * so the numbers are read from the attributes and the name is the part of the
   * title attribute after ": Episode <number> - " (a name may itself contain
   * " - ", so the marker is used instead of splitting on the separator).
   */
  function parseSeasonHtml(html) {
    const out = [];
    const anchorRe = /<a\b[^>]*data-episode-number="(\d+)"[^>]*>/g;
    let match;
    while ((match = anchorRe.exec(html)) !== null) {
      const tag = match[0];
      const episode = Number(match[1]);
      const seasonMatch = tag.match(/data-season-number="(\d+)"/);
      const titleMatch = tag.match(/title="([^"]*)"/);
      if (!seasonMatch || !titleMatch) continue;
      const rawTitle = decodeEntities(titleMatch[1]).trim();
      const marker = ": Episode " + episode + " - ";
      const at = rawTitle.indexOf(marker);
      const title = at === -1 ? rawTitle : rawTitle.slice(at + marker.length);
      const season = Number(seasonMatch[1]);
      if (!title || !Number.isInteger(season) || !Number.isInteger(episode)) {
        continue;
      }
      out.push({ season, episode, title });
    }
    return out;
  }

  /** Minimal HTML entity decoding for the title attribute. */
  function decodeEntities(value) {
    return String(value)
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  }

  /** Season page of one series (`/season/<n>`), or null when unavailable. */
  async function fetchSeasonPage(tmdbId, seasonNumber, language) {
    const url =
      HOST +
      "/tv/" +
      encodeURIComponent(tmdbId) +
      "/season/" +
      encodeURIComponent(seasonNumber) +
      "?language=" +
      encodeURIComponent(language);
    try {
      const resp = await fetch(url, { credentials: "omit" });
      if (!resp.ok) {
        console.warn(
          "[watcharr-scrobbler] TMDB season",
          tmdbId + "/" + seasonNumber,
          "(" + language + ") answered HTTP",
          resp.status,
        );
        return [];
      }
      const episodes = parseSeasonHtml(await resp.text());
      // Only a season WITHOUT episodes is worth a log line (the index summary
      // reports the total) – keeps the console quiet during a normal import.
      if (!episodes.length) {
        console.warn(
          "[watcharr-scrobbler] TMDB season",
          tmdbId + "/" + seasonNumber,
          "(" + language + "): no episodes parsed",
        );
      }
      return episodes;
    } catch (err) {
      console.warn(
        "[watcharr-scrobbler] TMDB season lookup failed:",
        url,
        "->",
        err.message || String(err),
      );
      return [];
    }
  }

  /**
   * Episode list of ONE season page, fetched at most once (per series+language+
   * season) and shared by every row of that series. Parallel workers therefore
   * never double-fetch a season, and a second language costs nothing extra for
   * the pages the first one already loaded.
   */
  const seasonCache = new Map(); // "tmdbId|lang|season" -> Promise<episodes[]>

  // Ceiling for ALL season requests at once: rows of DIFFERENT series are
  // resolved in parallel too, and each of them fetches up to SEASON_CONCURRENCY
  // pages – without this limit a big import would open dozens of connections at
  // the same moment.
  const fetchLimit = WatcharrUtil.createLimiter(6);

  function seasonEpisodes(tmdbId, seasonNumber, language) {
    const key = String(tmdbId) + "|" + language + "|" + seasonNumber;
    let pending = seasonCache.get(key);
    if (!pending) {
      pending = fetchLimit(() =>
        fetchSeasonPage(tmdbId, seasonNumber, language),
      );
      seasonCache.set(key, pending);
    }
    return pending;
  }

  // How many season pages may be in flight at once. Keeps a 20-season show to
  // a few rounds instead of twenty, without hammering TMDB.
  const SEASON_CONCURRENCY = 5;

  /**
   * The episode a NAME means in one series – as
   *   `{ hit: {season, episode}|null, hasRealTitles, responses }`
   * where `hasRealTitles` tells whether the pages carried real episode titles
   * (instead of TMDB's generic “Folge 4” labels) and `responses` how many season
   * pages actually answered. The caller uses both to decide whether another
   * language (or another source at all) could still help – that is what keeps an
   * unresolvable row from fetching every season twice.
   *
   * `probe` is the name the service reported (already stripped of a series-name
   * prefix). Matching is tolerant (see WatcharrUtil.lookupName), the position a
   * name means is understood ("Pilot", "Folge 7"), and a name that belongs to
   * TWO episodes of the series resolves to nothing at all.
   *
   * The season pages are fetched in PARALLEL (SEASON_CONCURRENCY at a time) –
   * resolving one row of an 8-season show costs two rounds instead of eight
   * sequential requests. The result is memoized per series+language+probe, so
   * the many rows that share an episode title (the same episode watched twice,
   * a series imported in one go) cost no further work at all.
   */
  function findEpisode(tmdbId, seasonNumbers, language, probe) {
    const lang = languageTag(language);
    const name = WatcharrUtil.normName(probe);
    if (!name) {
      return Promise.resolve({ hit: null, hasRealTitles: false, responses: 0 });
    }
    const memoKey = String(tmdbId) + "|" + lang + "|" + name;
    if (probeCache.has(memoKey)) return probeCache.get(memoKey);

    const pending = (async () => {
      const seasons = (seasonNumbers || []).slice();
      const index = new Map();
      const ambiguous = new Set();
      // Every episode is linked twice on a season page (poster + expand), so
      // the episodes are deduplicated by number – only a name that really
      // belongs to TWO different episodes is ambiguous.
      const seenEpisodes = new Set();
      let responses = 0;
      let hasRealTitles = false;

      await WatcharrUtil.mapWithConcurrency(
        seasons,
        SEASON_CONCURRENCY,
        async (seasonNumber) => {
          const episodes = await seasonEpisodes(tmdbId, seasonNumber, lang);
          if (!Array.isArray(episodes)) return;
          responses += 1;
          for (const episode of episodes) {
            const episodeKey = episode.season + ":" + episode.episode;
            if (seenEpisodes.has(episodeKey)) continue;
            seenEpisodes.add(episodeKey);
            // A title that only repeats the position ("Folge 4") is TMDB's
            // generic label, not a real name – a catalogue of those does not
            // explain why a name was not found, so it is worth trying another
            // language (see the caller).
            if (!WatcharrUtil.positionKey(episode.title)) hasRealTitles = true;
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

      const hit = WatcharrUtil.lookupName(index, probe);
      if (hit) {
        console.log(
          "[watcharr-scrobbler] TMDB episode lookup",
          tmdbId,
          "(" + lang + "):",
          JSON.stringify(probe),
          "-> S" + hit.season + "E" + hit.episode,
          "(" + responses + " season pages)",
        );
      }
      return { hit, hasRealTitles, responses };
    })().catch((err) => {
      console.warn(
        "[watcharr-scrobbler] TMDB episode lookup failed for",
        tmdbId,
        "->",
        err.message || String(err),
      );
      // A failed request is not "no real titles" – the caller must not conclude
      // anything from it except "this source had no answer".
      return { hit: null, hasRealTitles: true, responses: 0 };
    });

    rememberProbe(memoKey, pending);
    return pending;
  }

  /**
   * Probe memo with a cap: a long history would otherwise collect every episode
   * title of every series it ever resolved. The oldest entries fall out first
   * (a re-lookup only costs the cached season pages, not new requests).
   */
  const probeCache = new Map();
  const PROBE_CACHE_MAX = 500;

  function rememberProbe(key, pending) {
    probeCache.set(key, pending);
    while (probeCache.size > PROBE_CACHE_MAX) {
      const oldest = probeCache.keys().next();
      if (oldest.done) break;
      probeCache.delete(oldest.value);
    }
  }

  function clearCache() {
    // `seasonCache` deliberately survives: it holds what was already fetched
    // over the network, and a reload of the same history would just ask for the
    // same pages again.
    probeCache.clear();
  }

  globalThis.WatcharrTmdbSite = {
    defaultLanguage: DEFAULT_LANGUAGE,
    languageTag,
    uiLanguage,
    findEpisode,
    clearCache,
  };
})();
