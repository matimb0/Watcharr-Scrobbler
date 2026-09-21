/*
 * Messages about the Watcharr connection: login (Watcharr / Jellyfin / Plex),
 * the stored settings and the login providers the server reports.
 */
"use strict";

(function () {
  const { decodeJwtClaims, uuid } = globalThis.WatcharrUtil;

  /** plex.tv OAuth flow in progress (pin awaiting the user's approval). */
  let plexFlow = null;

  async function login(msg) {
    const settings = await WatcharrSettings.get();
    settings.watcharrUrl = (msg.url || settings.watcharrUrl || "").trim();
    const client = new WatcharrClient(settings);
    const method = msg.method === "jellyfin" ? "jellyfin" : "";
    const token = await client.login(msg.username, msg.password, method);
    settings.username = decodeJwtClaims(token).username || msg.username || "";
    settings.token = token;
    await WatcharrSettings.save(settings);
    return { ok: true, username: settings.username };
  }

  /** Which login methods has this server enabled? The options page shows only
   *  those (plus the always-available Watcharr login). */
  async function availableAuth(msg) {
    const settings = await WatcharrSettings.get();
    const url = (msg.url || settings.watcharrUrl || "").trim();
    if (!url) return { ok: false, error: "Watcharr URL is not configured." };

    const data = await new WatcharrClient({
      watcharrUrl: url,
    }).getAvailableAuth();
    return {
      ok: true,
      available: Array.isArray(data.available) ? data.available : [],
      useEmby: !!data.useEmby,
    };
  }

  /** Begins the Plex OAuth flow: create a plex.tv pin and return the popup URL. */
  async function beginPlex(msg) {
    const settings = await WatcharrSettings.get();
    settings.watcharrUrl = (msg.url || settings.watcharrUrl || "").trim();
    if (!settings.watcharrUrl) {
      return { ok: false, error: "Watcharr URL is not configured." };
    }
    settings.plexClientId = settings.plexClientId || uuid();
    await WatcharrSettings.save(settings);

    const pin = await PlexTvAuth.createPin(settings.plexClientId);
    plexFlow = { pinId: pin.id, pinCode: pin.code };
    return {
      ok: true,
      authUrl: PlexTvAuth.authUrl(settings.plexClientId, pin.code),
      clientId: settings.plexClientId,
    };
  }

  /** Polls the plex.tv pin; `authToken` is set once the user approved it. */
  async function pollPlex() {
    if (!plexFlow) {
      return {
        ok: false,
        error: "No active Plex login flow.",
        errorCode: "no_active_plex",
      };
    }
    const settings = await WatcharrSettings.get();
    const authToken = await PlexTvAuth.pollPin(
      settings.plexClientId || "",
      plexFlow.pinId,
      plexFlow.pinCode,
    );
    if (authToken) {
      plexFlow = null; // consumed -> options finishes via watcharr:loginPlex
      return { ok: true, authToken };
    }
    return { ok: true, authToken: null };
  }

  /** Finishes the Plex login: exchange the plex.tv token for a Watcharr JWT. */
  async function loginPlex(msg) {
    const settings = await WatcharrSettings.get();
    settings.watcharrUrl = (msg.url || settings.watcharrUrl || "").trim();
    const client = new WatcharrClient(settings);
    const token = await client.loginPlex(
      msg.token,
      settings.plexClientId || "",
    );
    settings.username = decodeJwtClaims(token).username || "";
    settings.token = token;
    await WatcharrSettings.save(settings);
    plexFlow = null;
    return { ok: true, username: settings.username };
  }

  /** What the popup, the options page and the content scripts work with. */
  async function getState() {
    const s = await WatcharrSettings.get();
    return {
      ok: true,
      settings: {
        watcharrUrl: s.watcharrUrl,
        username: s.username,
        enabled: s.enabled !== false,
        threshold: s.threshold || WatcharrSettings.DEFAULTS.threshold,
        language: s.language || "", // "" = caller uses the browser language
        jellyfinUrl: s.jellyfinUrl || "",
        configured: !!(s.watcharrUrl && s.token),
      },
    };
  }

  async function saveSettings(msg) {
    const next = { ...(await WatcharrSettings.get()) };
    let jellyfinChanged = false;

    if (msg.settings) {
      if (typeof msg.settings.enabled === "boolean") {
        next.enabled = msg.settings.enabled;
      }
      if (
        typeof msg.settings.threshold === "number" &&
        msg.settings.threshold > 0 &&
        msg.settings.threshold <= 100
      ) {
        next.threshold = msg.settings.threshold;
      }
      if (["en", "de", "fr", "es"].includes(msg.settings.language)) {
        next.language = msg.settings.language;
      }
      // Self-hosted Jellyfin server – stored normalized, so a typo like a
      // trailing slash or a missing scheme cannot break tab matching.
      if (typeof msg.settings.jellyfinUrl === "string") {
        next.jellyfinUrl = WatcharrServices.normalizeServerUrl(
          msg.settings.jellyfinUrl,
        );
        jellyfinChanged = true;
      }
    }

    await WatcharrSettings.save(next);
    if (jellyfinChanged) await WatcharrJellyfin.sync();

    // Echo the normalized Jellyfin URL back so the options page can show what is
    // used for tab matching (and detect invalid input).
    return { ok: true, jellyfinUrl: next.jellyfinUrl || "" };
  }

  async function logout() {
    const settings = await WatcharrSettings.get();
    settings.token = "";
    settings.username = "";
    await WatcharrSettings.save(settings);
    return { ok: true };
  }

  const HANDLERS = {
    "watcharr:login": login,
    "watcharr:auth:available": availableAuth,
    "watcharr:plex:begin": beginPlex,
    "watcharr:plex:poll": pollPlex,
    "watcharr:loginPlex": loginPlex,
    "watcharr:getState": getState,
    "watcharr:saveSettings": saveSettings,
    "watcharr:logout": logout,
  };

  /** Handles the message, or returns undefined when it belongs to another module. */
  async function handle(msg) {
    const fn = msg && HANDLERS[msg.type];
    return fn ? fn(msg) : undefined;
  }

  globalThis.WatcharrMessageSettings = { handle };
})();
