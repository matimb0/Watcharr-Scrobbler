/*
 * ZDF Mediathek – playback and video detection.
 *
 * The ZDF player renders a plain HTML5 <video> inside `.zdfplayer-video-container`
 * (the Svelte-generated player of ngp.zdf.de). Playback therefore comes from the
 * element itself.
 *
 * Two things are worth knowing about the video elements:
 *
 *  – The detail page carries a SECOND <video> (`preview-video-…` inside a
 *    progress-bar container) that plays teaser loops while the user hovers the
 *    timeline. It must never be mistaken for playback.
 *  – Which video is playing is NOT read from the DOM: the player is a widget
 *    without stable text and the site is a single-page app. The canonical in the
 *    URL is unambiguous (see content/zdf/zdf-metadata.js).
 */
"use strict";

(function () {
  // The player's own canvas first; the fallbacks cover the embedded player and
  // older player builds.
  const VIDEO_SELECTORS = [
    ".zdfplayer-video-container video",
    ".zdfplayer-app video",
    ".zdfplayer video",
  ];
  const VIDEO_SELECTOR = VIDEO_SELECTORS.join(", ");
  // Containers of decorative videos (hover previews) that are not playback.
  const IGNORED_ANCESTOR_SELECTOR =
    '[class*="preview-video"],[class*="progress-bar-container"],[class*="start-screen"]';

  /** True when `video` belongs to a hover preview / decorative player. */
  function isDecorative(video) {
    if (!video) return false;
    if (video.closest(IGNORED_ANCESTOR_SELECTOR)) return true;
    const cls = typeof video.className === "string" ? video.className : "";
    return /preview-video|hidden-/.test(cls);
  }

  /** The player's <video> element, or null. */
  function readVideoElement() {
    for (const video of document.querySelectorAll(VIDEO_SELECTOR)) {
      if (!isDecorative(video)) return video;
    }
    return null;
  }

  /** True while a player <video> exists, even before its duration is known. */
  function videoElementExists() {
    return !!readVideoElement();
  }

  /** Playback state of the player, normalized to seconds (or null). */
  function readPlayback() {
    return WatcharrPlayback.normalizeUnits(
      WatcharrPlayback.playbackFromVideo(readVideoElement()),
    );
  }

  /** Canonical of the video the page is showing, or null. */
  function currentCanonical() {
    return WatcharrZdfMetadata.canonicalFromUrl(location.href);
  }

  globalThis.WatcharrZdfPlayback = {
    videoElementExists,
    readPlayback,
    currentCanonical,
  };
})();
