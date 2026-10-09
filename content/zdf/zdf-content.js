/*
 * ZDF Mediathek – scrobbler wiring.
 *
 * Connects the pieces: settings (content/shared/settings.js), playback and video
 * detection (zdf-playback.js), the shared scrobble decision
 * (content/shared/scrobbler.js) and the viewing history (zdf-history.js).
 *
 * Everything Watcharr-related goes through the background script, so the
 * Watcharr token never reaches this page. The ZDF tokens are only ever handed to
 * the background for ZDF's own API.
 */
"use strict";

(function () {
  // Idempotency guard: an already running content script (e.g. injected later
  // via browser.scripting) must not start twice.
  if (window.__watcharrZdfContentInstalled__) return;
  window.__watcharrZdfContentInstalled__ = true;

  const settings = WatcharrContentSettings.create();
  const items = new Map(); // canonical -> item state
  let currentKey = null;
  let ticking = false;

  function summary() {
    const item = currentKey ? items.get(currentKey) : null;
    return WatcharrContentSummary.build(
      item,
      item ? WatcharrZdfPlayback.readPlayback() : null,
      {
        videoId: currentKey,
        watchingAfterSeconds: WatcharrContentScrobbler.WATCHING_AFTER_SECONDS,
        threshold: settings.threshold,
      },
    );
  }

  /**
   * Metadata of one video, resolved once per item (the lookup itself caches).
   *
   * A `null` result is remembered as failed and never retried: ZDF answers with
   * nothing for everything that is not a playable video.
   */
  async function ensureMetadata(item, canonical) {
    if (item.metadata || item.metadataFailed || item.metadataLoading) return;
    item.metadataLoading = true;
    try {
      const description = await WatcharrZdfMetadata.lookupCanonical(canonical);
      item.description = description;
      item.metadata = WatcharrZdfMetadata.toItemMetadata(description);
      if (!item.metadata) item.metadataFailed = true;
    } finally {
      item.metadataLoading = false;
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (!settings.loaded) await settings.load();
      if (!settings.enabled || !settings.configured) return;

      const playback = WatcharrZdfPlayback.readPlayback();
      const canonical = WatcharrZdfPlayback.currentCanonical();

      // A single-page-app navigation briefly leaves the URL without a canonical
      // while the video keeps playing – keep the current item then instead of
      // resetting the state.
      let key = canonical;
      if (!key && currentKey && items.has(currentKey)) key = currentKey;

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

      await ensureMetadata(item, key);
      if (!item.metadata) return;

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
      WatcharrZdfHistory.fetchForUi(page, loadId),
  });

  // Let's go
  settings.load();
  tick();
})();
