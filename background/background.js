/*
 * Watcharr Scrobbler – background script.
 *
 * Central place that stores the Watcharr connection (url + username + JWT token)
 * in `browser.storage.local` and routes messages from the content script,
 * the popup and the options page to the Watcharr API.
 */
"use strict";

const DEFAULT_SETTINGS = {
  watcharrUrl: "",
  username: "",
  token: "",
  plexClientId: "", // stable plex.tv OAuth client identifier
  enabled: true,
  threshold: 90, // % of a title watched before it counts as "finished"
  // "" = no explicit choice yet -> UIs resolve to the browser language.
  language: "",
  // Self-hosted Jellyfin server.
  // Stored normalized (origin + base path, no trailing slash); empty = the
  // Jellyfin service stays inactive.
  jellyfinUrl: "",
};

async function getSettings() {
  const data = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

async function saveSettings(settings) {
  await browser.storage.local.set({ settings });
}

/* ---------------------------------------------------------------------------
 * Jellyfin content script (dynamic registration)
 *
 * Jellyfin is self-hosted, so its URL cannot be listed in the manifest's
 * `content_scripts`. The content script is registered here for the configured
 * server (and re-registered whenever that server changes), plus injected into
 * already-open Jellyfin tabs so no reload is needed.
 * ------------------------------------------------------------------------ */
const JELLYFIN_SCRIPT_ID = "watcharr-jellyfin";

function sameStringList(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

async function registerJellyfinContentScript() {
  if (!browser.scripting || !browser.scripting.registerContentScripts) return;
  const svc = WatcharrServices.byId("jellyfin");
  const pattern = svc && svc.urlPattern;

  // Firefox event pages (and the Chrome service worker) re-run this on every
  // wake-up – so check the CURRENT registration first and only touch it when
  // the configured server actually changed.
  let current = null;
  try {
    const all = await browser.scripting.getRegisteredContentScripts();
    current = (all || []).find((s) => s && s.id === JELLYFIN_SCRIPT_ID) || null;
  } catch (_) {
    /* getRegisteredContentScripts unavailable – fall through and re-register */
  }

  const upToDate =
    current &&
    pattern &&
    sameStringList(current.matches, [pattern]) &&
    sameStringList(current.js, svc.contentScripts);
  if (upToDate) return;

  if (current) {
    try {
      await browser.scripting.unregisterContentScripts({
        ids: [JELLYFIN_SCRIPT_ID],
      });
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
        id: JELLYFIN_SCRIPT_ID,
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

/** Applies the stored settings to the service registry and keeps the
 *  dynamically registered Jellyfin content script in sync with them.
 *  Tabs that are ALREADY open are handled by the central service-tab watcher
 *  (background/service-tabs.js): it injects the content script of every
 *  service into every open service tab, so a Jellyfin (or Netflix/Prime) tab
 *  that predates the configured server / the extension load needs no reload.
 */
async function syncJellyfin() {
  WatcharrServices.applySettings(await getSettings());
  await registerJellyfinContentScript();
  await WatcharrServiceTabs.refresh();
}

/** Starts the central tab watcher and brings the Jellyfin registration (and
 *  the content scripts of already-open service tabs) up to date. Runs on every
 *  background start – Firefox event page and Chrome service-worker wake-up. */
function startServiceTracking() {
  WatcharrServiceTabs.start();
  syncJellyfin().catch((err) => {
    console.error("[watcharr-scrobbler] Jellyfin setup failed:", err);
  });
}

/** plex.tv OAuth flow in progress (pin awaiting authorization). */
let plexFlow = null;

/** Decode the `username`/`type` claims out of a Watcharr JWT (no validation). */
function decodeJwtClaims(token) {
  try {
    const b64 = String(token)
      .split(".")[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = decodeURIComponent(
      atob(padded)
        .split("")
        .map((ch) => "%" + ("00" + ch.charCodeAt(0).toString(16)).slice(-2))
        .join(""),
    );
    return JSON.parse(json) || {};
  } catch (_) {
    return {};
  }
}

/** RFC 4122 v4 UUID with a fallback for contexts without crypto.randomUUID. */
function uuid() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Build a client from stored settings and run `fn`.
 * Catches errors and turns them into a friendly response so callers (content
 * script / popup) always get `{ ok, data?, error?, errorCode?, authRequired? }`.
 */
async function withClient(fn) {
  const s = await getSettings();
  if (!s.watcharrUrl || !s.token) {
    return {
      ok: false,
      error: "Watcharr is not configured.",
      errorCode: "not_configured",
      authRequired: true,
    };
  }
  try {
    const data = await fn(new WatcharrClient(s));
    return { ok: true, data };
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

/** Normalizes a thrown background Error into a message response carrying the
 *  stable i18n code (see background/history.js / watcharr-client.js). */
function toErrorResponse(err) {
  return {
    ok: false,
    error: (err && err.message) || String(err),
    errorCode: (err && err.userCode) || null,
    errorParams: (err && err.userParams) || null,
  };
}

async function handleMessage(msg, sender) {
  switch (msg && msg.type) {
    case "watcharr:login": {
      const settings = await getSettings();
      settings.watcharrUrl = (msg.url || settings.watcharrUrl || "").trim();
      const client = new WatcharrClient(settings);
      const method = msg.method === "jellyfin" ? "jellyfin" : "";
      const token = await client.login(msg.username, msg.password, method);
      const claims = decodeJwtClaims(token);
      settings.username = claims.username || msg.username || "";
      settings.token = token;
      await saveSettings(settings);
      return { ok: true, username: settings.username };
    }

    // Which login methods has this server enabled? The UI shows only those
    // (plus the always-available Watcharr login).
    case "watcharr:auth:available": {
      const s = await getSettings();
      const url = (msg.url || s.watcharrUrl || "").trim();
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

    // Begin the Plex OAuth flow: create a plex.tv pin and return the popup URL.
    case "watcharr:plex:begin": {
      const s = await getSettings();
      s.watcharrUrl = (msg.url || s.watcharrUrl || "").trim();
      if (!s.watcharrUrl)
        return { ok: false, error: "Watcharr URL is not configured." };
      s.plexClientId = s.plexClientId || uuid();
      await saveSettings(s);
      const pin = await PlexTvAuth.createPin(s.plexClientId);
      plexFlow = { pinId: pin.id, pinCode: pin.code };
      return {
        ok: true,
        authUrl: PlexTvAuth.authUrl(s.plexClientId, pin.code),
        clientId: s.plexClientId,
      };
    }

    // Poll the plex.tv pin; `authToken` is set once the user approved it.
    case "watcharr:plex:poll": {
      if (!plexFlow)
        return {
          ok: false,
          error: "No active Plex login flow.",
          errorCode: "no_active_plex",
        };
      const s = await getSettings();
      const authToken = await PlexTvAuth.pollPin(
        s.plexClientId || "",
        plexFlow.pinId,
        plexFlow.pinCode,
      );
      if (authToken) {
        plexFlow = null; // consumed -> options finishes via watcharr:loginPlex
        return { ok: true, authToken };
      }
      return { ok: true, authToken: null };
    }

    // Finish Plex login: exchange the plex.tv token for a Watcharr JWT.
    case "watcharr:loginPlex": {
      const settings = await getSettings();
      settings.watcharrUrl = (msg.url || settings.watcharrUrl || "").trim();
      const client = new WatcharrClient(settings);
      const token = await client.loginPlex(
        msg.token,
        settings.plexClientId || "",
      );
      const claims = decodeJwtClaims(token);
      settings.username = claims.username || "";
      settings.token = token;
      await saveSettings(settings);
      plexFlow = null;
      return { ok: true, username: settings.username };
    }

    case "watcharr:getState": {
      const s = await getSettings();
      return {
        ok: true,
        settings: {
          watcharrUrl: s.watcharrUrl,
          username: s.username,
          enabled: s.enabled !== false,
          threshold: s.threshold || DEFAULT_SETTINGS.threshold,
          // "" = no explicit language -> caller falls back to browser language.
          language: s.language || "",
          jellyfinUrl: s.jellyfinUrl || "",
          configured: !!(s.watcharrUrl && s.token),
        },
      };
    }

    // -- Open service tabs (central watcher) -----------------------
    // The popup and the history page read their "which service is open?"
    // state from here instead of polling the tabs API themselves: the watcher
    // is event-driven (tabs.onCreated/onRemoved/onUpdated/onActivated) and
    // therefore notices a newly opened or closed service immediately.
    case "watcharr:serviceTabs:get":
      return { ok: true, ...WatcharrServiceTabs.getSnapshot() };

    case "watcharr:serviceTabs:refresh":
      return { ok: true, ...(await WatcharrServiceTabs.refresh()) };

    // What is playing in the focused service tab? Resolved through the
    // watcher, which also guarantees that the content script is running in
    // that tab (a plain tabs.sendMessage fails in tabs that were opened
    // before the extension was loaded).
    case "watcharr:getCurrentItem": {
      try {
        // Without an explicit service the FOCUSED one decides – and that has
        // to be resolved freshly: the cached snapshot may be up to one
        // debounce interval old (which is exactly the situation "tab just
        // opened / just switched to" this feature is about). When no service
        // tab is in front, the first OPEN one is used – a service tab in the
        // background is still scrobbling, so the popup reports it instead of
        // claiming that nothing is open.
        const snap = msg.service ? null : await WatcharrServiceTabs.refresh();
        const svcId = msg.service
          ? (WatcharrServices.byId(msg.service) || {}).id
          : snap.activeServiceId || snap.openServiceIds[0] || null;
        const svc = svcId ? WatcharrServices.byId(svcId) : null;
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
          // The tab was considered ready but did not answer (the content
          // script was unloaded, the page was replaced underneath us). Drop
          // the cached flag, inject again and try exactly once more.
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
        return toErrorResponse(err);
      }
    }

    case "watcharr:saveSettings": {
      const s = await getSettings();
      const next = { ...s };
      let jellyfinChanged = false;
      if (msg.settings) {
        if (typeof msg.settings.enabled === "boolean")
          next.enabled = msg.settings.enabled;
        if (
          typeof msg.settings.threshold === "number" &&
          msg.settings.threshold > 0 &&
          msg.settings.threshold <= 100
        ) {
          next.threshold = msg.settings.threshold;
        }
        if (["en", "de", "fr"].includes(msg.settings.language)) {
          next.language = msg.settings.language;
        }
        // Self-hosted Jellyfin server – stored normalized, so that a typo
        // like a trailing slash or a missing scheme cannot break matching.
        if (typeof msg.settings.jellyfinUrl === "string") {
          next.jellyfinUrl = WatcharrServices.normalizeServerUrl(
            msg.settings.jellyfinUrl,
          );
          jellyfinChanged = true;
        }
      }
      await saveSettings(next);
      if (jellyfinChanged) await syncJellyfin();
      // Echo the normalized Jellyfin URL back so the options page can show
      // exactly what is used for tab matching (and detect invalid input).
      return { ok: true, jellyfinUrl: next.jellyfinUrl || "" };
    }

    case "watcharr:logout": {
      const s = await getSettings();
      s.token = "";
      s.username = "";
      await saveSettings(s);
      return { ok: true };
    }

    case "watcharr:search":
      return withClient((c) =>
        c.search(msg.query || "", msg.searchType || "multi"),
      );

    case "watcharr:addWatched":
      return withClient((c) =>
        c.addWatched(
          msg.tmdbId,
          msg.contentType,
          msg.status || "WATCHING",
          msg.watchedDate,
        ),
      );

    case "watcharr:updateWatched":
      return withClient((c) => c.updateWatched(msg.id, msg.patch || {}));

    case "watcharr:addEpisode":
      return withClient((c) =>
        c.addWatchedEpisode(
          msg.watchedId,
          msg.seasonNumber,
          msg.episodeNumber,
          msg.status || "FINISHED",
          msg.watchedDate,
        ),
      );

    case "watcharr:addSeason":
      return withClient((c) =>
        c.addWatchedSeason(
          msg.watchedId,
          msg.seasonNumber,
          msg.status || "FINISHED",
        ),
      );

    // -- History page (Comparison Service ↔ Watcharr) ---------------
    case "watcharr:history:load":
      try {
        WatcharrHistory.setSource("service");
        WatcharrHistory.setService(msg.service);
        WatcharrHistory.setOldestFirst(msg.oldestFirst === true);
        const data = await WatcharrHistory.load();
        return {
          ok: true,
          items: data.items,
          total: data.total,
          done: data.done,
          cancelled: !!data.cancelled,
          source: data.source,
          file: data.file,
        };
      } catch (err) {
        return toErrorResponse(err);
      }

    case "watcharr:history:loadFile":
      // Import path: the list is filled from a previously exported CSV/JSON file
      // instead of the open service tab. Matching/selection/import are unchanged.
      try {
        WatcharrHistory.setOldestFirst(msg.oldestFirst === true);
        const data = await WatcharrHistory.loadFromFile(
          msg.text || "",
          msg.filename || "",
        );
        return {
          ok: true,
          items: data.items,
          total: data.total,
          done: data.done,
          cancelled: !!data.cancelled,
          source: data.source,
          file: data.file,
          fileTotal: data.fileTotal,
        };
      } catch (err) {
        return toErrorResponse(err);
      }

    case "watcharr:history:more":
      try {
        WatcharrHistory.setService(msg.service);
        WatcharrHistory.setOldestFirst(msg.oldestFirst === true);
        const data = await WatcharrHistory.more();
        return {
          ok: true,
          items: data.items,
          total: data.total,
          done: data.done,
          error: data.error || null,
          errorCode: data.errorCode || null,
        };
      } catch (err) {
        return toErrorResponse(err);
      }

    case "watcharr:history:rematch":
      try {
        const item = await WatcharrHistory.rematch(msg.key, msg.result);
        return { ok: true, item };
      } catch (err) {
        return toErrorResponse(err);
      }

    case "watcharr:history:import":
      try {
        const results = await WatcharrHistory.importItems(msg.keys || []);
        return { ok: true, results };
      } catch (err) {
        return toErrorResponse(err);
      }

    case "watcharr:history:export": {
      // Writes the COMPLETE history of the selected service to a file (done on
      // the history page) and optionally adds the TMDB data of every entry –
      // resolved through Watcharr's TMDB search. Nothing is written to
      // Watcharr itself: this is an export, not an import.
      try {
        WatcharrHistory.setService(msg.service);
        const data = await WatcharrHistory.collectForExport({
          enrich: msg.enrich === true,
        });
        return {
          ok: true,
          rows: data.rows,
          total: data.total,
          done: !!data.done,
          truncated: !!data.truncated,
          enriched: !!data.enriched,
          matched: data.matched || 0,
          cancelled: !!data.cancelled,
        };
      } catch (err) {
        return toErrorResponse(err);
      }
    }

    case "watcharr:history:cancel":
      // Abort a running "oldest first" full-history load / file export.
      WatcharrHistory.cancelHistoryLoad();
      return { ok: true };

    case "watcharr:history:progress":
      // Entries fetched so far while the "oldest first" full load or a file
      // export is running; `export` additionally reports the export phase.
      return {
        ok: true,
        loaded: WatcharrHistory.getLoadProgress(),
        export: WatcharrHistory.getExportProgress(),
      };

    // Amazon Prime Video history API calls. They are routed through the
    // background because the content script's own fetch is bound by the page's
    // CORS (the Amazon API hosts are cross-origin to primevideo.com and would
    // otherwise fail with "NetworkError"). The background fetch is not subject
    // to that CORS and – thanks to the <all_urls> host permission – sends the
    // user's Prime Video session cookies.
    case "watcharr:primevideo:api": {
      try {
        const resp = await fetch(msg.url || "", {
          method: "GET",
          credentials: "include",
          headers: { "x-requested-with": "XMLHttpRequest" },
        });
        if (!resp.ok) {
          return { ok: false, status: resp.status };
        }
        return { ok: true, text: await resp.text() };
      } catch (err) {
        const message = err.message || String(err);
        // A blocked request ("NetworkError") means the extension has no host
        // permission for that host. Logging which URL failed and which origins
        // are granted at all is the decisive information: the Prime Video API
        // is served from primevideo.com AND from the account's Amazon
        // marketplace (see WatcharrServices.apiPatterns).
        console.error(
          "[watcharr-scrobbler] Prime Video API request failed:",
          msg.url,
          "->",
          message,
        );
        if (/NetworkError|Network Error|Failed to fetch/i.test(message)) {
          try {
            const granted = await browser.permissions.getAll();
            console.error(
              "[watcharr-scrobbler] granted origins:",
              (granted.origins || []).join(", ") || "(none)",
            );
          } catch (_) {
            /* diagnostics only */
          }
          // Hand the blocked host back so the history page can ask for exactly
          // that origin on the next "Reload" click (see neededOrigins there).
          const blockedOrigin =
            typeof WatcharrServices !== "undefined"
              ? WatcharrServices.originPattern(msg.url)
              : "";
          return {
            ok: false,
            error: message,
            blockedOrigin: blockedOrigin || null,
          };
        }
        return { ok: false, error: message };
      }
    }

    default:
      return { ok: false, error: "Unknown message type: " + (msg && msg.type) };
  }
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error("[watcharr-scrobbler] background error:", err);
      sendResponse(toErrorResponse(err));
    });
  return true; // keep the message channel open for the async response
});

// Keep the service registry (Jellyfin server) and the dynamically registered
// Jellyfin content script in sync with the stored settings, and start the
// central service-tab watcher. Runs on every background start (Firefox event
// page / Chrome service-worker wake-up) – the watcher's listeners must be
// registered synchronously so that the very first tab event of a wake-up is
// not missed.
startServiceTracking();
