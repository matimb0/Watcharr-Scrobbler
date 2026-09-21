/*
 * Playback helpers shared by the service content scripts.
 *
 * How a service FINDS its playback state differs (Netflix probes its player,
 * Prime Video and Jellyfin read the DOM or their API), but the resulting shape
 * is always
 *   { currentTime, duration, progress, isPaused, playing, ended? }
 * – and so is the seconds-vs-milliseconds guard.
 */
"use strict";

(function () {
  // A duration above this can only be milliseconds (100000 s ≈ 27.7 hours).
  const MS_GUARD = 100000;

  /**
   * Normalizes `currentTime`/`duration` to seconds when a service reports them
   * in milliseconds and fills in `progress` when it is missing. Returns the
   * input unchanged when it already is in seconds.
   */
  function normalizeUnits(pb) {
    if (!pb || typeof pb.duration !== "number" || pb.duration <= MS_GUARD) {
      return pb;
    }
    const currentTime =
      typeof pb.currentTime === "number"
        ? pb.currentTime / 1000
        : pb.currentTime;
    const duration = pb.duration / 1000;
    return Object.assign({}, pb, {
      currentTime,
      duration,
      progress:
        pb.progress != null
          ? pb.progress
          : duration > 0
            ? Math.min(100, (currentTime / duration) * 100)
            : 0,
    });
  }

  /** Playback state derived from a <video> element, or null when unusable. */
  function playbackFromVideo(video) {
    if (!video) return null;
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) return null;
    const currentTime = isFinite(video.currentTime) ? video.currentTime : 0;
    return {
      currentTime,
      duration,
      progress: Math.min(100, (currentTime / duration) * 100),
      isPaused: !!video.paused,
      playing: !video.paused && !video.ended,
      ended: !!video.ended,
      videoId: null,
    };
  }

  /** First <video> matching `selector` (default: any) with a usable duration. */
  function readVideo(selector) {
    const video =
      (selector ? document.querySelector(selector) : null) ||
      document.querySelector("video");
    if (!video) return null;
    if (!isFinite(video.duration) || video.duration <= 0) return null;
    return video;
  }

  /** Playback state of the page's <video> element (or null). */
  function readPlayback(selector) {
    return playbackFromVideo(readVideo(selector));
  }

  globalThis.WatcharrPlayback = {
    normalizeUnits,
    playbackFromVideo,
    readVideo,
    readPlayback,
  };
})();
