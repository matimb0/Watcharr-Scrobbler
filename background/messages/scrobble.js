/*
 * Scrobble messages: what is playing in the open service tabs, plus the
 * Watcharr calls the content scripts and the popup make while watching.
 */
"use strict";

(function () {
  /**
   * Builds a client from the stored settings and runs `fn`. Errors become a
   * friendly response, so callers always get
   * `{ ok, data?, error?, errorCode?, authRequired? }`.
   */
  async function withClient(fn) {
    const settings = await WatcharrSettings.get();
    if (!settings.watcharrUrl || !settings.token) {
      return {
        ok: false,
        error: "Watcharr is not configured.",
        errorCode: "not_configured",
        authRequired: true,
      };
    }
    try {
      return { ok: true, data: await fn(new WatcharrClient(settings)) };
    } catch (err) {
      return {
        ok: false,
        error: err.message || String(err),
        errorCode: (err && err.userCode) || null,
        errorParams: (err && err.userParams) || null,
        authRequired: !!err.authRequired,
      };
    }
  }

  /**
   * What is playing in the focused service tab? Resolved through the central
   * watcher, which also guarantees that a content script runs in that tab (a
   * plain tabs.sendMessage fails in tabs opened before the extension).
   */
  async function getCurrentItem(msg) {
    try {
      // Without an explicit service the FOCUSED one decides – resolved freshly,
      // because the cached snapshot may be one debounce interval old. Without a
      // focused service tab the first OPEN one is used: a background service tab
      // is still scrobbling.
      const snapshot = msg.service ? null : await WatcharrServiceTabs.refresh();
      const serviceId = msg.service
        ? (WatcharrServices.byId(msg.service) || {}).id
        : snapshot.activeServiceId || snapshot.openServiceIds[0] || null;
      const svc = serviceId ? WatcharrServices.byId(serviceId) : null;
      if (!svc) return { ok: false, error: "no_service" };

      const tabId = await WatcharrServiceTabs.findServiceTab(svc.id);
      if (tabId == null) {
        return {
          ok: false,
          error: "no_service_tab",
          service: { id: svc.id, name: svc.name },
        };
      }

      let item;
      try {
        item = await browser.tabs.sendMessage(tabId, {
          type: "watcharr:getCurrentItem",
        });
      } catch (err) {
        // The tab was considered ready but did not answer (the content script
        // was unloaded, the page was replaced underneath us). Drop the cached
        // flag, inject again and try exactly once more.
        WatcharrServiceTabs.forgetTab(tabId);
        const retryId = await WatcharrServiceTabs.findServiceTab(svc.id);
        if (retryId == null) throw err;
        item = await browser.tabs.sendMessage(retryId, {
          type: "watcharr:getCurrentItem",
        });
      }

      return {
        ok: true,
        service: { id: svc.id, name: svc.name },
        item: item || null,
      };
    } catch (err) {
      return WatcharrErrors.toResponse(err);
    }
  }

  const HANDLERS = {
    // -- Open service tabs (central watcher) --------------------------------
    // The popup and the history page read their "which service is open?" state
    // from here instead of polling the tabs API themselves – the watcher is
    // event-driven and therefore always current.
    "watcharr:serviceTabs:get": () => ({
      ok: true,
      ...WatcharrServiceTabs.getSnapshot(),
    }),

    "watcharr:serviceTabs:refresh": async () => ({
      ok: true,
      ...(await WatcharrServiceTabs.refresh()),
    }),

    "watcharr:getCurrentItem": getCurrentItem,

    // -- Watcharr calls from the content scripts / popup --------------------
    "watcharr:search": (msg) =>
      withClient((c) => c.search(msg.query || "", msg.searchType || "multi")),

    "watcharr:addWatched": (msg) =>
      withClient((c) =>
        c.addWatched(
          msg.tmdbId,
          msg.contentType,
          msg.status || "WATCHING",
          msg.watchedDate,
        ),
      ),

    "watcharr:updateWatched": (msg) =>
      withClient((c) => c.updateWatched(msg.id, msg.patch || {})),

    "watcharr:addEpisode": (msg) =>
      withClient((c) =>
        c.addWatchedEpisode(
          msg.watchedId,
          msg.seasonNumber,
          msg.episodeNumber,
          msg.status || "FINISHED",
          msg.watchedDate,
        ),
      ),

    "watcharr:addSeason": (msg) =>
      withClient((c) =>
        c.addWatchedSeason(
          msg.watchedId,
          msg.seasonNumber,
          msg.status || "FINISHED",
        ),
      ),
  };

  /** Handles the message, or returns undefined when it belongs to another module. */
  async function handle(msg) {
    const fn = msg && HANDLERS[msg.type];
    return fn ? fn(msg) : undefined;
  }

  globalThis.WatcharrMessageScrobble = { handle };
})();
