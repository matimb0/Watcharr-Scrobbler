/*
 * The extension's persisted settings (browser.storage.local) and the defaults
 * every context starts from.
 */
"use strict";

(function () {
  const DEFAULTS = {
    watcharrUrl: "",
    username: "",
    token: "",
    plexClientId: "", // stable plex.tv OAuth client identifier
    enabled: true,
    threshold: 90, // % watched before a title counts as "finished"
    language: "", // "" = no explicit choice -> use the browser language
    jellyfinUrl: "", // self-hosted server, normalized; "" = service inactive
  };

  /** Current settings with the defaults filled in. */
  async function get() {
    const data = await browser.storage.local.get("settings");
    return { ...DEFAULTS, ...(data.settings || {}) };
  }

  /** Writes the complete settings object back. */
  async function save(settings) {
    await browser.storage.local.set({ settings });
  }

  globalThis.WatcharrSettings = { DEFAULTS, get, save };
})();
