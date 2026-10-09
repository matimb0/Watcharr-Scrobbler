/*
 * ARD Mediathek API messages.
 *
 * The content script needs two hosts that are not www.ardmediathek.de:
 *
 *   – api.ardmediathek.de       the public teaser metadata (series title,
 *                               season/episode, duration),
 *   – firestore.googleapis.com  the user's own play history
 *                               (mediathek/{uid}/lists/playhistory/items).
 *
 * Both are cross-origin to the page, so the requests run here (same pattern as
 * the Netflix and Prime Video proxies).
 *
 * Deliberately NOT a URL proxy like the other services: the two requests are
 * built HERE from validated parts. A message can therefore never turn this
 * into an open request proxy, and the Firestore query (collection path, order
 * and limit) is fixed by the extension instead of by the page.
 */
"use strict";

(function () {
  // Firebase project of the ARD Mediathek web app (page `#env` -> FIREBASE).
  const FIREBASE_PROJECT = "ardmt-prod";
  const FIRESTORE_BASE = "https://firestore.googleapis.com/v1/";
  // The public teaser route the ARD web app itself uses for one clip. The
  // "ard" partner works for every broadcaster's clip id (only the id decides).
  const TEASER_PREFIX =
    "https://api.ardmediathek.de/page-gateway/teasers/ard/items/";
  // Upper bound of one play-history read. The ARD web app shows at most this
  // many entries (`limit(240)` in its client bundle).
  const MAX_ENTRIES = 240;
  // Firebase uid / ARD clip id: opaque, but never a path or query separator.
  // A clip id is the base64url form of a `crid://…` urn, which always starts
  // with the same prefix.
  const UID_RE = /^[A-Za-z0-9_-]{4,128}$/;
  const CLIP_ID_RE = /^Y3JpZDov[A-Za-z0-9_-]{4,200}$/;

  /** Runs one request and reports status + body, never throwing. */
  async function requestText(url, init, what) {
    try {
      const resp = await fetch(url, init);
      const text = await resp.text();
      if (!resp.ok) return { ok: false, status: resp.status, text };
      return { ok: true, status: resp.status, text };
    } catch (err) {
      const message = err.message || String(err);
      // "NetworkError" means the extension has no host permission for the host;
      // both hosts are declared in the manifest, so this should not happen.
      console.error(
        "[watcharr-scrobbler] ARD request failed:",
        what,
        "->",
        message,
      );
      return { ok: false, error: message };
    }
  }

  /** Metadata of one clip. Public – needs no ARD session. */
  function teaser(msg) {
    const id = String(msg.id || "");
    if (!CLIP_ID_RE.test(id)) return { ok: false, error: "invalid clip id" };
    return requestText(
      TEASER_PREFIX + encodeURIComponent(id) + "?embedded=true",
      {
        method: "GET",
        // No ARD cookies for a public route – and never send them onward.
        credentials: "omit",
        headers: { Accept: "application/json" },
      },
      "teaser " + id,
    );
  }

  /**
   * The user's play history ("Weiterschauen"), newest first.
   *
   * The ID token comes from the ARD page's own Firebase session (see
   * content/ard/ard-session.js) and is passed through unchanged – exactly the
   * identity the page itself uses for this collection, so the Firestore rules
   * treat the request like the ARD web app.
   */
  function playHistory(msg) {
    const uid = String(msg.uid || "");
    const idToken = String(msg.idToken || "");
    if (!UID_RE.test(uid) || idToken.length < 20) {
      return { ok: false, error: "invalid ARD session" };
    }
    const parent =
      "projects/" +
      FIREBASE_PROJECT +
      "/databases/(default)/documents/mediathek/" +
      uid +
      "/lists/playhistory";
    const url = FIRESTORE_BASE + parent + ":runQuery";
    const body = {
      structuredQuery: {
        from: [{ collectionId: "items" }],
        orderBy: [
          { field: { fieldPath: "updatedOn" }, direction: "DESCENDING" },
        ],
        limit: MAX_ENTRIES,
      },
    };
    return requestText(
      url,
      {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + idToken,
        },
        body: JSON.stringify(body),
      },
      "play history",
    );
  }

  const HANDLERS = {
    "watcharr:ard:teaser": teaser,
    "watcharr:ard:playhistory": playHistory,
  };

  /** Handles the message, or returns undefined when it belongs to another module. */
  async function handle(msg) {
    const fn = msg && HANDLERS[msg.type];
    return fn ? fn(msg) : undefined;
  }

  globalThis.WatcharrMessageArd = { handle };
})();
