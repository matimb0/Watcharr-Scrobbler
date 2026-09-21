/*
 * Service registry (shared by background, popup and history page).
 *
 * Central list of all streaming services the extension can scrobble. The
 * per-service content scripts do the actual work (playback detection +
 * history); this file only describes each service so that the UI and the
 * background can find open tabs and (re-)inject the right content scripts.
 *
 * This file is loaded in three places:
 *   - background (manifest "background.scripts" / Chrome service-worker
 *     importScripts, before history.js & background.js),
 *   - popup / history / options pages (plain <script> tag).
 *
 * NOTE for the Chrome build (tools/build.mjs): "lib/browser-polyfill.min.js"
 * is prepended to every `contentScripts` array in this file, so that content
 * scripts that are injected on demand (into tabs that were already open)
 * also run the polyfill first. Firefox does not need the polyfill.
 *
 * Fixed domains (Netflix, Prime Video) are matched through the static
 * `urlTest` / `urlPattern` and listed in the manifest's `content_scripts`.
 * Jellyfin is self-hosted: its descriptors (`urlTest`, `urlPattern`,
 * `serverUrl`) are filled in at runtime from the configured server URL
 * (WatcharrServices.applySettings) and its content script is registered
 * dynamically in the background (browser.scripting.registerContentScripts).
 *
 * Service names are proper nouns and therefore identical in every locale.
 */
