/*
 * Netflix – viewing activity for the history page.
 *
 * Netflix has no simple history API: the list is pulled page by page from the
 * `aui/pathEvaluator` endpoint (the same one Universal Trakt Scrobbler uses –
 * the old `/api/shakti/.../viewingactivity` answers 404). Each raw entry is
 * then enriched with year/season/episode from the metadata endpoint
 * (content/netflix/netflix-metadata.js – shared with the scrobbler, so a
 * Netflix id is only fetched once).
 */
"use strict";

(function () {
  const PAGE_SIZE = 20;
  // Catalog language of the show metadata (see findHistoryEpisode).
  const DEFAULT_LANGUAGE = "en-US";

  // One pause per Netflix page (20 entries): keeps the "oldest first" full
  // crawl from walking hundreds of pages at full speed, without slowing the
  // incremental scroll mode (which is already human paced).
  const PAGE_GAP_MS = 500;
  const throttle = WatcharrContentUtil.createThrottle(PAGE_GAP_MS);

  // One diagnostic line per series whose episode could not be located: such a
  // row has no season/episode, so the import would only create the series.
  const unresolvedSeries = new Set();

  function noteUnresolved(seriesId, raw, details) {
    const id = String(seriesId);
    if (unresolvedSeries.has(id)) return;
    unresolvedSeries.add(id);
    console.warn(
      "[watcharr-scrobbler] Netflix episode not found for series",
      id,
      "-",
      raw.seriesTitle || raw.title || "?",
      "(episode:",
      raw.episodeTitle || "?",
      ") |",
      (details || []).join(" | ") || "no catalog",
    );
  }

  /**
   * Session for the history API: from the injected probe when available,
   * otherwise parsed out of the /settings/viewed/ page.
   */
  async function getSession() {
    const fromProbe = WatcharrNetflixPlayback.getSession();
    if (fromProbe) return fromProbe;

    try {
      const resp = await fetch("https://www.netflix.com/settings/viewed/", {
        credentials: "include",
      });
      if (!resp.ok) return null;
      const html = await resp.text();
      const match = html.match(
        /"userInfo":\{"data":\{[^}]*"userGuid":"([^"]+)"/,
      );
      if (!match || !match[1]) return null;
      return { userGuid: match[1] };
    } catch (_) {
      return null;
    }
  }

  /** One page of the history, retried so a transient error loses no page. */
  async function fetchPage(session, page, pageSize) {
    const callPath = '["aui","viewingActivity",' + page + "," + pageSize + "]";
    const url =
      "https://www.netflix.com/api/aui/pathEvaluator/web/%5E2.0.0?method=call&callPath=" +
      encodeURIComponent(callPath) +
      "&falcor_server=0.1.0";
    const body =
      "param=" + encodeURIComponent(JSON.stringify({ guid: session.userGuid }));
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-netflix.request.routing":
        '{"path":"/nq/aui/endpoint/%5E1.0.0-web/pathEvaluator","control_tag":"auinqweb"}',
    };

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await throttle();
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body,
          credentials: "include",
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        const viewed =
          data &&
          data.jsonGraph &&
          data.jsonGraph.aui &&
          data.jsonGraph.aui.viewingActivity &&
          data.jsonGraph.aui.viewingActivity.value &&
          data.jsonGraph.aui.viewingActivity.value.viewedItems;
        return Array.isArray(viewed) ? viewed : [];
      } catch (err) {
        lastError = err;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    throw lastError || new Error("History page could not be loaded");
  }

  /**
   * Netflix reports `date` in Unix milliseconds; values in seconds are accepted
   * as fallback. (Multiplying unconditionally by 1000 once produced absurd
   * years and HTTP 400 from Watcharr.)
   */
  function toDate(ts) {
    const n = Number(ts);
    if (!isFinite(n) || n <= 0) return null;
    return new Date(n < 1e11 ? n * 1000 : n);
  }

  /** ISO-8601 string (a string survives the message channel, a Date may not). */
  function toIsoDate(ts) {
    const date = toDate(ts);
    return date ? date.toISOString() : null;
  }

  /**
   * Season/episode of ONE series history entry (`{ seasonNumber, episodeNumber,
   * episodeTitle }`), or null when Netflix has no metadata for it at all.
   * The episode's VIDEO ID is language independent, so the catalog is asked for
   * it first. `catalogs` holds the ones already fetched – the page's own
   * language first, because that catalog carries the LOCALIZED episode titles
   * this profile's history reports. Only when that does not answer either, the
   * default-language catalog is fetched as a last resort (cached, so the cost
   * is one extra request per unresolved series).
   *
   * The episode title is only used as a fallback and only when it identifies
   * exactly ONE episode of the show (see findEpisode) – a guess would put a
   * wrong episode into Watcharr.
   */
  async function findHistoryEpisode(entry, seriesId, catalogs) {
    const episodeId = String(entry.movieID);
    const hitById = (videos) => {
      for (const video of videos) {
        const hit = video
          ? WatcharrNetflixMetadata.findEpisode(video, episodeId)
          : null;
        if (hit) return hit;
      }
      return null;
    };
    const hitByTitle = (videos) => {
      if (!entry.episodeTitle) return null;
      for (const video of videos) {
        const hit = video
          ? WatcharrNetflixMetadata.findEpisode(video, null, entry.episodeTitle)
          : null;
        if (hit) return hit;
      }
      return null;
    };

    let hit = hitById(Object.values(catalogs));
    if (hit) return hit;

    // The view's OWN payload: Netflix reports specials/re-cuts/collections with
    // an episode the show catalog does not list, and that payload carries the
    // numbers itself.
    const own = await WatcharrNetflixMetadata.getVideo(episodeId);
    if (own) {
      hit =
        WatcharrNetflixMetadata.findEpisode(own, episodeId) ||
        WatcharrNetflixMetadata.ownEpisode(own);
      if (hit) return hit;
    }

    hit = hitByTitle(Object.values(catalogs));
    if (hit) return hit;

    // Last resort: the default-language catalog (by id, then by title).
    if (!catalogs[DEFAULT_LANGUAGE]) {
      const fallback = await WatcharrNetflixMetadata.getVideo(
        seriesId,
        DEFAULT_LANGUAGE,
      );
      catalogs[DEFAULT_LANGUAGE] = fallback;
      hit = hitById([fallback]) || hitByTitle([fallback]);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Adds year (and for series season/episode) to raw history entries. The extra
   * provider fields (episode title, Netflix video id, raw media type) are
   * displayed as-is on the provider side of the comparison page.
   */
  async function enrich(rawItems) {
    const enriched = [];
    // Language this Netflix profile reports its titles in – the episode name is
    // later looked up in that language (background/tmdb-site.js), so a delisted
    // title, which leaves nothing but the localized episode title, can still be
    // resolved.
    const otherLanguages = WatcharrNetflixMetadata.otherLanguages();
    const providerLanguage = otherLanguages[0] || null;
    // Series are looked up by the SERIES id (one response carries all of their
    // episodes), movies by their own id. The page's own language comes first:
    // that catalog carries the localized episode titles. Every variant of it is
    // tried (a bare "de" may answer while "de-DE" does not, and vice versa),
    // the default language last.
    const languages = otherLanguages.concat([DEFAULT_LANGUAGE]);

    for (const raw of rawItems) {
      if (!raw || raw.movieID == null) continue;
      const isTv = "series" in raw && raw.series != null;
      const catalogs = {};
      for (const language of languages) {
        const video = await WatcharrNetflixMetadata.getVideo(
          isTv ? raw.series : raw.movieID,
          language,
        );
        if (!video) continue;
        catalogs[language] = video;
        break;
      }
      const video = Object.values(catalogs)[0] || null;

      if (isTv) {
        const episode = await findHistoryEpisode(raw, raw.series, catalogs);
        // A series row without season/episode can only be imported as the
        // series itself, so the reason is carried to the UI (and logged once) –
        // "no metadata at all" and "the catalog does not list this episode"
        // need different fixes.
        let providerNote = null;
        if (!episode) {
          providerNote = Object.keys(catalogs).length
            ? "episodeUnknown"
            : "noMetadata";
          noteUnresolved(
            raw.series,
            raw,
            Object.keys(catalogs).map(
              (l) =>
                l + " -> " + WatcharrNetflixMetadata.describeVideo(catalogs[l]),
            ),
          );
        }
        enriched.push({
          date: raw.date ? toIsoDate(raw.date) : null,
          isTv: true,
          title: raw.seriesTitle || raw.title || (video && video.title) || "",
          year: video ? video.year || video.releaseYear || null : null,
          season: episode ? episode.seasonNumber : null,
          episode: episode ? episode.episodeNumber : null,
          // Netflix' own episode name is used when the metadata has none (an
          // episode missing from the catalog still has its history entry).
          episodeTitle:
            (episode && episode.episodeTitle) || raw.episodeTitle || null,
          // Netflix' own identifiers (the view is the episode's video id).
          providerId: String(raw.movieID),
          providerType: (video && video.type) || "show",
          providerNote,
          providerLanguage,
        });
      } else {
        enriched.push({
          date: raw.date ? toIsoDate(raw.date) : null,
          isTv: false,
          title: raw.title || (video && video.title) || "",
          year: video ? video.year || video.releaseYear || null : null,
          season: null,
          episode: null,
          episodeTitle: null,
          providerId: String(raw.movieID),
          providerType: (video && video.type) || "movie",
          providerLanguage,
        });
      }
    }
    return enriched.filter((e) => e.title);
  }

  /** One page of history for the history page. */
  async function fetchForUi(page) {
    const session = await getSession();
    if (!session || !session.userGuid) {
      throw new Error(
        "Netflix session could not be determined – please log in to Netflix.",
      );
    }
    const raw = await fetchPage(session, page, PAGE_SIZE);
    return {
      status: "ok",
      entries: await enrich(raw),
      done: raw.length === 0,
    };
  }

  globalThis.WatcharrNetflixHistory = { fetchForUi };
})();
