/*
 * Netflix – metadata of the playing video (movie or series, title,
 * season/episode).
 *
 * Primary source is Netflix' own metadata endpoint. It is shared with the
 * history page (netflix-history.js), so one Netflix id is only ever fetched
 * once. When the endpoint is unavailable the title shown in the player DOM is
 * used as fallback, with the season/episode then coming from the /watch/ URL
 * and the metadata API of the history crawl.
 *
 * Netflix keeps moving its member web API around, so several metadata routes
 * AND parameter variations are tried (the `release` route works today, the
 * build-specific ones plus the legacy `shakti` routes and the `authURL`
 * variation are kept as fallbacks – like Universal Trakt Scrobbler does). A
 * throttled answer is retried once, so a burst of metadata requests (history
 * crawl) cannot leave a series without its year/season/episode.
 */
"use strict";

(function () {
  const HOST = "https://www.netflix.com";
  // The catalog is requested in this language first – it is the one the TMDB
  // search and the live player work with. `languages` is only a request hint:
  // an episode whose title does not match is retried in the page's own
  // language (see uiLanguage), because services report LOCALIZED episode
  // titles while the English catalog carries the original ones.
  const DEFAULT_LANGUAGE = "en-US";
  const RETRY_DELAY_MS = 400;
  // Metadata routes, the one working today first. `{build}` is the page's
  // BUILD_IDENTIFIER (see netflix-probe.js) – those routes are dropped while
  // the probe has not reported it yet.
  const METADATA_ROUTES = [
    "/nq/website/memberapi/release",
    "/nq/website/memberapi/{build}",
    "/api/shakti/{build}",
    "/api/shakti/mre",
  ];

  const videoCache = new Map(); // "id|language" -> Promise<video|null>
  // Lookup attempt budget per id+language (each attempt goes over up to three
  // request paths, see requestOnce) and a pause after repeated total failures.
  const MAX_ATTEMPTS = 4;
  const MAX_EMPTY_STREAK = 3;
  const COOLDOWN_MS = 60000;
  let emptyStreak = 0;
  let downUntil = 0;

  /**
   * Languages to try besides the default one – the Netflix UI language of the
   * page first (that is the language the service reports its episode titles
   * in), the browser language as a second candidate.
   */
  function otherLanguages() {
    const out = [];
    const push = (lang) => {
      if (!lang || lang === DEFAULT_LANGUAGE || out.indexOf(lang) !== -1)
        return;
      out.push(lang);
    };
    push(document.documentElement && document.documentElement.lang);
    push(typeof navigator !== "undefined" ? navigator.language : null);
    return out;
  }

  /** Metadata URLs of one Netflix id, best guess first. */
  function metadataUrls(id, language) {
    const session = WatcharrNetflixPlayback.getSession();
    const build = (session && session.buildIdentifier) || null;
    const suffix =
      "/metadata?languages=" +
      (language || DEFAULT_LANGUAGE) +
      "&movieid=" +
      encodeURIComponent(id);
    const urls = [];
    for (const route of METADATA_ROUTES) {
      if (route.indexOf("{build}") !== -1 && !build) continue;
      urls.push(HOST + route.replace("{build}", build) + suffix);
    }
    return urls;
  }

  /** The same URL with the profile's authURL appended, or null without one. */
  function withAuthUrl(url) {
    const session = WatcharrNetflixPlayback.getSession();
    const authUrl = (session && session.authUrl) || null;
    if (!authUrl) return null;
    return url + "&authURL=" + encodeURIComponent(authUrl);
  }

  /**
   * Raw `video` object of one Netflix id (null when no route answered). Cached
   * per id/language and shared with the history page, so a series is fetched
   * once even when its episodes appear all over the history.
   *
   * When the metadata service is unreachable (several lookups failed in a row),
   * requests are paused for a while: a crawl over hundreds of history rows must
   * not turn into hundreds of failing requests (and get the profile throttled).
   */
  function getVideo(id, language) {
    const lang = language || DEFAULT_LANGUAGE;
    const key = String(id) + "|" + lang;
    let pending = videoCache.get(key);
    if (pending) return pending;
    // During the pause nothing is requested AND nothing is cached: a lookup that
    // was skipped must be possible again once the pause is over (a cached null
    // would keep that series unresolved for the rest of the page's life).
    if (Date.now() < downUntil) return Promise.resolve(null);

    pending = fetchVideo(String(id), lang)
      .catch(() => null)
      .then((video) => {
        // Bookkeeping for the pause below.
        if (video) {
          emptyStreak = 0;
          downUntil = 0;
        } else if (++emptyStreak >= MAX_EMPTY_STREAK) {
          emptyStreak = 0;
          downUntil = Date.now() + COOLDOWN_MS;
          console.warn(
            "[watcharr-scrobbler] Netflix metadata keeps failing – pausing metadata requests for " +
              Math.round(COOLDOWN_MS / 1000) +
              "s.",
          );
        }
        return video;
      });
    videoCache.set(key, pending);
    return pending;
  }

  /**
   * Request path 1: THROUGH THE BACKGROUND (background/messages/netflix.js).
   * Not bound by the page CSP, sends the Netflix cookies, and mirrors what
   * Universal Trakt Scrobbler does.
   */
  async function viaBackground(url) {
    const runtime = typeof browser !== "undefined" && browser.runtime;
    if (!runtime || !runtime.sendMessage) return null;
    try {
      const resp = await browser.runtime.sendMessage({
        type: "watcharr:netflix:api",
        url,
      });
      if (resp && resp.ok)
        return { ok: true, status: resp.status, text: resp.text };
      if (resp && (resp.status || resp.error)) {
        return { ok: false, status: resp.status || 0, error: resp.error };
      }
    } catch (_) {
      /* no background handler -> next path */
    }
    return null;
  }

  const PAGE_TIMEOUT_MS = 2000;
  // How long the page path is skipped after it did not answer: the probe is
  // injected with the content script, so it is normally there within the first
  // moments – a request that raced with that injection must not disable the
  // path for the whole page lifetime.
  const PAGE_RETRY_MS = 30000;
  let pageRequestSeq = 0;
  let pagePathDownUntil = 0;

  /**
   * Request path 2: from the PAGE itself (MAIN world, see netflix-probe.js).
   * Netflix answers its member API only to requests that look like its own
   * app's, and this one is issued by the page with the page's cookies.
   */
  function viaPage(url) {
    if (Date.now() < pagePathDownUntil) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = "m" + ++pageRequestSeq;
      const event = "watcharr:netflix:metadata:" + id;
      let done = false;
      let timer = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        // Remember when the probe did not answer, so its timeout is not paid on
        // every single request (it is retried after PAGE_RETRY_MS).
        pagePathDownUntil = value ? 0 : Date.now() + PAGE_RETRY_MS;
        document.removeEventListener(event, onResponse);
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const onResponse = (e) => {
        let result = null;
        try {
          result = JSON.parse(e.detail);
        } catch (_) {
          /* malformed answer -> treat as unavailable */
        }
        finish(
          result && {
            ok: !!result.ok,
            status: result.status || 0,
            text: result.text,
          },
        );
      };
      // The probe is injected into every Netflix page; without it (or when it
      // is too slow) the request falls through to the next path.
      timer = setTimeout(() => finish(null), PAGE_TIMEOUT_MS);
      document.addEventListener(event, onResponse);
      document.dispatchEvent(
        new CustomEvent("watcharr:netflix:metadata", {
          detail: JSON.stringify({ id, url }),
        }),
      );
    });
  }

  /** Request path 3: a plain same-origin fetch from the content script. */
  async function viaDirect(url) {
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) return { ok: false, status: resp.status };
      return { ok: true, status: resp.status, text: await resp.text() };
    } catch (err) {
      return { ok: false, status: 0, error: err.message || String(err) };
    }
  }

  /**
   * One metadata request over every available path. `tried` records what each
   * path answered – it ends up in the console diagnostics, because "why is
   * there no episode?" can only be answered by the service's own status codes.
   */
  async function requestOnce(url) {
    const tried = [];
    const paths = [
      ["background", viaBackground],
      ["page", viaPage],
      ["direct", viaDirect],
    ];
    let last = { ok: false, status: 0 };
    for (const [name, via] of paths) {
      const result = await via(url);
      if (!result) continue;
      last = result;
      tried.push(name + "=" + result.status);
      // Answered, or the route is simply gone: no other path can do better.
      if (result.ok || result.status === 404) break;
      // 401/403/429/network error: the next path may have what this one lacks.
    }
    return Object.assign(last, { tried: tried.join(", ") });
  }

  /**
   * The `video` object out of a metadata answer. Netflix uses several shapes:
   * `{ video }` for a single item, `{ value: { video } }` in some builds and
   * `{ value: { videos: { <id>: … } } }` for the bulk variant – all of them are
   * accepted so a moved shape cannot silently kill the episode detection.
   */
  function videoOf(data, url) {
    if (!data || typeof data !== "object") return null;
    const id = (url.match(/movieid=(\d+)/) || [])[1] || null;
    const value = data.value || data;
    const candidates = [data.video, value.video];
    if (value.videos && typeof value.videos === "object") {
      if (id && value.videos[id]) candidates.push(value.videos[id]);
      const keys = Object.keys(value.videos);
      if (keys.length === 1) candidates.push(value.videos[keys[0]]);
    }
    for (const video of candidates) {
      if (video && typeof video === "object" && video.type) return video;
    }
    return null;
  }

  /**
   * One metadata request. `retryable` marks answers that may succeed later
   * (throttling, a transient network error, a non-JSON body) – a plain 404
   * means the route is gone and the next one is tried instead.
   */
  async function fetchVideoOnce(url) {
    const attempt = await requestOnce(url);
    // A short excerpt of the answer: Netflix' rejection says why it rejected
    // ("Not authorized", a login page, …) and that is the only way to tell
    // "wrong route" from "not logged in" from "wrong request context".
    const hint = String(attempt.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!attempt.ok) {
      return {
        video: null,
        // The status of the LAST path tried decides: a 404 means the route is
        // gone (then only another route can help), anything else may succeed
        // later (throttled, not logged in yet, network hiccup).
        retryable: attempt.status !== 404,
        status: attempt.tried + (hint ? ' "' + hint + '"' : ""),
      };
    }
    let data;
    try {
      data = JSON.parse(attempt.text);
    } catch (_) {
      return {
        video: null,
        retryable: true,
        status: "invalid JSON" + (hint ? ' "' + hint + '"' : ""),
      };
    }
    return {
      video: videoOf(data, url),
      retryable: false,
      status: attempt.status,
    };
  }

  /**
   * Raw metadata of one id, with a SMALL request budget – the history crawl
   * asks for many ids in a row:
   *   - a 404 means the route was moved on, so the next route is tried,
   *   - anything else (throttled, unauthorized, partial, network error) is
   *     retried once and then asked again with the profile's authURL; another
   *     route would hit the same wall, so the lookup stops there.
   *
   * Every attempt is reported once per id, so a series whose episodes stay
   * unresolved explains itself in the console.
   */
  async function fetchVideo(id, language) {
    const tried = [];
    // The extra attempts (retry + authURL) are spent once: they cost time and
    // the remaining routes hit different backends, so walking them is the
    // better use of the budget.
    let extraAttempts = true;
    let spent = 0;
    for (const url of metadataUrls(id, language)) {
      if (spent >= MAX_ATTEMPTS) break;
      spent += 1;
      const result = await fetchVideoOnce(url);
      tried.push(shortUrl(url) + "=" + result.status);
      if (result.video) return result.video;
      if (!result.retryable || !extraAttempts) continue;
      extraAttempts = false;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      spent += 1;
      const retry = await fetchVideoOnce(url);
      tried.push("retry=" + retry.status);
      if (retry.video) return retry.video;
      const authUrl = withAuthUrl(url);
      if (authUrl) {
        spent += 1;
        const auth = await fetchVideoOnce(authUrl);
        tried.push("authURL=" + auth.status);
        if (auth.video) return auth.video;
      }
    }

    console.warn(
      "[watcharr-scrobbler] Netflix metadata unavailable for",
      id,
      "(" + language + "):",
      tried.join(", "),
    );
    return null;
  }

  /** Short route name of a metadata URL, for the log line above. */
  function shortUrl(url) {
    return url.replace("https://www.netflix.com", "").split("/metadata")[0];
  }

  /** Lower-cased title, for comparing episode names. */
  function normTitle(value) {
    return String(value == null ? "" : value)
      .toLowerCase()
      .trim();
  }

  /** A finite number, or null (metadata fields arrive as strings too). */
  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Season/episode numbers of one episode inside a season. Netflix reports
   * them as `seq`, other payload shapes use `episodeNumber`/`seasonNumber` –
   * all of them are accepted, so a renamed field cannot kill the detection.
   */
  function toEpisode(season, episode) {
    return {
      seasonNumber: numberOrNull(
        season.seq != null ? season.seq : season.seasonNumber,
      ),
      episodeNumber: numberOrNull(
        episode.seq != null ? episode.seq : episode.episodeNumber,
      ),
      episodeTitle: episode.title || episode.name || null,
    };
  }

  /** Release year of a video payload (`year`, `releaseYear` or `release_year`). */
  function videoYear(video) {
    if (!video) return null;
    const year = numberOrNull(
      video.year != null
        ? video.year
        : video.releaseYear != null
          ? video.releaseYear
          : video.release_year,
    );
    return year && year > 1800 && year < 2200 ? year : null;
  }

  /**
   * The episode `videoId` inside a show's metadata (`{ seasonNumber,
   * episodeNumber, episodeTitle }`), or null when the metadata does not contain
   * that episode at all.
   *
   * Looked up by video id first. Netflix does not always report the same id for
   * a view as its own catalog uses, so `episodeTitle` is used as a second try –
   * but only when it identifies exactly ONE episode of the show, so a wrong
   * episode can never be picked.
   */
  function findEpisode(video, videoId, episodeTitle) {
    const seasons = seasonsOf(video);
    const wanted = videoId == null ? null : String(videoId);
    const want = normTitle(episodeTitle);

    let titleHit = null;
    let titleHits = 0;
    for (const season of seasons) {
      const episodes = Array.isArray(season.episodes) ? season.episodes : [];
      for (const episode of episodes) {
        if (wanted != null && String(episode.id) === wanted) {
          return toEpisode(season, episode);
        }
        if (want && normTitle(episode.title) === want) {
          titleHits += 1;
          if (!titleHit) titleHit = toEpisode(season, episode);
        }
      }
    }
    return titleHits === 1 ? titleHit : null;
  }

  /** The season list of a show payload (some builds nest it in `seasonList`). */
  function seasonsOf(video) {
    if (!video) return [];
    if (Array.isArray(video.seasons)) return video.seasons;
    const list = video.seasonList && video.seasonList.seasons;
    return Array.isArray(list) ? list : [];
  }

  /**
   * Short description of a show payload, for the console: how the season list
   * is named and how many episodes it holds. Only logged when an episode could
   * not be located in it.
   */
  function describeVideo(video) {
    if (!video) return "(no metadata)";
    const seasons = seasonsOf(video);
    const episodes = seasons.reduce(
      (sum, s) => sum + (Array.isArray(s.episodes) ? s.episodes.length : 0),
      0,
    );
    return (
      "type=" +
      (video.type || "?") +
      " year=" +
      (videoYear(video) || "?") +
      " seasons=" +
      seasons.length +
      " episodes=" +
      episodes +
      (Array.isArray(video.seasons)
        ? ""
        : " seasonsField=" +
          (video.seasons === undefined ? "missing" : typeof video.seasons)) +
      (video.seasonList
        ? " seasonList=" + JSON.stringify(video.seasonList.current || true)
        : "")
    );
  }

  /**
   * The episode Netflix itself reports as current: its video id in the current
   * payload, an object carrying the numbers in older ones.
   */
  function currentEpisode(video) {
    const current = video && video.currentEpisode;
    if (!current) return null;
    if (typeof current !== "object") return findEpisode(video, current, null);
    return {
      seasonNumber:
        current.season && typeof current.season.seq === "number"
          ? current.season.seq
          : typeof current.seq === "number"
            ? current.seq
            : null,
      episodeNumber: typeof current.seq === "number" ? current.seq : null,
      episodeTitle: current.title || null,
    };
  }

  /**
   * Numbers an EPISODE payload reports about itself (`summary.season` /
   * `summary.episode` on an episode-typed metadata item). Only read for
   * non-show payloads – a show's `summary` describes the show, not the episode.
   */
  function ownEpisode(video) {
    if (!video || video.type === "show") return null;
    const summary = video.summary || video;
    const seasonNumber = numberOrNull(summary.season);
    const episodeNumber = numberOrNull(summary.episode);
    if (seasonNumber == null || episodeNumber == null) return null;
    return {
      seasonNumber,
      episodeNumber,
      episodeTitle: video.title || null,
    };
  }

  async function fetchMetadata(videoId) {
    try {
      const video = await getVideo(videoId);
      if (!video || !video.title) return null;

      const meta = {
        type:
          video.type === "movie"
            ? "movie"
            : video.type === "show"
              ? "tv"
              : null,
        title: video.title,
        year: videoYear(video),
        seasonNumber: null,
        episodeNumber: null,
        episodeTitle: null,
      };

      if (meta.type === "tv") {
        // Find the playing episode in the show's episode list – the episode
        // Netflix itself reports as current is the last resort.
        const episode =
          findEpisode(video, videoId, null) || currentEpisode(video);
        if (episode) {
          meta.seasonNumber = episode.seasonNumber;
          meta.episodeNumber = episode.episodeNumber;
          meta.episodeTitle = episode.episodeTitle;
        }
      }
      return meta;
    } catch (_) {
      return null;
    }
  }

  /** Metadata for a Netflix video id, fetched once per id. */
  function getMetadata(videoId) {
    return fetchMetadata(videoId).catch(() => null);
  }

  /** Title/type as shown in the player DOM (fallback when the API fails). */
  function readDomMetadata() {
    const heading = document.querySelector(
      ".video-title h4, .title-info-wrapper h4, .player-title h4",
    );
    if (!heading) return null;
    const subtitle = document.querySelector(
      ".video-title span, .title-info-wrapper span, .player-title span",
    );
    return {
      type: null,
      title: heading.textContent.trim(),
      year: null,
      seasonNumber: null,
      episodeNumber: null,
      episodeTitle: subtitle ? subtitle.textContent.trim() : null,
    };
  }

  globalThis.WatcharrNetflixMetadata = {
    getVideo,
    otherLanguages,
    findEpisode,
    ownEpisode,
    describeVideo,
    getMetadata,
    readDomMetadata,
  };
})();
