/*
 * Amazon Prime Video – playback and item detection.
 *
 * Unlike Netflix, Prime Video uses a plain HTML5 <video> element and shows the
 * running item ("Season 1, Ep. 4 …") in the player UI, so everything can be
 * read from the DOM (mirrors the Amazon Prime implementation of Universal
 * Trakt Scrobbler).
 */
"use strict";

(function () {
  const PLAYER_VIDEO_SELECTOR =
    ".dv-player-fullscreen video:not(.tst-video-overlay-player-html5)";
  const TITLE_SELECTOR = ".atvwebplayersdk-title-text";
  const SUBTITLE_SELECTOR = ".atvwebplayersdk-subtitle-text";
  // "Season 1, Ep. 4 The Ghouls" / "Staffel 1, Folge 4 …" (German accounts)
  const EPISODE_RE =
    /(?:Season|Staffel)\s+(\d+),?\s*(?:Ep\.?|Episode|Folge)\s*(\d+)\s*(.*)/i;

  /** True while a player <video> exists, even before its duration is known. */
  function videoElementExists() {
    return !!(
      document.querySelector(PLAYER_VIDEO_SELECTOR) ||
      document.querySelector("video")
    );
  }

  /** Playback state of the player, normalized to seconds (or null). */
  function readPlayback() {
    return WatcharrPlayback.normalizeUnits(
      WatcharrPlayback.readPlayback(PLAYER_VIDEO_SELECTOR),
    );
  }

  /**
   * Item currently shown in the player UI:
   *   title    -> series/movie title,
   *   subtitle -> "Season 1, Ep. 4 The Ghouls" (series) or empty (movie).
   * Returns null while no player item is shown (homepage, trailer preview).
   */
  function readItem() {
    const video = WatcharrPlayback.readVideo(PLAYER_VIDEO_SELECTOR);
    const player = video && video.closest('[id^="dv-web-player"]');
    const scope = player || document;

    const titleEl = scope.querySelector(TITLE_SELECTOR);
    const title = titleEl ? (titleEl.textContent || "").trim() : "";
    if (!title) return null;

    const subtitleEl = scope.querySelector(SUBTITLE_SELECTOR);
    const subtitle = subtitleEl ? (subtitleEl.textContent || "").trim() : "";
    const episode = subtitle.match(EPISODE_RE);

    if (episode) {
      return {
        type: "tv",
        title,
        year: null,
        seasonNumber: parseInt(episode[1], 10),
        episodeNumber: parseInt(episode[2], 10),
        episodeTitle: (episode[3] || "").trim(),
      };
    }
    return {
      type: "movie",
      title,
      year: null,
      seasonNumber: null,
      episodeNumber: null,
      episodeTitle: null,
    };
  }

  globalThis.WatcharrPrimePlayback = {
    videoElementExists,
    readPlayback,
    readItem,
  };
})();
