/*
 * ZDF Mediathek – video metadata.
 *
 * A ZDF video is identified by its `canonical` – the last segment of the page
 * URL (`/video/<category>/<collection>/<canonical>`). Everything else comes
 * from the GraphQL content API through the background
 * (see background/messages/zdf.js), which needs only the public app token.
 *
 * Three findings shape the mapping below (all verified against the live API):
 *
 *  1. A FILM is reported as `contentType: "EPISODE"` with an EMPTY
 *     `episodeInfo` – the only reliable marker is
 *     `smartCollection.collectionType === "MOVIE"`.
 *  2. A TRAILER/extra is `contentType: "CLIP"` with
 *     `currentMediaType: "TRAILER"`. Those carry no watchable episode and are
 *     flagged as `skippable`, so neither the live scrobbling nor the history
 *     turns them into an entry.
 *  3. The series title lives in `smartCollection.title`, the episode title in
 *     `title`.
 */
"use strict";

(function () {
  // /video/… is the detail page, /play/… the player page of the same video.
  const VIDEO_PATH_RE = /^\/(?:video|play)\//;
  const CANONICAL_RE = /^[a-z0-9][a-z0-9-]{1,140}$/;
  // Media types that are not a watch: previews of other videos and live TV.
  const SKIP_MEDIA_TYPES = new Set(["TRAILER", "LIVE"]);

  const cache = new Map(); // "canonical|value" -> Promise<description|null>

  /** The video's canonical from a ZDF page URL, or null. */
  function canonicalFromUrl(url) {
    let path;
    try {
      path = new URL(url).pathname;
    } catch (_) {
      return null;
    }
    // Only the detail and player routes are videos. The homepage, the section
    // pages and /live-tv must never scrobble – and the hover previews they play
    // are not on any of these routes anyway.
    if (!VIDEO_PATH_RE.test(path)) return null;
    const segments = path.split("/").filter(Boolean);
    const canonical = segments[segments.length - 1];
    return canonical && CANONICAL_RE.test(canonical) ? canonical : null;
  }

  /** Raw GraphQL answer for one video (through the background), or null. */
  async function fetchVideo(kind, value) {
    let apiToken;
    try {
      apiToken = WatcharrZdfSession.getApiToken();
    } catch (_) {
      return null;
    }
    let resp;
    try {
      resp = await browser.runtime.sendMessage({
        type: "watcharr:zdf:graphql",
        kind,
        value,
        apiToken,
      });
    } catch (_) {
      return null;
    }
    if (!resp || !resp.ok || !resp.text) return null;
    try {
      const parsed = JSON.parse(resp.text);
      const data = parsed && parsed.data;
      const video = (data && (data.videoByCanonical || data.videoById)) || null;
      return video && video.canonical ? video : null;
    } catch (_) {
      return null;
    }
  }

  /** Duration in seconds of the current media stream, or null. */
  function readDuration(video) {
    const nodes = (video.currentMedia && video.currentMedia.nodes) || [];
    for (const node of nodes) {
      const value = node && node.duration;
      if (typeof value === "number" && value > 0) return value;
    }
    return null;
  }

  /** A positive integer, or null. */
  function positiveInt(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /**
   * Normalizes a raw GraphQL video into the shape both the live scrobbling and
   * the history use:
   *   { kind, isTv, seriesTitle, clipTitle, episodeTitle, season, episode,
   *     year, duration, providerType, collectionType, channel, skippable }
   *
   * `kind` is "canonical" or "id" – which identifier the caller looked the
   * video up with (the history only has ids).
   */
  function describe(video, kind) {
    if (!video || !video.canonical) return null;
    const info = video.episodeInfo || {};
    const collection = video.smartCollection || {};
    const owner = video.contentOwner || {};
    const mediaType = String(video.currentMediaType || "");
    const contentType = String(video.contentType || "");

    // A film: ZDF marks it on the collection, NOT on the type (see file header).
    const isMovie = collection.collectionType === "MOVIE";
    const season = positiveInt(info.seasonNumber);
    const episode = positiveInt(info.episodeNumber);
    // Without a collection there is nothing that could carry a season/episode,
    // so such an entry is treated as a single video (a film).
    const isTv = !isMovie && !!collection.title;

    return {
      kind,
      value: kind === "id" ? video.id : video.canonical,
      id: video.id || null,
      canonical: video.canonical,
      isTv,
      seriesTitle: isTv ? collection.title : null,
      clipTitle: video.title || collection.title || "",
      episodeTitle:
        isTv && season != null && episode != null ? video.title : null,
      season: isTv ? season : null,
      episode: isTv ? episode : null,
      year: positiveInt(video.productionYear),
      duration: readDuration(video),
      providerType: contentType || null,
      collectionType: collection.collectionType || null,
      channel: owner.title || null,
      // A trailer/preview or a live stream is not something you "watch" in the
      // sense of the list – see the file header.
      skippable: SKIP_MEDIA_TYPES.has(mediaType) || contentType === "CLIP",
    };
  }

  /** Description of one video (cached, also caches failures). */
  function lookup(kind, value) {
    const key = kind + "|" + value;
    if (cache.has(key)) return cache.get(key);
    const pending = fetchVideo(kind, value).then((video) =>
      describe(video, kind),
    );
    cache.set(key, pending);
    return pending;
  }

  /** Description of a video referenced by its canonical. */
  function lookupCanonical(canonical) {
    if (!CANONICAL_RE.test(String(canonical || ""))) {
      return Promise.resolve(null);
    }
    return lookup("canonical", canonical);
  }

  /** Description of a video referenced by the id the history reports. */
  function lookupId(id) {
    if (!id) return Promise.resolve(null);
    return lookup("id", String(id));
  }

  /**
   * Description in the shape the shared scrobbler and the Watcharr matcher
   * expect (content/shared/watcharr.js → item.metadata).
   *
   * For a series the YEAR stays null: `productionYear` is the year of that
   * episode's production, and using it as the series year would filter the TMDB
   * search to a later season. For a film it is the real release year and helps
   * the search.
   */
  function toItemMetadata(desc) {
    if (!desc || desc.skippable) return null;
    if (desc.isTv) {
      return {
        type: "tv",
        title: desc.seriesTitle || desc.clipTitle,
        year: null,
        seasonNumber: desc.season,
        episodeNumber: desc.episode,
        episodeTitle: desc.episodeTitle,
      };
    }
    return {
      type: "movie",
      title: desc.clipTitle || desc.seriesTitle,
      year: desc.year,
      seasonNumber: null,
      episodeNumber: null,
      episodeTitle: null,
    };
  }

  globalThis.WatcharrZdfMetadata = {
    canonicalFromUrl,
    describe,
    lookupCanonical,
    lookupId,
    toItemMetadata,
  };
})();
