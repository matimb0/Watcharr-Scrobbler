/*
 * Netflix – metadata of the playing video (movie or series, title,
 * season/episode).
 *
 * Primary source is Netflix' own metadata endpoint. When that is blocked the
 * title shown in the player DOM is used as fallback, with the season/episode
 * then coming from the /watch/ URL and the metadata API of the history crawl.
 */
"use strict";

(function () {
  const metadataCache = new Map(); // videoId -> Promise<metadata|null>

  async function fetchMetadata(videoId) {
    try {
      const url =
        "https://www.netflix.com/nq/website/memberapi/release/metadata?languages=en-US&movieid=" +
        encodeURIComponent(videoId);
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) return null;
      const data = await resp.json();
      const video = data && data.video;
      if (!video || !video.title) return null;

      const meta = {
        type:
          video.type === "movie"
            ? "movie"
            : video.type === "show"
              ? "tv"
              : null,
        title: video.title,
        year: video.year || null,
        seasonNumber: null,
        episodeNumber: null,
        episodeTitle: null,
      };

      if (meta.type === "tv") {
        // Find the playing episode in the show's episode list.
        const seasons = Array.isArray(video.seasons) ? video.seasons : [];
        outer: for (const season of seasons) {
          const episodes = Array.isArray(season.episodes)
            ? season.episodes
            : [];
          for (const ep of episodes) {
            if (String(ep.id) === String(videoId)) {
              meta.seasonNumber =
                typeof season.seq === "number" ? season.seq : null;
              meta.episodeNumber = typeof ep.seq === "number" ? ep.seq : null;
              meta.episodeTitle = ep.title || null;
              break outer;
            }
          }
        }
        // Fallback: the episode Netflix itself reports as current.
        if (meta.seasonNumber == null && video.currentEpisode) {
          const current = video.currentEpisode;
          meta.seasonNumber =
            current.season && typeof current.season.seq === "number"
              ? current.season.seq
              : typeof current.seq === "number"
                ? current.seq
                : null;
          meta.episodeNumber =
            typeof current.seq === "number" ? current.seq : null;
          meta.episodeTitle = current.title || null;
        }
      }
      return meta;
    } catch (_) {
      return null;
    }
  }

  /** Metadata for a Netflix video id, fetched once per id. */
  function getMetadata(videoId) {
    let pending = metadataCache.get(videoId);
    if (!pending) {
      pending = fetchMetadata(videoId).catch(() => null);
      metadataCache.set(videoId, pending);
    }
    return pending;
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

  globalThis.WatcharrNetflixMetadata = { getMetadata, readDomMetadata };
})();
