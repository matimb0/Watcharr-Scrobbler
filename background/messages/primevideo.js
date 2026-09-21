/*
 * Prime Video history API messages.
 *
 * The content script's own fetch is bound by the page CORS, and the Amazon API
 * hosts are cross-origin to primevideo.com – so the request is routed through
 * the background, which is not subject to that CORS and sends the user's Prime
 * Video session cookies.
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
      // Logging the failing URL and the granted origins is the decisive
      // information: the Prime Video API is served from primevideo.com AND from
      // the account's Amazon marketplace (see WatcharrServices.apiPatterns).
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
        // that origin on the next "Reload" click.
        return {
          ok: false,
          error: message,
          blockedOrigin: WatcharrServices.originPattern(msg.url) || null,
        };
      }
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
