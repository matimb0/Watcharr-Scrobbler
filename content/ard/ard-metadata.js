/*
 * ARD Mediathek – clip metadata.
 *
 * One ARD clip is identified by its `clipId` (the last segment of a
 * `/video/…` URL, a base64 encoded `crid://…` urn). Everything else – series,
 * episode, duration, channel – comes from the public teaser route of the page
 * gateway, which the ARD web app itself uses for a single clip.
 *
 * The request runs through the background (see background/messages/ard.js);
 * the answer is cached per clip id, because the live scrobbling asks for the
 * same clip on every poll tick.
 *
 * ARD titles episodes as "<episode title> (S01/E10)" – there is no separate
 * season/episode field. That suffix is parsed here; a series whose episodes
 * carry no such suffix (most magazines, e.g. "tagesschau") is reported as a
 * series WITHOUT season/episode, which keeps the shared scrobbler from marking
 * an arbitrary episode.
 */
"use strict";

(function () {
  // Season/episode marker ARD appends to an episode title: "(S01/E10)".
  const EPISODE_MARKER_RE = /\s*\(\s*S(\d+)\s*\/\s*E(\d+)\s*\)\s*$/i;

  const cache = new Map(); // clip id -> Promise<description|null>

  /**
   * Decodes a clip id: base64url of a `crid://…` urn, without padding (it is a
   * URL path segment). Returns "" when it is not such an id.
   */
  function decodeClipId(id) {
    if (typeof id !== "string" || !/^Y3JpZDov[A-Za-z0-9_-]+$/.test(id)) {
      return "";
    }
    try {
      // The page base64url-encodes the urn ("-" and "_" instead of "+" and
      // "/") and drops the padding, `atob` wants neither.
      const base64 = id.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      const decoded = atob(padded);
      return decoded.startsWith("crid://") ? decoded : "";
    } catch (_) {
      return "";
    }
  }

  /** True when `id` looks like an ARD clip id (base64 `crid://…` urn). */
  function isClipId(id) {
    return decodeClipId(id) !== "";
  }

  /** The clip id of an ARD player URL, or null. */
  function clipIdFromUrl(url) {
    let path;
    try {
      path = new URL(url).pathname;
    } catch (_) {
      return null;
    }
    // Only /video/… is a player page. The homepage, the live stream and the
    // editorial pages play previews in a <video> as well – those must never
    // scrobble.
    const segments = path.split("/").filter(Boolean);
    if (segments.indexOf("video") < 0) return null;
    const id = segments[segments.length - 1];
    return isClipId(id) ? id : null;
  }

  /** Raw teaser of one clip (through the background), or null. */
  async function fetchTeaser(id) {
    let resp;
    try {
      resp = await browser.runtime.sendMessage({
        type: "watcharr:ard:teaser",
        id,
      });
    } catch (_) {
      return null;
    }
    if (!resp || !resp.ok || !resp.text) return null;
    try {
      return JSON.parse(resp.text);
    } catch (_) {
      return null;
    }
  }

  /** Removes a trailing "(S01/E10)" from an episode title. */
  function stripEpisodeMarker(title) {
    return String(title || "")
      .replace(EPISODE_MARKER_RE, "")
      .trim();
  }

  /** Season/episode numbers of an episode title, or null. */
  function parseEpisodeMarker(title) {
    const match = String(title || "").match(EPISODE_MARKER_RE);
    if (!match) return null;
    return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
  }

  /**
   * Normalizes a raw teaser into the shape both the live scrobbling and the
   * history use:
   *   { id, isTv, seriesTitle, clipTitle, episodeTitle, season, episode,
   *     duration, providerType, channel }
   */
  function describe(teaser) {
    if (!teaser || !teaser.id) return null;
    const show = teaser.show || {};
    const rawTitle =
      teaser.mediumTitle || teaser.longTitle || teaser.shortTitle || "";
    // The marker sits on the long/medium title only.
    const marked = teaser.longTitle || teaser.mediumTitle || rawTitle;
    const numbers = parseEpisodeMarker(marked);
    const isTv = teaser.coreAssetType === "EPISODE" && !!show.title;
    const service = teaser.publicationService || {};

    return {
      id: teaser.id,
      isTv,
      seriesTitle: isTv ? show.title : null,
      clipTitle: rawTitle,
      episodeTitle: numbers ? stripEpisodeMarker(marked) : null,
      season: numbers ? numbers.season : null,
      episode: numbers ? numbers.episode : null,
      duration:
        typeof teaser.duration === "number" && teaser.duration > 0
          ? teaser.duration
          : null,
      providerType: teaser.coreAssetType || null,
      channel: service.name || null,
    };
  }

  /** Description of one clip id (cached, also caches failures). */
  function lookup(id) {
    if (!isClipId(id)) return Promise.resolve(null);
    if (cache.has(id)) return cache.get(id);
    const pending = fetchTeaser(id).then((teaser) => describe(teaser));
    cache.set(id, pending);
    return pending;
  }

  /**
   * Description of a clip in the shape the shared scrobbler and the Watcharr
   * matcher expect (content/shared/watcharr.js -> item.metadata).
   *
   * The release year stays null: ARD reports a BROADCAST date, and using it as
   * the release year would filter the TMDB search to the wrong year for every
   * older film that happens to be on air again.
   */
  function toItemMetadata(desc) {
    if (!desc) return null;
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
      title: desc.clipTitle,
      year: null,
      seasonNumber: null,
      episodeNumber: null,
      episodeTitle: null,
    };
  }

  globalThis.WatcharrArdMetadata = {
    decodeClipId,
    isClipId,
    clipIdFromUrl,
    describe,
    lookup,
    toItemMetadata,
  };
})();
