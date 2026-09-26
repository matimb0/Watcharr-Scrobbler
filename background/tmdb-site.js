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

  const indexCache = new Map(); // "tmdbId|language" -> Promise<Map|null>

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
  async function fetchSeason(tmdbId, seasonNumber, language) {
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
   * Episode index of one series: normalized episode NAME -> { season, episode },
   * built from the season pages of `seasonNumbers`. Cached per series+language,
   * so a history page with many rows of one series costs one page per season.
   *
   * A name used by more than one episode is dropped from the index – an
   * ambiguous name must never resolve to a guessed episode. Lookups go through
   * `WatcharrUtil.lookupName`, which also accepts a close spelling.
   */
  function episodeIndex(tmdbId, seasonNumbers, language) {
    const lang = languageTag(language);
    const key = String(tmdbId) + "|" + lang;
    if (indexCache.has(key)) return indexCache.get(key);

    const pending = (async () => {
      const index = new Map();
      const ambiguous = new Set();
      // Every episode is linked twice on a season page (poster + expand), so
      // the episodes are deduplicated by their number first – only a name that
      // really belongs to TWO different episodes is ambiguous.
      const seenEpisodes = new Set();
      for (const seasonNumber of seasonNumbers || []) {
        const episodes = await fetchSeason(tmdbId, seasonNumber, lang);
        for (const episode of episodes) {
          const episodeKey = episode.season + ":" + episode.episode;
          if (seenEpisodes.has(episodeKey)) continue;
          seenEpisodes.add(episodeKey);
          // Indexed under its name AND its position, so an episode the service
          // labels differently ("Pilot" vs "Folge 1") still matches.
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
      }
      for (const name of ambiguous) index.delete(name);
      console.log(
        "[watcharr-scrobbler] TMDB episode index for",
        tmdbId,
        "(" + lang + "):",
        // One entry per episode plus its positional keys, so this is the number
        // of usable lookup keys, not of episodes.
        index.size,
        "keys",
      );
      return index;
    })().catch((err) => {
      console.warn(
        "[watcharr-scrobbler] TMDB episode index failed for",
        tmdbId,
        "->",
        err.message || String(err),
      );
      return null;
    });

    indexCache.set(key, pending);
    return pending;
  }

  function clearCache() {
    indexCache.clear();
  }

  globalThis.WatcharrTmdbSite = {
    defaultLanguage: DEFAULT_LANGUAGE,
    languageTag,
    uiLanguage,
    episodeIndex,
    clearCache,
  };
})();
