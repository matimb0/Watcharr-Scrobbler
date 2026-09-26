/*
 * Netflix member web API messages.
 *
 * The Netflix page content script asks its own origin, which *should* work –
 * but Netflix' `/nq/website/memberapi/...` routes answer 401 to requests that
 * do not come from the extension context (they are the routes the official
 * apps use). Routing the request through the background, exactly like
 * Universal Trakt Scrobbler does, makes them work: the background is not bound
 * by the page, sends the same Netflix session cookies (host permission) and is
 * not affected by the page's CSP.
 *
 * Only the extension's own metadata routes are proxied – the URL is whitelisted
 * so this cannot become an open request proxy.
 */
"use strict";

(function () {
  const ALLOWED_PREFIXES = [
    "https://www.netflix.com/nq/website/memberapi/",
    "https://www.netflix.com/api/shakti/",
  ];

  /** True when `url` is one of the member API routes we proxy. */
  function isAllowed(url) {
    return (
      typeof url === "string" &&
      ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))
    );
  }

  async function fetchApi(msg) {
    const url = msg.url || "";
    if (!isAllowed(url)) {
      return { ok: false, error: "URL not allowed: " + url };
    }
    try {
      // Netflix answers the member API in JSON when asked for it, and 302s an
      // unauthenticated request to the login page – the status is reported
      // as-is so the caller can tell "not logged in" from "route moved".
      const resp = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        redirect: "follow",
      });
      const text = await resp.text();
      if (!resp.ok) {
        return { ok: false, status: resp.status, text };
      }
      return { ok: true, status: resp.status, text };
    } catch (err) {
      const message = err.message || String(err);
      // "NetworkError" means the extension has no host permission for the host.
      // netflix.com is requested in the manifest, so this should not happen.
      console.error(
        "[watcharr-scrobbler] Netflix API request failed:",
        url,
        "->",
        message,
      );
      return { ok: false, error: message };
    }
  }

  const HANDLERS = { "watcharr:netflix:api": fetchApi };

  /** Handles the message, or returns undefined when it belongs to another module. */
  async function handle(msg) {
    const fn = msg && HANDLERS[msg.type];
    return fn ? fn(msg) : undefined;
  }

  globalThis.WatcharrMessageNetflix = { handle };
})();
