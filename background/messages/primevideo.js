/*
 * Prime Video history API messages.
 *
 * The content script's own fetch is bound by the page CORS, and the API hosts
 * (atv-ps.primevideo.com, atv-ps-<region>.primevideo.com) are cross-origin to
 * www.primevideo.com – so the request is routed through the background, which
 * is not subject to that CORS and sends the user's Prime Video session cookies.
 */
"use strict";

(function () {
  async function fetchApi(msg) {
    try {
      const resp = await fetch(msg.url || "", {
        method: "GET",
        credentials: "include",
        headers: { "x-requested-with": "XMLHttpRequest" },
      });
      if (!resp.ok) return { ok: false, status: resp.status };
      return { ok: true, text: await resp.text() };
    } catch (err) {
      const message = err.message || String(err);

      // "NetworkError" means the extension has no host permission for that host.
      // All Prime Video hosts are covered by the static `*://*.primevideo.com/*`
      // permission (see background/services.js), so this should not happen –
      // log the failing URL, because the history page can only offer a generic
      // "grant access via Reload" hint for it.
      console.error(
        "[watcharr-scrobbler] Prime Video API request failed:",
        msg.url,
        "->",
        message,
      );
      return { ok: false, error: message };
    }
  }

  const HANDLERS = { "watcharr:primevideo:api": fetchApi };

  /** Handles the message, or returns undefined when it belongs to another module. */
  async function handle(msg) {
    const fn = msg && HANDLERS[msg.type];
    return fn ? fn(msg) : undefined;
  }

  globalThis.WatcharrMessagePrimeVideo = { handle };
})();
