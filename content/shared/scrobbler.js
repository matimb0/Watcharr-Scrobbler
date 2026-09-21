/*
 * The scrobble decision itself – identical for every service.
 *
 * The service content script only detects WHAT is playing (item + playback);
 * this module decides what that means for Watcharr. It runs once per poll tick
 * and is written to be safe to call repeatedly: every action is guarded by the
 * state flags on the item (see content/shared/watcharr.js → createItem).
 */
"use strict";

(function () {
  const POLL_INTERVAL_MS = 1500;

  // An item is only created as WATCHING after this much cumulative playback –
  // prevents briefly clicked videos (e.g. trailers) from cluttering the list.
  const WATCHING_AFTER_SECONDS = 300;

  const Api = globalThis.WatcharrContentApi;

  /**
   * Adds the seconds played since the last tick. Only a FORWARD-moving
   * position counts, which makes pausing/seeking harmless and does not rely on
   * the (per service, per version) unreliable playing/paused flags.
   */
  function trackPlaybackTime(item, playback) {
    if (
      playback &&
      playback.currentTime != null &&
      isFinite(playback.currentTime)
    ) {
      if (
        item.lastCurrentTime != null &&
        playback.currentTime > item.lastCurrentTime
      ) {
        item.watchedSeconds += playback.currentTime - item.lastCurrentTime;
      }
      item.lastCurrentTime = playback.currentTime;
    } else {
      item.lastCurrentTime = null;
    }
  }

  /**
   * Runs the shared decision for one item:
   *   0) accumulate playback time,
   *   1) resolve the TMDB id (service specific – `resolveTmdb(item)`),
   *   2) after WATCHING_AFTER_SECONDS: create the entry and/or set the specific
   *      episode to WATCHING (only while below the threshold),
   *   3) at/above the threshold: finish the movie / mark the episode watched.
   *
   * `item.metadata` must already be filled in by the caller.
   */
  async function runTick(ctx) {
    const { item, playback, settings, resolveTmdb } = ctx;

    trackPlaybackTime(item, playback);
    if (!item.metadata) return;

    if (!item.tmdb && !item.searching) {
      item.searching = true;
      try {
        await resolveTmdb(item);
      } finally {
        item.searching = false;
      }
    }
    if (!item.tmdb) return;

    // Step 2 – only after a while, and only below the threshold: an item that
    // is already done is marked finished in step 3 instead of being reset.
    if (item.watchedSeconds > WATCHING_AFTER_SECONDS) {
      const isTv = item.tmdb.contentType === "tv";
      if (!item.watchedId) {
        await Api.ensureWatched(item);
      } else if (playback && playback.progress < settings.threshold) {
        if (isTv) {
          const season = item.metadata.seasonNumber;
          const episode = item.metadata.episodeNumber;
          if (season != null && episode != null) {
            await Api.markEpisodeWatching(item, season, episode);
          }
        } else if (
          !item.movieFinished &&
          item.watchedStatus !== "WATCHING" &&
          !item.adding
        ) {
          await Api.markWatching(item);
        }
      }
    }

    if (!item.watchedId || !playback) return;

    // Step 3 – a reached threshold counts even while paused (e.g. stopped at
    // 95 %). Without a season/episode (e.g. Netflix collections) the entry
    // simply stays WATCHING.
    const atThreshold = playback.progress >= settings.threshold;
    if (item.tmdb.contentType === "movie") {
      if (!item.movieFinished && atThreshold) {
        await Api.markMovieFinished(item);
      }
      return;
    }
    const season = item.metadata.seasonNumber;
    const episode = item.metadata.episodeNumber;
    if (season != null && episode != null && atThreshold) {
      await Api.markEpisodeWatched(item, season, episode);
    }
  }

  globalThis.WatcharrContentScrobbler = {
    POLL_INTERVAL_MS,
    WATCHING_AFTER_SECONDS,
    trackPlaybackTime,
    runTick,
  };
})();
