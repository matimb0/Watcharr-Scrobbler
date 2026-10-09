/*
 * ARD Mediathek – scrobbler wiring.
 *
 * Connects the pieces: settings (content/shared/settings.js), playback and clip
 * detection (ard-playback.js), the shared scrobble decision
 * (content/shared/scrobbler.js) and the play history (ard-history.js).
 *
 * Everything Watcharr-related goes through the background script, so the
 * Watcharr token never reaches this page. The ARD session (ID token) is only
 * ever handed to the background for the ARD's own play-history collection.
 */
"use strict";

(function () {
  // Idempotency guard: an already running content script (e.g. injected later
  // via browser.scripting) must not start twice.
  if (window.__watcharrArdContentInstalled__) return;
  window.__watcharrArdContentInstalled__ = true;

  const settings = WatcharrContentSettings.create();
  const items = new Map(); // clip id -> item state
  let currentKey = null;
  let ticking = false;

  function summary() {
    const item = currentKey ? items.get(currentKey) : null;
    return WatcharrContentSummary.build(
      item,
      item ? WatcharrArdPlayback.readPlayback() : null,
      {
        videoId: currentKey,
        watchingAfterSeconds: WatcharrContentScrobbler.WATCHING_AFTER_SECONDS,
        threshold: settings.threshold,
      },
    );
  }

  /** Metadata of one clip, resolved once per item (the lookup itself caches). */
  async function ensureMetadata(item, clipId) {
    if (item.metadata || item.metadataFailed || item.metadataLoading) return;
    item.metadataLoading = true;
    try {
      const description = await WatcharrArdMetadata.lookup(clipId);
      item.metadata = WatcharrArdMetadata.toItemMetadata(description);
      // A clip whose metadata cannot be read is never retried – ARD answers
      // 404 for everything that is not a playable clip.
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

      const playback = WatcharrArdPlayback.readPlayback();
      const clipId = WatcharrArdPlayback.currentClipId();

      // A single-page-app navigation briefly leaves the URL without a clip id
      // while the video keeps playing – keep the current item then instead of
      // resetting the state.
      let key = clipId;
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
      WatcharrArdHistory.fetchForUi(page, loadId),
  });

  // Let's go
  settings.load();
  tick();
})();
