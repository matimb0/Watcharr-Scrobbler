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
   * Error response of a TMDB-backed call. The codes are the ones the history
   * page knows (see background/tmdb.js); a TMDB problem is not an auth problem
   * of Watcharr.
   */
  function tmdbError(err) {
    return {
      ok: false,
      error: err.message || String(err),
      errorCode: (err && err.userCode) || null,
      tmdbStatus: (err && err.tmdbStatus) || null,
    };
  }

  /**
   * Title search for the content scripts, the popup and the history page.
   *
   * It runs against TMDB DIRECTLY (see background/tmdb.js) – Watcharr would
   * only proxy the same TMDB call with a hardcoded English language – and adds
   * what TMDB cannot know: whether a result is already on the user's Watcharr
   * list (that is what keeps an import from creating a duplicate, and it is the
   * tie-break when several same-titled entries exist).
   *
   * The answer keeps Watcharr's search shape (`{ ok, data: { results } }`), so
   * every caller works unchanged.
   */
  async function searchTitles(query, searchType) {
    try {
      const results = await WatcharrHistoryMatcher.searchOnline(
        query,
        searchType,
      );
      return { ok: true, data: { results } };
    } catch (err) {
      return tmdbError(err);
    }
  }

  /**
   * TMDB match of ONE title – the resolution the live scrobbling uses. It goes
   * through exactly the same code path as the history rows, which means the
   * PERSISTENT match cache sits in front of TMDB (background/match-cache.js):
   * a title that was matched once – automatically, or corrected by hand on the
   * history page – is answered without a TMDB request, and the user's correction
   * applies to the live scrobbling as well.
   *
   * `msg.mediaType` is the medium the service reported ("movie"/"tv"); anything
   * else is treated as a series, whose search also falls back to a "multi"
   * search.
   */
  async function resolveTitle(msg) {
    try {
      const match = await WatcharrHistoryMatcher.matchTitle(
        msg.title || "",
        msg.year || null,
        msg.mediaType !== "movie",
      );
      return { ok: true, data: { match } };
    } catch (err) {
      return tmdbError(err);
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
      searchTitles(msg.query || "", msg.searchType || "multi"),

    // One title -> one match (persistent cache first, see resolveTitle).
    "watcharr:resolve": resolveTitle,

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
