/*
 * Service registry (shared by background, popup, options and history page).
 *
 * Describes every streaming service the extension supports. The actual work
 * (playback detection + history) lives in the per-service content scripts;
 * this file only says how to recognise a service in a tab and which content
 * scripts belong to it.
 *
 * Loaded via manifest "background.scripts" (background), via
 * importScripts (Chrome service worker) and via <script> (extension pages).
 *
 * Chrome build (tools/build.mjs): lib/browser-polyfill.min.js is prepended to
 * every `contentScripts` array, so on-demand injections run the polyfill too.
 * Firefox does not need it.
 *
 * Netflix/Prime Video have fixed domains (`urlTest`/`urlPattern`). Jellyfin is
 * self-hosted, so its `serverUrl`/`urlPattern` are filled in at runtime by
 * `applySettings()`.
 *
 * Service names are proper nouns and identical in every locale.
 */
(function () {
  "use strict";

  // Loaded into every service page BEFORE the service's own scripts: shared
  // helpers, the settings store, the Watcharr actions and the scrobble decision
  // (see content/shared/). The manifest lists the very same files in the same
  // order – keep both in sync.
  const SHARED_CONTENT_SCRIPTS = [
    "content/shared/util.js",
    "content/shared/playback.js",
    "content/shared/settings.js",
    "content/shared/watcharr.js",
    "content/shared/scrobbler.js",
    "content/shared/summary.js",
    "content/shared/messaging.js",
  ];

  const list = [
    {
      id: "netflix",
      name: "Netflix",
      urlTest: /(^|\.)netflix\.com$/i, // tab URL -> is this service open?
      urlPattern: "*://*.netflix.com/*", // for browser.tabs.query({ url })
      // Order matters – must match the manifest entry.
      contentScripts: [
        ...SHARED_CONTENT_SCRIPTS,
        "content/netflix/netflix-inject.js",
        "content/netflix/netflix-playback.js",
        "content/netflix/netflix-metadata.js",
        "content/netflix/netflix-history.js",
        "content/netflix/netflix-content.js",
      ],
      hasHistory: true,
    },
    {
      id: "primevideo",
      name: "Prime Video",
      urlTest: /(^|\.)primevideo\.com$/i,
      urlPattern: "*://*.primevideo.com/*",
      // The history and its metadata are fetched exclusively from
      // primevideo.com (both atv-ps.primevideo.com and atv-ps-<region>.
      // primevideo.com are covered by the pattern above), so the account's
      // Amazon marketplace is neither requested nor needed – see
      // content/primevideo/primevideo-history.js for why.
      contentScripts: [
        ...SHARED_CONTENT_SCRIPTS,
        "content/primevideo/primevideo-playback.js",
        "content/primevideo/primevideo-history.js",
        "content/primevideo/primevideo-content.js",
      ],
      hasHistory: true,
    },
    {
      id: "jellyfin",
      name: "Jellyfin",
      // Self-hosted: no fixed domain. `serverUrl`/`urlPattern` are set from the
      // user's settings via applySettings(); until then the service is
      // invisible to tab detection.
      urlTest: null,
      urlPattern: null,
      serverUrl: "",
      contentScripts: [
        ...SHARED_CONTENT_SCRIPTS,
        "content/jellyfin/jellyfin-auth.js",
        "content/jellyfin/jellyfin-playback.js",
        "content/jellyfin/jellyfin-items.js",
        "content/jellyfin/jellyfin-history.js",
        "content/jellyfin/jellyfin-content.js",
      ],
      hasHistory: true,
      /** True when `url` belongs to the configured server (host AND base path –
       *  Jellyfin may run behind a reverse-proxy sub-path). */
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
   * Normalizes a user-entered Jellyfin URL to `origin + base path` without a
   * trailing slash. Returns "" for an empty or unusable value.
   *   "192.168.1.10:8096"            -> "http://192.168.1.10:8096"
   *   "https://jelly.example.com/jf/" -> "https://jelly.example.com/jf"
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

  /** Applies persisted settings to the in-memory descriptors. Called by every
   *  context that loaded settings (background, popup, history, options). */
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
   * Hosts the extension always needs. They are declared in the manifest, so
   * they are granted at install time.
   */
  const STATIC_HOSTS = [
    "*://*.netflix.com/*",
    // primevideo.com also covers the Prime Video API hosts
    // (atv-ps.primevideo.com, atv-ps-<region>.primevideo.com).
    "*://*.primevideo.com/*",
    // TMDB's website: episode names in the user's language. Needed because
    // Watcharr asks TMDB with a hardcoded language (en-US), while the services
    // report localized episode titles (see background/tmdb-site.js).
    "*://*.themoviedb.org/*",
    "*://*.plex.tv/*", // Plex login (plex.tv OAuth)
  ];

  /** Match pattern for the origin of a URL ("https://host/*"), or "". */
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
   * Match patterns for the pages of a SINGLE service (empty when it has none
   * yet, e.g. an unconfigured Jellyfin server).
   *
   * The Jellyfin pattern is derived from `settings` here instead of the
   * descriptor: callers like the options page hold the settings but never
   * applied them to the registry.
   */
  function patterns(svc, settings) {
    if (!svc) return [];
    const jellyfinBase = normalizeServerUrl(settings && settings.jellyfinUrl);
    const pattern =
      svc.id === "jellyfin" && jellyfinBase
        ? jellyfinBase + "/*"
        : svc.urlPattern;
    return typeof pattern === "string" && pattern !== "" ? [pattern] : [];
  }

  /**
   * All origins the extension needs for `settings`, as match patterns: the
   * fixed service hosts, the configured Jellyfin server and the Watcharr
   * instance.
   *
   * Callers use this both to check current access and to request it
   * (browser.permissions.request); only STATIC_HOSTS are in the manifest.
   *
   * `serviceIds` narrows the list down to those services (the Watcharr
   * instance stays in). The history page uses that because the browser grants
   * all requested permissions or none – a single foreign origin would
   * otherwise block the whole request.
   */
  function permissionOrigins(settings, serviceIds) {
    const only =
      Array.isArray(serviceIds) && serviceIds.length
        ? new Set(serviceIds)
        : null;
    const origins = [];
    const add = (pattern) => {
      if (
        typeof pattern === "string" &&
        pattern !== "" &&
        !origins.includes(pattern)
      ) {
        origins.push(pattern);
      }
    };
    // The fixed hosts are always needed, no matter which service is loaded
    // (e.g. TMDB's website for episode names, see background/tmdb-site.js) –
    // `only` therefore restricts the SERVICE patterns, not these.
    STATIC_HOSTS.forEach(add);
    for (const svc of list) {
      if (only && !only.has(svc.id)) continue;
      patterns(svc, settings).forEach(add);
    }
    add(originPattern(settings && settings.watcharrUrl));
    return origins;
  }

  /**
   * Version of the content-script protocol. Bump it whenever the content
   * scripts change in a way that matters (new message fields, new endpoints).
   *
   * Firefox keeps the content script of an already-open tab when the extension
   * is updated – that tab would keep running the OLD code (and silently produce
   * old results) until the page is reloaded manually. Every tab is therefore
   * pinged and re-injected when it does not report this version. Keep in sync
   * with CONTENT_SCRIPT_VERSION in content/shared/messaging.js.
   */
  const CONTENT_SCRIPT_VERSION = 2;

  /** True when a `watcharr:ping` answer came from this build's content script. */
  function isCurrentContent(ping) {
    return !!ping && ping.version === CONTENT_SCRIPT_VERSION;
  }

  const api = {
    list,
    byId,
    byUrl,
    applySettings,
    normalizeServerUrl,
    hasTabPattern,
    hasHistory,
    originPattern,
    permissionOrigins,
    CONTENT_SCRIPT_VERSION,
    isCurrentContent,
  };

  globalThis.WatcharrServices = api;
})();
