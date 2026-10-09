/*
 * ZDF Mediathek – the tokens the extension needs.
 *
 * ZDF uses two independent credentials, and both belong to the page's own
 * origin, so they are read here in the content script – no ZDF password, no
 * separate login, no API key of our own:
 *
 *  1. The APP token (`appToken.apiToken`): server-rendered into every page as
 *     part of the client config. It is public (it is the same for every
 *     visitor) but rotates roughly daily, together with an `expiresAt`.
 *     It authenticates the public metadata API.
 *
 *  2. The SESSION token of the signed-in user. It lives in the app's persisted
 *     store (`local-user-data`, a zustand state) – older builds kept it in a
 *     separate `zdf_user_token` localStorage entry, which is still read as a
 *     fallback. It authenticates the user's own play history.
 *
 * The account id the history endpoint needs is NOT stored locally: the app
 * fetches the user from the identity service. That request is replayed here
 * through the background (see resolveUserId).
 *
 * The session token is deliberately NOT refreshed here. The ZDF page keeps its
 * own session alive while it is open; an expired token therefore means the page
 * has not been used for a while, and asking the user to reload it is both
 * simpler and safer than minting tokens behind the app's back.
 */
"use strict";

(function () {
  // Current location of the session token: the app's persisted store
  // (`LOCAL_USER_DATA_KEY` in its client bundle), a zustand store whose JSON is
  // `{ state: { sessionToken, … }, version }`.
  const USER_DATA_KEY = "local-user-data";
  // Legacy keys of the same session. Older builds (and the migration path of the
  // current one) kept them as separately JSON-encoded localStorage values, so
  // they are read through JSON.parse and only used when the store has nothing.
  const LEGACY_SESSION_KEY = "zdf_user_token";
  const LEGACY_USER_INFO_KEY = "zdf_user_logged_in_user_info";
  // A token that expires within this window counts as expired.
  const EXPIRY_MARGIN_MS = 60 * 1000;
  // Both tokens are opaque; only their shape is relied on.
  const TOKEN_RE = /^[A-Za-z0-9_.-]{20,200}$/;

  let cached = null;
  let pending = null;

  /**
   * The tokens of the client config, read from the page's server-rendered
   * payload.
   *
   * The payload is JSON embedded in a script tag (Next.js RSC), where the
   * quotes are escaped (`\"appToken\":{...}`). It is normalized first, so both
   * spellings are found, and the whole document is searched because the config
   * is part of the app shell rather than of a specific page.
   */
  function readClientTokens() {
    let html;
    try {
      html = document.documentElement ? document.documentElement.outerHTML : "";
    } catch (_) {
      return {};
    }
    if (!html) return {};
    const text = html.replace(/\\"/g, '"');
    const out = {};
    for (const name of ["appToken", "videoToken"]) {
      const match = text.match(
        new RegExp(
          '"' + name + '"\\s*:\\s*\\{[^}]*"apiToken"\\s*:\\s*"([^"]+)"',
          "i",
        ),
      );
      if (match && TOKEN_RE.test(match[1])) out[name] = match[1];
    }
    const expiry = text.match(
      /"appToken"\s*:\s*\{[^}]*"expiresAt"\s*:\s*"([^"]+)"/i,
    );
    if (expiry) out.appTokenExpiresAt = expiry[1];
    return out;
  }

  /** Raw localStorage value of `key`, or "" – never throws (blocked storage). */
  function readStorage(key) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? "" : String(value);
    } catch (_) {
      return "";
    }
  }

  /** JSON value of a localStorage key, or null (also never throws). */
  function readJson(key) {
    const raw = readStorage(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  /**
   * The app's persisted store (`local-user-data`), or null.
   *
   * zustand writes `{ state: { … }, version: N }`; some builds may persist the
   * state object directly, so both shapes are accepted.
   */
  function readUserData() {
    const data = readJson(USER_DATA_KEY);
    if (!data || typeof data !== "object") return null;
    const state =
      data.state && typeof data.state === "object" ? data.state : data;
    return state && typeof state === "object" ? state : null;
  }

  /**
   * Last resort: find the session token by looking at the CONTENT of
   * localStorage instead of a key name.
   *
   * The store's key name is not part of any contract, so a rename (or a build
   * that namespaces it) would otherwise silently look like "not logged in".
   * Only structured hits count – an object with a string `sessionToken`, or one
   * whose `state` has it – so unrelated values cannot be picked up by accident.
   */
  function findSessionTokenByContent() {
    let count;
    try {
      count = localStorage.length;
    } catch (_) {
      return "";
    }
    for (let i = 0; i < count; i++) {
      let value;
      try {
        const key = localStorage.key(i);
        if (!key) continue;
        value = localStorage.getItem(key);
      } catch (_) {
        continue;
      }
      if (!value || value.length > 200000) continue;
      const token = sessionTokenIn(parseJsonSafe(value));
      if (token) return token;
    }
    return "";
  }

  /** `sessionToken` of a persisted store value, or "". */
  function sessionTokenIn(data) {
    if (!data || typeof data !== "object") return "";
    const candidates = [data];
    if (data.state && typeof data.state === "object")
      candidates.push(data.state);
    for (const candidate of candidates) {
      const token = candidate.sessionToken;
      if (typeof token === "string" && TOKEN_RE.test(token)) return token;
    }
    return "";
  }

  /** Parses JSON, returning null instead of throwing. */
  function parseJsonSafe(raw) {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  /** Session token of the signed-in user, or "". */
  function readSessionToken() {
    const state = readUserData();
    const fromStore = state && state.sessionToken;
    if (typeof fromStore === "string" && fromStore) return fromStore;
    // Legacy: the value is JSON-encoded (the app's own reader JSON.parses it).
    const legacy = readJson(LEGACY_SESSION_KEY);
    if (typeof legacy === "string" && legacy) return legacy;
    // … and a plain string is tolerated as well.
    const raw = readStorage(LEGACY_SESSION_KEY);
    if (raw && TOKEN_RE.test(raw)) return raw;
    // The store may live under another key than the one we know.
    const found = findSessionTokenByContent();
    if (!found) logMissingSession();
    return found;
  }

  /**
   * Diagnosis for the "not logged in" case: which localStorage keys exist at
   * all. Written once per page – a key layout that changed is otherwise
   * impossible to tell from a user who really is logged out.
   */
  let warnedMissingSession = false;

  function logMissingSession() {
    if (warnedMissingSession) return;
    warnedMissingSession = true;
    let keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++)
        keys.push(localStorage.key(i));
    } catch (_) {
      keys = ["(not enumerable)"];
    }
    console.warn(
      "[watcharr-scrobbler] ZDF: no session token found. localStorage keys:",
      keys.join(", ") || "(none)",
    );
  }

  /**
   * Legacy account info (`zdf_user_logged_in_user_info`), or null. The current
   * build keeps the user in the identity service instead – this is only a
   * shortcut that can save the `userinfo` request.
   */
  function readLegacyUserInfo() {
    const info = readJson(LEGACY_USER_INFO_KEY);
    return info && typeof info === "object" ? info : null;
  }

  /** Display name of an account object, or "". */
  function displayNameOf(user) {
    if (!user || typeof user !== "object") return "";
    for (const key of ["displayName", "userName", "name", "email"]) {
      const value = user[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  /** Everything the page can tell us without a request (never throws). */
  function read() {
    const tokens = readClientTokens();
    const sessionToken = readSessionToken();
    const legacyUser = readLegacyUserInfo();
    const expiresAt = Date.parse(tokens.appTokenExpiresAt || "");
    return {
      appToken: tokens.appToken || "",
      // Kept as a fallback for the metadata API – only ever used when the app
      // token is missing from the payload.
      videoToken: tokens.videoToken || "",
      appTokenExpiresAt: isNaN(expiresAt) ? 0 : expiresAt,
      sessionToken,
      // Only known when the legacy key is still around; otherwise it is fetched
      // on demand (see resolveUserId).
      userId: legacyUser && legacyUser.id ? String(legacyUser.id) : "",
      displayName: displayNameOf(legacyUser),
      loggedIn: !!sessionToken,
    };
  }

  /** Cached read: the payload and localStorage do not change on every poll. */
  function readCached() {
    if (!cached) cached = read();
    return cached;
  }

  /** Drops the cache (a page navigation may bring a fresh payload). */
  function invalidate() {
    cached = null;
    pending = null;
  }

  /** An error the history page can turn into a localized hint. */
  function sessionError(code, message) {
    const err = new Error(message);
    err.userCode = code;
    return err;
  }

  /** True when the app token is missing or already (nearly) expired. */
  function appTokenExpired(tokens) {
    return (
      !!tokens.appTokenExpiresAt &&
      Date.now() > tokens.appTokenExpiresAt - EXPIRY_MARGIN_MS
    );
  }

  /**
   * App token for the public metadata API. Throws with a stable `userCode`
   * when the page payload does not carry a usable token.
   */
  function getApiToken() {
    const tokens = readCached();
    if (!tokens.appToken && !tokens.videoToken) {
      throw sessionError(
        "zdf_no_token",
        "The ZDF Mediathek page did not provide an API token. Please reload the ZDF Mediathek page.",
      );
    }
    if (appTokenExpired(tokens) && !tokens.videoToken) {
      throw sessionError(
        "zdf_session_expired",
        "The ZDF Mediathek token has expired. Please reload the ZDF Mediathek page and try again.",
      );
    }
    // A stale rotating token would only produce an auth error; the video token
    // outlives it by a moment and answers the same metadata API.
    if (appTokenExpired(tokens)) return tokens.videoToken;
    return tokens.appToken || tokens.videoToken;
  }

  /**
   * Account id of the signed-in user.
   *
   * The id is NOT part of the persisted store – the app fetches the user from
   * the identity service (`GET /identity/userinfo`) and keeps it in memory. That
   * request is replayed here through the background, exactly like the history
   * itself, and the answer is cached for the life of the page.
   */
  async function resolveUserId(sessionToken, apiToken) {
    const legacy = readCached();
    if (legacy.userId) return legacy.userId;

    let resp;
    try {
      resp = await browser.runtime.sendMessage({
        type: "watcharr:zdf:userinfo",
        apiToken,
        sessionToken,
      });
    } catch (_) {
      resp = null;
    }

    if (resp && (resp.status === 401 || resp.status === 403)) {
      throw sessionError(
        "zdf_session_expired",
        "The ZDF Mediathek session has expired. Please reload the ZDF Mediathek page and try again.",
      );
    }
    if (!resp || !resp.ok || !resp.text) {
      throw sessionError(
        "zdf_unavailable",
        "The ZDF account could not be read. Please reload the ZDF Mediathek page and try again.",
      );
    }

    let user;
    try {
      user = JSON.parse(resp.text);
    } catch (_) {
      user = null;
    }
    const id = user && user.id ? String(user.id) : "";
    if (!id) {
      throw sessionError(
        "zdf_not_logged_in",
        "No ZDF Mediathek login found. Please log in to the ZDF Mediathek in this browser and reload the page.",
      );
    }
    if (cached) {
      cached.userId = id;
      if (!cached.displayName) cached.displayName = displayNameOf(user);
    }
    return id;
  }

  /**
   * Session of the signed-in user, for the play history. Throws with a stable
   * `userCode` when the user is not logged in.
   */
  async function getSession() {
    const tokens = readCached();
    const apiToken = getApiToken();
    if (!tokens.sessionToken) {
      throw sessionError(
        "zdf_not_logged_in",
        "No ZDF Mediathek login found. Please log in to the ZDF Mediathek in this browser and reload the page.",
      );
    }
    if (!pending) {
      pending = resolveUserId(tokens.sessionToken, apiToken).catch((err) => {
        pending = null; // a later attempt may succeed (e.g. after a reload)
        throw err;
      });
    }
    return {
      apiToken,
      sessionToken: tokens.sessionToken,
      userId: await pending,
      displayName: readCached().displayName,
    };
  }

  globalThis.WatcharrZdfSession = {
    read: readCached,
    invalidate,
    getApiToken,
    getSession,
  };
})();
