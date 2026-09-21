/*
 * Jellyfin – scrobbler wiring.
 *
 * Connects the pieces: settings (content/shared/settings.js), login/auth
 * (jellyfin-auth.js), what is playing (jellyfin-playback.js), the metadata
 * mapping (jellyfin-items.js), the shared scrobble decision
 * (content/shared/scrobbler.js) and the history API (jellyfin-history.js).
 *
 * Only playback of this web client is scrobbled – playback on other devices
 * (TV app, phone, …) cannot be observed from here.
 *
 * Everything Watcharr-related goes through the background script, so the token
 * never reaches this page.
 */
"use strict";

(function () {
  // Idempotency guard: an already running content script (e.g. injected later
  // via browser.scripting) must not start twice.
  if (window.__watcharrJellyfinContentInstalled__) return;
  window.__watcharrJellyfinContentInstalled__ = true;

  const settings = WatcharrContentSettings.create();
  const items = new Map(); // identity -> item state
  let currentKey = null;
  let ticking = false;
  let sessionErrorLogged = false;

  /** Nothing of this service is playing any more. */
  function resetItems() {
    if (items.size) items.clear();
    currentKey = null;
    WatcharrJellyfinPlayback.resetSession();
  }

  function summary() {
    const item = currentKey ? items.get(currentKey) : null;
    return WatcharrContentSummary.build(
      item,
      item ? WatcharrJellyfinPlayback.readPlayback() : null,
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

      let session = null;
      try {
        session = await WatcharrJellyfinPlayback.getNowPlaying();
      } catch (err) {
        // Log once instead of on every tick – a missing login is the normal
        // state until the user signs in to Jellyfin.
        if (!sessionErrorLogged) {
          sessionErrorLogged = true;
          console.warn(
            "[watcharr-scrobbler] Jellyfin session lookup failed:",
            err.message || String(err),
          );
        }
        return;
      }
      sessionErrorLogged = false;

      const meta = session
        ? WatcharrJellyfinItems.mapNowPlaying(session.NowPlayingItem)
        : null;
      if (!meta) {
        resetItems();
        return;
      }

      const key = WatcharrContentUtil.identityKey(meta);
      currentKey = key;

      let item = items.get(key);
      if (!item) {
        item = WatcharrContentApi.createItem(key);
        items.set(key, item);
      }
      if (!item.metadata) item.metadata = meta;

      await WatcharrContentScrobbler.runTick({
        item,
        playback: WatcharrJellyfinPlayback.resolvePlayback(session),
        settings,
        resolveTmdb: WatcharrJellyfinItems.resolveTmdb,
      });
    } finally {
      ticking = false;
    }
  }

  setInterval(tick, WatcharrContentScrobbler.POLL_INTERVAL_MS);

  WatcharrContentMessaging.listen({
    getSummary: summary,
    fetchHistoryPage: (page) => WatcharrJellyfinHistory.fetchForUi(page),
  });

  // Let's go
  settings.load();
  tick();
})();
