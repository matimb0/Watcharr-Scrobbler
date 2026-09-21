/*
 * Netflix – injection script (content script, isolated world).
 *
 * Netflix exposes no DOM selectors for the running player, so a small "probe"
 * file (content/netflix/netflix-probe.js) is loaded as an external <script src>
 * into the page's MAIN world. The probe reads Netflix' internal player state
 * and reports it back via CustomEvent.
 *
 * The probe must be a real file, not inline text: Netflix' CSP forbids inline
 * scripts (no 'unsafe-inline'), but it allows the extension's own origin, so an
 * external <script src> from the extension passes. The file is declared in
 * web_accessible_resources.
 */
"use strict";

(function () {
  const PROBE_ID = "watcharr-netflix-probe";
  const PROBE_SRC = browser.runtime.getURL("content/netflix/netflix-probe.js");

  function inject() {
    if (document.getElementById(PROBE_ID)) return;
    const script = document.createElement("script");
    script.id = PROBE_ID;
    script.src = PROBE_SRC;
    (document.head || document.documentElement).appendChild(script);
  }

  // Netflix is an SPA – the Content Script may run before DOMContentLoaded.
  if (document.documentElement) {
    inject();
  } else {
    document.addEventListener("DOMContentLoaded", inject, { once: true });
  }
})();