(function () {
  "use strict";

  const list = [
    {
      id: "netflix",
      name: "Netflix",
      // Matches a tab URL to decide whether this service is open in it.
      urlTest: /(^|\.)netflix\.com$/i,
      // Pattern used with browser.tabs.query({ url: … }).
      urlPattern: "*://*.netflix.com/*",
      // Content scripts to (re-)inject into a tab that was opened before the
      // extension was loaded (order matters – same as the manifest entry).
      contentScripts: [
        "content/netflix/netflix-inject.js",
        "content/netflix/netflix-content.js",
      ],
      hasHistory: true,
    },
    {
      id: "primevideo",
      name: "Amazon Prime Video",
      urlTest: /(^|\.)primevideo\.com$/i,
      urlPattern: "*://*.primevideo.com/*",
      contentScripts: ["content/primevideo/primevideo-content.js"],
      hasHistory: true,
    },
    {
      id: "jellyfin",
      name: "Jellyfin",
      // Jellyfin is SELF-HOSTED: there is no fixed domain to match, so the
      // server URL is configured by the user (Options) and applied at runtime
      // via WatcharrServices.applySettings({ jellyfinUrl }). Until a server is
      // configured `urlTest`/`urlPattern` stay null and the service is simply
      // invisible to tab detection.
      urlTest: null,
      urlPattern: null,
      serverUrl: "",
      contentScripts: ["content/jellyfin/jellyfin-content.js"],
      hasHistory: true,
      /** True when `url` belongs to the configured Jellyfin server (host AND
       *  base path – Jellyfin may run behind a reverse proxy sub-path). */
      matchesUrl(url) {
        if (!this.serverUrl || !url) return false;
        try {
          const u = new URL(url);
          const base = new URL(this.serverUrl);
          if (u.origin !== base.origin) return false;
          const bp = base.pathname.replace(/\/+$/, "");
          return (
            bp === "" || u.pathname === bp || u.pathname.startsWith(bp + "/")
          );
        } catch (_) {
          return false;
        }
      },
    },
  ];

  /** Returns the service descriptor for an id, or null. */
  function byId(id) {
    if (!id) return null;
    return list.find((s) => s.id === id) || null;
  }

  /** Extracts the hostname from a (tab) URL – used for service matching. */
  function host(url) {
    if (!url) return "";
    try {
      return new URL(url).hostname;
    } catch (_) {
      return String(url);
    }
  }

  /** Returns the service descriptor matching a tab URL, or null. */
  function byUrl(url) {
    if (!url) return null;
    const h = host(url);
    return (
      list.find((s) =>
        typeof s.matchesUrl === "function"
          ? s.matchesUrl(url)
          : s.urlTest && s.urlTest.test(h),
      ) || null
    );
  }

  /**
   * Normalizes a user-entered Jellyfin server URL to `origin + base path`
   * (no trailing slash). Returns "" for an empty or unusable value.
   * Examples: "192.168.1.10:8096" -> "http://192.168.1.10:8096",
   *           "https://jelly.example.com/jellyfin/" -> "https://jelly.example.com/jellyfin".
   */
  function normalizeServerUrl(raw) {
    let s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "http://" + s;
    let u;
    try {
      u = new URL(s);
    } catch (_) {
      return "";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (!u.hostname) return "";
    const path = u.pathname.replace(/\/+$/, "");
    return u.origin + path;
  }

  /** Sets the Jellyfin server used for tab matching (see above). */
  function setJellyfinServer(rawUrl) {
    const svc = byId("jellyfin");
    if (!svc) return;
    const base = normalizeServerUrl(rawUrl);
    svc.serverUrl = base;
    svc.urlPattern = base ? base + "/*" : null;
  }

  /** Applies the persisted settings to the in-memory service descriptors.
   *  Every context that uses WatcharrServices (background, popup, history
   *  page, options) calls this with the settings it just loaded. */
  function applySettings(settings) {
    setJellyfinServer(settings && settings.jellyfinUrl);
  }

  /** True when the service can be looked up in open tabs (has a URL pattern). */
  function hasTabPattern(svc) {
    return !!svc && typeof svc.urlPattern === "string" && svc.urlPattern !== "";
  }

  /** True when the service contributes to the history page. */
  function hasHistory(svc) {
    return !!svc && svc.hasHistory !== false && hasTabPattern(svc);
  }

  /**
   * Hosts whose pages the extension must be able to read.
   *
   * These are the fixed ones – they are declared in the manifest, so they are
   * requested at install time and normally granted right away.
   */
  const STATIC_HOSTS = [
    "*://*.netflix.com/*",
    // Prime Video is only supported through primevideo.com. The wildcard also
    // covers its API hosts (atv-ps.primevideo.com, atv-ps-<region>.primevideo.com).
    "*://*.primevideo.com/*",
    "*://*.plex.tv/*", // Plex login (plex.tv OAuth)
  ];

  /** Match-pattern for the origin of a full URL, or "" when there is none. */
  function originPattern(url) {
    try {
      const u = new URL(String(url || ""));
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.origin + "/*";
    } catch (_) {
      return "";
    }
  }

  /**
   * All origins the extension needs for the given settings, as match patterns:
   * the fixed service hosts, the configured Jellyfin server and the Watcharr
   * instance.
   *
   * Only `STATIC_HOSTS` are declared in the manifest – the other two are known
   * at runtime only (self-hosted server, the user's own Watcharr URL). Callers
   * therefore use this list both to check the current access and to ask for it
   * (browser.permissions.request).
   */
  function permissionOrigins(settings) {
    const origins = [...STATIC_HOSTS];
    // Configured services. The Jellyfin pattern is derived from the settings
    // right here instead of reading it from the descriptor: this function is
    // also called from contexts (settings page, history page) that hold the
    // settings but never applied them to the registry.
    const jellyfinBase = normalizeServerUrl(settings && settings.jellyfinUrl);
    for (const svc of list) {
      const pattern =
        svc.id === "jellyfin" && jellyfinBase
          ? jellyfinBase + "/*"
          : svc.urlPattern;
      if (
        typeof pattern === "string" &&
        pattern !== "" &&
        !origins.includes(pattern)
      ) {
        origins.push(pattern);
      }
    }
    const watcharr = originPattern(settings && settings.watcharrUrl);
    if (watcharr && !origins.includes(watcharr)) origins.push(watcharr);
    return origins;
  }

  const api = {
    list,
    byId,
    byUrl,
    host,
    applySettings,
    setJellyfinServer,
    normalizeServerUrl,
    hasTabPattern,
    hasHistory,
    originPattern,
    permissionOrigins,
    STATIC_HOSTS,
  };

  // Expose on whatever global object this file is loaded into (extension
  // page window, Firefox event page, Chrome service worker).
  const root =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof window !== "undefined"
        ? window
        : self;
  root.WatcharrServices = api;
})();
