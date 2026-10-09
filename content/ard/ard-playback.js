/*
 * ARD Mediathek – playback and clip detection.
 *
 * The ARD player renders a plain HTML5 <video> (`.ardplayer-mediacanvas`
 * inside `.ardplayer`), so the playback state comes from the element itself.
 *
 * Which clip is playing is NOT read from the DOM: the player's title overlay
 * is hidden most of the time, and the page is a single-page app whose DOM
 * keeps the elements of the previous route around for a moment. The clip id
 * from the URL is unambiguous – see content/ard/ard-metadata.js.
 */
"use strict";

(function () {
  // The player's own canvas; the fallbacks cover the player markup of older
  // builds and the embedded player.
  const VIDEO_SELECTORS = [
    "video.ardplayer-mediacanvas",
    ".ardplayer video",
    "video",
  ];

  /** True while a player <video> exists, even before its duration is known. */
  function videoElementExists() {
    return !!readVideoElement();
  }

  /** The player's <video> element, or null. */
  function readVideoElement() {
    for (const selector of VIDEO_SELECTORS) {
      const video = document.querySelector(selector);
      if (video) return video;
    }
    return null;
  }

  /** Playback state of the player, normalized to seconds (or null). */
  function readPlayback() {
    return WatcharrPlayback.normalizeUnits(
      WatcharrPlayback.playbackFromVideo(readVideoElement()),
    );
  }

  /** Clip id of the page that is open right now, or null. */
  function currentClipId() {
    return WatcharrArdMetadata.clipIdFromUrl(location.href);
  }

  globalThis.WatcharrArdPlayback = {
    videoElementExists,
    readPlayback,
    currentClipId,
  };
})();
