/*
 * Jellyfin – login and API access for THIS web client.
 *
 * Jellyfin Web keeps its servers and logins in its own localStorage entry
 * ("jellyfin_credentials"), so the user does not have to log in a second time:
 * the access token and user id are read from there and every request is a plain
 * SAME-ORIGIN fetch against the web client's own API (no CORS involved).
 */
"use strict";

(function () {
  // localStorage key the Jellyfin web client uses for its servers + logins.
  const CREDENTIALS_KEY = "jellyfin_credentials";

  const login = { ok: false, base: "", token: "", userId: "" };

  /** Builds an Error carrying the stable i18n code used by the history page. */
  function jfError(code, message) {
    const err = new Error(message || code);
    err.userCode = code;
    return err;
  }

  function stripSlashes(s) {
    return String(s == null ? "" : s).replace(/\/+$/, "");
  }

  /** Base path of a stored server address ("" for a server at the root). */
  function basePathOf(address) {
    try {
      const url = new URL(String(address), location.origin);
      const path = stripSlashes(url.pathname);
      return path === "/" ? "" : path;
    } catch (_) {
      return "";
    }
  }

  /**
   * Reads the login out of the web client's localStorage. The API base URL is
   * built from the CURRENT page origin plus the server's base path (for
   * installations behind a reverse-proxy sub-path), so every request stays
   * same-origin.
   */
  function readLogin() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(CREDENTIALS_KEY);
    } catch (_) {
      return null;
    }
    if (!raw) return null;

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return null;
    }

    const servers = data && Array.isArray(data.Servers) ? data.Servers : [];
    const usable = servers.filter((s) => s && s.AccessToken && s.UserId);
    if (!usable.length) return null;

    // Prefer the entry that points at the origin this page is served from.
    const here = usable.filter((s) => {
      if (!s.ManualAddress) return false;
      try {
        return (
          new URL(String(s.ManualAddress), location.origin).origin ===
          location.origin
        );
      } catch (_) {
        return false;
      }
    });
    const server = here[0] || usable[0];
    const basePath =
      here.length > 0 && server.ManualAddress
        ? basePathOf(server.ManualAddress)
        : "";

    return {
      base: location.origin + basePath,
      token: String(server.AccessToken),
      userId: String(server.UserId),
    };
  }

  /**
   * Returns the cached login. While nothing is cached the localStorage is
   * re-read on every call, so logging in AFTER the page was opened works
   * without a reload.
   */
  function getLogin() {
    if (login.ok) return login;
    const found = readLogin();
    login.ok = !!found;
    login.base = found ? found.base : "";
    login.token = found ? found.token : "";
    login.userId = found ? found.userId : "";
    return login;
  }

  /** Drops the cached login (e.g. after the token was rejected). */
  function forgetLogin() {
    login.ok = false;
    login.base = "";
    login.token = "";
    login.userId = "";
  }

  /** Same-origin GET against the Jellyfin API (MediaBrowser auth scheme). */
  async function jellyfinJson(path, params) {
    const current = getLogin();
    if (!current.ok) {
      throw jfError(
        "jellyfin_not_logged_in",
        "No Jellyfin login found – please log in to Jellyfin in this browser.",
      );
    }

    let url = current.base + path;
    if (params) {
      const query = new URLSearchParams();
      for (const key of Object.keys(params)) {
        if (params[key] != null) query.set(key, String(params[key]));
      }
      const qs = query.toString();
      if (qs) url += "?" + qs;
    }

    let resp;
    try {
      resp = await fetch(url, {
        method: "GET",
        credentials: "omit",
        headers: {
          Authorization: 'MediaBrowser Token="' + current.token + '"',
        },
      });
    } catch (err) {
      throw jfError(
        "jellyfin_unavailable",
        "Jellyfin server could not be reached: " + (err.message || String(err)),
      );
    }

    if (resp.status === 401 || resp.status === 403) {
      forgetLogin(); // token expired/invalid -> re-read on the next call
      throw jfError(
        "jellyfin_not_logged_in",
        "Jellyfin rejected the session – please log in again.",
      );
    }
    if (!resp.ok) {
      throw jfError(
        "jellyfin_api_failed",
        "Jellyfin API request failed (HTTP " + resp.status + ").",
      );
    }
    try {
      return await resp.json();
    } catch (_) {
      throw jfError(
        "jellyfin_api_failed",
        "Jellyfin API returned an invalid response.",
      );
    }
  }

  globalThis.WatcharrJellyfinAuth = {
    jfError,
    getLogin,
    forgetLogin,
    jellyfinJson,
  };
})();
