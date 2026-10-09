/*
 * ZDF Mediathek API messages.
 *
 * The content script needs two ZDF hosts that are cross-origin to the page, so
 * the requests run here (same pattern as the Netflix, Prime Video and ARD
 * proxies):
 *
 *   – api.zdf.de/graphql      clip metadata (title, series, season/episode)
 *   – api.zdf.de/usage-data   the user's own play history ("Weiterschauen")
 *
 * Deliberately NOT a URL proxy: the request is built HERE from validated
 * parts. A message can never turn this into an open request proxy, and the
 * GraphQL query is fixed by the extension instead of being passed in.
 *
 * Authentication uses two different tokens, both read from the ZDF page itself
 * (see content/zdf/zdf-session.js):
 *
 *   api-auth      the app token, server-rendered into the page, rotates daily
 *   Authorization the user's session token, from the page's localStorage
 */
"use strict";

(function () {
  const GRAPHQL_URL = "https://api.zdf.de/graphql";
  // The content aggregator app id of the ZDF web app (page client config,
  // `contentAggregator.appId`). It decides the shape of the answer, so it is
  // fixed here.
  const APP_ID = "ffw-mt-web-6ff6250f";
  const USAGE_DATA_URL = "https://api.zdf.de/usage-data";
  // The account endpoint of the ZDF web app (`apiUrls.identityService`), used to
  // resolve the account id the play-history route needs.
  const IDENTITY_URL = "https://api.zdf.de/identity";
  // The history the ZDF web app itself loads (`limit(100)` in its client).
  const HISTORY_LIMIT = 100;

  // --- validation -----------------------------------------------------------
  // The API tokens are opaque base64url-ish strings (40 chars today), but only
  // the shape is relied on – never their value.
  const TOKEN_RE = /^[A-Za-z0-9_.-]{20,200}$/;
  // Firebase-like user id of the ZDF account.
  const USER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
  // ZDF canonical: lower-case slug with a numeric suffix ("next-bite-100").
  const CANONICAL_RE = /^[a-z0-9][a-z0-9-]{1,140}$/;
  // Video id (uuid) as the play history reports it.
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

  /**
   * The metadata query. Written out here (instead of accepting a query from the
   * caller) and reduced to the fields the extension actually uses – the ZDF web
   * app sends a much larger query, but it disables introspection, so a wrong
   * field name would only fail at runtime. Every field below was verified
   * against the live API.
   *
   * `collectionType: "MOVIE"` on the smart collection and `episodeInfo` with
   * NULL season/episode is how ZDF reports a film (the contentType of a film is
   * misleadingly "EPISODE").
   */
  const SELECTION = `
    id
    canonical
    contentType
    currentMediaType
    title
    productionYear
    contentOwner { title details }
    episodeInfo { episodeNumber seasonNumber hideEpisodeInformation }
    smartCollection { id canonical title collectionType }
    currentMedia { nodes { ... on VodMedia { duration } } }
  `;

  const QUERIES = {
    canonical:
      "query WatcharrVideo($canonical: String!) { videoByCanonical(canonical: $canonical) {" +
      SELECTION +
      "} }",
    id:
      "query WatcharrVideo($id: String!) { videoById(id: $id) {" +
      SELECTION +
      "} }",
  };

  /** Runs one request and reports status + body, never throwing. */
  async function requestText(url, init, what) {
    try {
      const resp = await fetch(url, init);
      const text = await resp.text();
      if (!resp.ok) return { ok: false, status: resp.status, text };
      return { ok: true, status: resp.status, text };
    } catch (err) {
      const message = err.message || String(err);
      // "NetworkError" means the extension has no host permission for that host;
      // api.zdf.de is declared in the manifest, so this should not happen.
      console.error(
        "[watcharr-scrobbler] ZDF request failed:",
        what,
        "->",
        message,
      );
      return { ok: false, error: message };
    }
  }

  /** Headers every api.zdf.de request needs (see the file header). */
  function apiHeaders(apiToken, sessionToken, accept) {
    const headers = {
      "api-auth": "Bearer " + apiToken,
      "zdf-app-id": APP_ID,
      Accept: accept,
    };
    if (sessionToken) headers.Authorization = "Bearer " + sessionToken;
    return headers;
  }

  /** Accept of the GraphQL endpoint (what the ZDF web app sends). */
  const GRAPHQL_ACCEPT =
    "application/graphql-response+json, application/json;q=0.9";
  /**
   * Accept of the REST endpoints (identity, usage-data). The ZDF web app asks
   * these with its own media type, so both are offered – an endpoint that does
   * not know the vendor type is served by the plain JSON entry.
   */
  const REST_ACCEPT = "application/json, application/vnd.de.zdf.v1.0+json";

  /**
   * Metadata of one video, looked up by canonical (the slug in the page URL) or
   * by id (what the play history reports).
   */
  function graphql(msg) {
    const apiToken = String(msg.apiToken || "");
    if (!TOKEN_RE.test(apiToken)) {
      return { ok: false, error: "invalid ZDF app token" };
    }
    const byId = msg.kind === "id";
    if (!byId && msg.kind !== "canonical") {
      return { ok: false, error: "unknown ZDF lookup kind" };
    }
    const value = String(msg.value || "");
    if (!(byId ? VIDEO_ID_RE : CANONICAL_RE).test(value)) {
      return { ok: false, error: "invalid ZDF video reference" };
    }

    const body = {
      operationName: "WatcharrVideo",
      variables: byId ? { id: value } : { canonical: value },
      query: byId ? QUERIES.id : QUERIES.canonical,
    };
    return requestText(
      GRAPHQL_URL,
      {
        method: "POST",
        // No ZDF cookies needed – the identity is the token, which the caller
        // read from the page.
        credentials: "omit",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          apiHeaders(apiToken, "", GRAPHQL_ACCEPT),
        ),
        body: JSON.stringify(body),
      },
      (byId ? "videoById " : "videoByCanonical ") + value,
    );
  }

  /**
   * The signed-in user (`GET /identity/userinfo`), whose `id` the play-history
   * route needs. The app itself reads it the same way and keeps it in memory –
   * it is not part of its persisted store.
   */
  function userInfo(msg) {
    const apiToken = String(msg.apiToken || "");
    const sessionToken = String(msg.sessionToken || "");
    if (!TOKEN_RE.test(apiToken) || !TOKEN_RE.test(sessionToken)) {
      return { ok: false, error: "invalid ZDF session" };
    }
    return requestText(
      IDENTITY_URL + "/userinfo",
      {
        method: "GET",
        credentials: "omit",
        headers: apiHeaders(apiToken, sessionToken, REST_ACCEPT),
      },
      "userinfo",
    );
  }

  /**
   * The user's play history ("Weiterschauen"), newest first.
   *
   * Both tokens come from the ZDF page (see content/zdf/zdf-session.js) and are
   * passed through unchanged, so the request carries exactly the identity the
   * page itself uses.
   */
  function playHistory(msg) {
    const apiToken = String(msg.apiToken || "");
    const sessionToken = String(msg.sessionToken || "");
    const userId = String(msg.userId || "");
    if (!TOKEN_RE.test(apiToken) || !TOKEN_RE.test(sessionToken)) {
      return { ok: false, error: "invalid ZDF session" };
    }
    if (!USER_ID_RE.test(userId)) {
      return { ok: false, error: "invalid ZDF user id" };
    }

    const url =
      USAGE_DATA_URL +
      "/user-histories/" +
      encodeURIComponent(userId) +
      "/seamless-view-entries?limit=" +
      HISTORY_LIMIT +
      "&includeNestedObjects=false";
    return requestText(
      url,
      {
        method: "GET",
        credentials: "omit",
        headers: apiHeaders(apiToken, sessionToken, REST_ACCEPT),
      },
      "play history",
    );
  }

  const HANDLERS = {
    "watcharr:zdf:graphql": graphql,
    "watcharr:zdf:userinfo": userInfo,
    "watcharr:zdf:playhistory": playHistory,
  };

  /** Handles the message, or returns undefined when it belongs to another module. */
  async function handle(msg) {
    const fn = msg && HANDLERS[msg.type];
    return fn ? fn(msg) : undefined;
  }

  globalThis.WatcharrMessageZdf = { handle };
})();
