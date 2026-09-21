/*
 * Jellyfin's content script cannot be declared in the manifest: the server is
 * self-hosted, so its URL is only known from the user's settings. It is
 * registered dynamically here and re-registered whenever that URL changes.
 *
 * Tabs that are ALREADY open are handled by the central tab watcher
 * (background/service-tabs.js), which injects the content script into every
 * open service tab – so such a tab needs no reload either.
 */
"use strict";

(function () {
  const SCRIPT_ID = "watcharr-jellyfin";

  function sameStringList(a, b) {
    const x = Array.isArray(a) ? a : [];
    const y = Array.isArray(b) ? b : [];
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }

  async function registerContentScript() {
    if (!browser.scripting || !browser.scripting.registerContentScripts) return;

    const svc = WatcharrServices.byId("jellyfin");
    const pattern = svc && svc.urlPattern;

    // This runs on every background wake-up, so check the current registration
    // first and only touch it when the configured server actually changed.
    let current = null;
    try {
      const all = await browser.scripting.getRegisteredContentScripts();
      current = (all || []).find((s) => s && s.id === SCRIPT_ID) || null;
    } catch (_) {
      /* not available – fall through and re-register */
    }

    const upToDate =
      current &&
      pattern &&
      sameStringList(current.matches, [pattern]) &&
      sameStringList(current.js, svc.contentScripts);
    if (upToDate) return;

    if (current) {
      try {
        await browser.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      } catch (err) {
        console.error(
          "[watcharr-scrobbler] Jellyfin content script could not be removed:",
          err,
        );
      }
    }
    if (!pattern) return;

    try {
      await browser.scripting.registerContentScripts([
        {
          id: SCRIPT_ID,
          matches: [pattern],
          js: svc.contentScripts,
          runAt: "document_idle",
        },
      ]);
      console.log(
        "[watcharr-scrobbler] Jellyfin content script registered for",
        pattern,
      );
    } catch (err) {
      console.error(
        "[watcharr-scrobbler] Jellyfin content script registration failed:",
        err,
      );
    }
  }

  /** Applies the stored settings to the service registry and keeps the Jellyfin
   *  registration (and the open service tabs) in sync with them. */
  async function sync() {
    WatcharrServices.applySettings(await WatcharrSettings.get());
    await registerContentScript();
    await WatcharrServiceTabs.refresh();
  }

  globalThis.WatcharrJellyfin = { sync };
})();
