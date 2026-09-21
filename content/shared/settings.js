/*
 * Settings store shared by the service content scripts.
 *
 * The values live in the background (`watcharr:getState`); the content script
 * keeps a local copy so the poll tick can read them synchronously. A change in
 * the popup or the options page is picked up through `browser.storage.onChanged`
 * without reloading the page.
 */
"use strict";

(function () {
  const DEFAULT_THRESHOLD = 90;

  /**
   * Creates the store. The returned object IS the live settings object with
   * two methods attached, so call sites read naturally:
   *   store.loaded / store.enabled / store.threshold
   *   store.load()                 – fetch the current values
   *   store.apply(newSettings)     – adopt values pushed by storage events
   */
  function create() {
    const settings = {
      loaded: false,
      enabled: true,
      configured: false,
      threshold: DEFAULT_THRESHOLD,

      apply(s) {
        if (!s) return;
        settings.enabled = s.enabled !== false;
        settings.threshold =
          typeof s.threshold === "number" &&
          s.threshold > 0 &&
          s.threshold <= 100
            ? s.threshold
            : DEFAULT_THRESHOLD;
        settings.configured =
          typeof s.configured === "boolean"
            ? s.configured
            : !!(s.watcharrUrl && s.token);
        settings.loaded = true;
      },

      async load() {
        try {
          const resp = await browser.runtime.sendMessage({
            type: "watcharr:getState",
          });
          if (resp && resp.ok) settings.apply(resp.settings);
        } catch (_) {
          settings.loaded = true;
          settings.configured = false;
        }
      },
    };

    try {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.settings) {
          settings.apply(changes.settings.newValue);
        }
      });
    } catch (_) {
      /* storage events unavailable – the poll tick loads them instead */
    }

    return settings;
  }

  globalThis.WatcharrContentSettings = { create, DEFAULT_THRESHOLD };
})();
