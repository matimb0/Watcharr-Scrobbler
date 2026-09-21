/*
 * Amazon Prime Video – scrobbler wiring.
 *
 * Connects the pieces: settings (content/shared/settings.js), playback/item
 * detection (primevideo-playback.js), the shared scrobble decision
 * (content/shared/scrobbler.js) and the history API (primevideo-history.js).
 *
 * Everything Watcharr-related goes through the background script, so the token
 * never reaches this page.
 */
"use strict";

(function () {
  // Idempotency guard: an already running content script (e.g. injected later
  // via browser.scripting) must not start twice.
  if (window.__watcharrPrimeContentInstalled__) return;
  window.__watcharrPrimeContentInstalled__ = true;

  const settings = WatcharrContentSettings.create();
  const items = new Map(); // identity -> item state
  let currentKey = null;
  let ticking = false;

  function summary() {
    const item = currentKey ? items.get(currentKey) : null;
    return WatcharrContentSummary.build(
      item,
      item ? WatcharrPrimePlayback.readPlayback() : null,
      {
        videoId: currentKey,
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

      const playback = WatcharrPrimePlayback.readPlayback();
      const meta = WatcharrPrimePlayback.readItem();

      // The player UI may hide its title overlay (or the video sits between two
      // loads with a not-yet-finite duration) while the same video keeps
      // playing – keep the current item then instead of resetting the state.
      let key = meta ? WatcharrContentUtil.identityKey(meta) : null;
      if (
        !key &&
        currentKey &&
        items.has(currentKey) &&
        (playback || WatcharrPrimePlayback.videoElementExists())
      ) {
        key = currentKey;
      }

      if (!key) {
        if (items.size) items.clear(); // nothing is playing any more
        currentKey = null;
        return;
      }
      currentKey = key;

      let item = items.get(key);
      if (!item) {
        item = WatcharrContentApi.createItem(key);
        items.set(key, item);
      }
      if (meta && !item.metadata) item.metadata = meta;
      if (!item.metadata && !item.metadataFailed) {
        item.metadata = WatcharrPrimePlayback.readItem();
        if (!item.metadata) item.metadataFailed = true;
      }

      await WatcharrContentScrobbler.runTick({
        item,
        playback,
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
    fetchHistoryPage: (page, loadId) =>
      WatcharrPrimeHistory.fetchForUi(page, loadId),
  });

  // Let's go
  settings.load();
  tick();
})();
