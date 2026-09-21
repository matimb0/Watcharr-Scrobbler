/*
 * Netflix – scrobbler wiring.
 *
 * Connects the pieces: settings (content/shared/settings.js), playback
 * detection (netflix-playback.js), metadata (netflix-metadata.js), the shared
 * scrobble decision (content/shared/scrobbler.js) and the history API
 * (netflix-history.js).
 *
 * Everything Watcharr-related goes through the background script, so the token
 * never reaches this page.
 */
"use strict";

(function () {
  // Idempotency guard: an already running content script (e.g. injected later
  // via browser.scripting) must not start twice – that would double-scrobble
  // and register duplicate message listeners.
  if (window.__watcharrContentInstalled__) return;
  window.__watcharrContentInstalled__ = true;

  const settings = WatcharrContentSettings.create();
  const items = new Map(); // Netflix video id -> item state
  let ticking = false;

  /** Playback info of the given video, normalized to seconds. */
  function currentPlayback(videoId) {
    return WatcharrPlayback.normalizeUnits(
      WatcharrNetflixPlayback.pickPlayback(videoId),
    );
  }

  function summary() {
    const videoId = WatcharrNetflixPlayback.getVideoId();
    const item = videoId ? items.get(videoId) : null;
    return WatcharrContentSummary.build(
      item,
      item ? currentPlayback(videoId) : null,
      {
        videoId,
        watchingAfterSeconds: WatcharrContentScrobbler.WATCHING_AFTER_SECONDS,
        threshold: settings.threshold,
      },
    );
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (!settings.loaded) await settings.load();
      if (!settings.enabled || !settings.configured) return;

      const videoId = WatcharrNetflixPlayback.getVideoId();
      if (!videoId) {
        if (items.size) items.clear(); // left the /watch/ page
        return;
      }

      let item = items.get(videoId);
      if (!item) {
        item = WatcharrContentApi.createItem(videoId);
        items.set(videoId, item);
      }

      // Metadata is service specific and has to be there before the shared
      // decision runs.
      if (!item.metadata && !item.metadataFailed) {
        item.metadata = await WatcharrNetflixMetadata.getMetadata(videoId);
        if (!item.metadata) {
          item.metadata = WatcharrNetflixMetadata.readDomMetadata();
        }
        if (!item.metadata) item.metadataFailed = true;
      }

      await WatcharrContentScrobbler.runTick({
        item,
        playback: currentPlayback(videoId),
        settings,
        resolveTmdb: WatcharrContentApi.resolveTmdb,
      });
    } finally {
      ticking = false;
    }
  }

  setInterval(tick, WatcharrContentScrobbler.POLL_INTERVAL_MS);

  WatcharrContentMessaging.listen({
    getSummary: summary,
    fetchHistoryPage: (page) => WatcharrNetflixHistory.fetchForUi(page),
  });

  // Let's go
  settings.load();
  tick();
})();
