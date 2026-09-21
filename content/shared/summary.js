/*
 * Builds the payload the popup shows for "what is playing right now?".
 *
 * Every service content script answers the same question with the same field
 * names (see popup/popup.js), so the shape lives here instead of being
 * repeated – and kept in sync – in three files.
 */
"use strict";

(function () {
  /**
   * @param item      state of the playing item (content/shared/watcharr.js)
   * @param playback  playback state, or null when the page has no <video> yet
   * @param opts      { videoId, watchingAfterSeconds, threshold }
   */
  function build(item, playback, opts) {
    const o = opts || {};
    const meta = item && item.metadata;
    return {
      videoId: o.videoId != null ? o.videoId : null,
      title: item
        ? item.tmdb
          ? item.tmdb.name
          : meta
            ? meta.title
            : null
        : null,
      type: item
        ? item.tmdb
          ? item.tmdb.contentType
          : meta
            ? meta.type
            : null
        : null,
      seasonNumber: meta ? meta.seasonNumber : null,
      episodeNumber: meta ? meta.episodeNumber : null,
      episodeTitle: meta ? meta.episodeTitle : null,
      progress: playback ? Math.round(playback.progress) : null,
      isPaused: playback ? playback.isPaused : null,
      watchedStatus: item ? item.watchedStatus : null,
      movieFinished: item ? item.movieFinished : false,
      watchedSeconds: item ? Math.round(item.watchedSeconds) : null,
      watchingAfterSeconds:
        o.watchingAfterSeconds != null ? o.watchingAfterSeconds : null,
      threshold: o.threshold,
    };
  }

  globalThis.WatcharrContentSummary = { build };
})();
