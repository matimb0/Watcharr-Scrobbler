/*
 * Watcharr API client.
 *
 * Talks to the user's self-hosted Watcharr instance. The token is sent as a
 * raw JWT in the `Authorization` header (Watcharr does NOT expect a "Bearer "
 * prefix).
 *
 * Base URL example: https://watcharr.example.com (the /api prefix is added
 * here).
 */
"use strict";

/** Builds an Error with a stable i18n code + params. The UI maps these codes
 *  to translation keys (see options/options.js and history/history.js), so
 *  extension-authored error text is localized instead of shown raw. */
function clientError(code, message, params) {
  const e = new Error(message);
  e.userCode = code;
  e.userParams = params || {};
  return e;
}

class WatcharrClient {
  constructor(settings) {
    this.url = (settings.watcharrUrl || "").replace(/\/+$/, "");
    this.token = settings.token || "";
  }

  /** Generic JSON request against `<url>/api<path>`. */
  async _request(method, path, body) {
    if (!this.url)
      throw clientError(
        "url_not_configured",
        "Watcharr URL is not configured.",
      );
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = this.token;

    let resp;
    try {
      resp = await fetch(this.url + "/api" + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        credentials: "omit",
      });
    } catch (err) {
      throw clientError(
        "connection_failed",
        "Connection to Watcharr failed: " + err.message,
        { reason: err.message },
      );
    }

    if (resp.status === 401 || resp.status === 403) {
      const e = clientError(
        "auth_failed",
        "Authentication failed – please log in again.",
      );
      e.authRequired = true;
      throw e;
    }
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try {
        const j = await resp.json();
        if (j && j.error) msg = j.error;
      } catch (_) {
        /* no json body */
      }
      throw clientError("watcharr_error", msg, { reason: msg });
    }

    if (resp.status === 204) return null;
    return resp.json();
  }

  /**
   * Which login providers the server has enabled.
   * GET /auth/available -> { available: ["jellyfin"|"plex"], useEmby, ... }
   */
  getAvailableAuth() {
    return this._request("GET", "/auth/available");
  }

  /**
   * POSTs credentials to a login endpoint (no Authorization header) and
   * returns the JWT from the response. Shared by login() and loginPlex().
   */
  async _requestToken(path, body) {
    if (!this.url)
      throw clientError(
        "url_not_configured",
        "Watcharr URL is not configured.",
      );
    let resp;
    try {
      resp = await fetch(this.url + "/api" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
      });
    } catch (err) {
      throw clientError(
        "connection_failed",
        "Connection to Watcharr failed: " + err.message,
        { reason: err.message },
      );
    }
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try {
        const j = await resp.json();
        if (j && j.error) msg = j.error;
      } catch (_) {
        /* no json body */
      }
      throw clientError("login_rejected", "Login failed: " + msg, {
        reason: msg,
      });
    }
    const data = await resp.json();
    if (!data || !data.token)
      throw clientError("no_token", "Login failed: no token in response.");
    return data.token;
  }

  /**
   * Log in with Watcharr (default) or Jellyfin credentials.
   * `method` is "" (Watcharr) or "jellyfin" (must be enabled on the server -
   * Watcharr validates the credentials against it).
   */
  login(username, password, method) {
    const path = method === "jellyfin" ? "/auth/jellyfin" : "/auth/";
    return this._requestToken(path, { username, password });
  }

  /**
   * Finish a Plex OAuth login: send the plex.tv auth token + client identifier
   * to Watcharr, which verifies access and returns the JWT token.
   */
  loginPlex(authToken, clientIdentifier) {
    return this._requestToken("/auth/plex", {
      token: authToken,
      clientIdentifier,
    });
  }

  /** Master search (TMDB multi search). Returns the raw search response. */
  search(query, type = "multi") {
    const params = new URLSearchParams({ query, type });
    return this._request("GET", "/search?" + params.toString());
  }

  /** Add a movie/tv show to the watched list. */
  addWatched(tmdbId, contentType, status, watchedDate) {
    const body = {
      contentType, // "movie" | "tv"
      // Watcharr expects an integer; some versions return the TMDB ID as a
      // string, which would make the server answer HTTP 400.
      tmdbId: Number(tmdbId),
      status, // "PLANNED" | "WATCHING" | "FINISHED" | ...
    };
    if (watchedDate) body.watchedDate = watchedDate;
    return this._request("POST", "/watched", body);
  }

  /** Update a watched entry (status, rating, thoughts, pinned). */
  updateWatched(id, patch) {
    return this._request("PUT", "/watched/" + Number(id), patch);
  }

  /** Mark a specific episode as watched (auto-updates the show status). */
  addWatchedEpisode(
    watchedId,
    seasonNumber,
    episodeNumber,
    status,
    watchedDate,
  ) {
    const body = {
      watchedId: Number(watchedId),
      seasonNumber: Number(seasonNumber),
      episodeNumber: Number(episodeNumber),
      status,
    };
    // RFC3339 watch date – the request struct expects the JSON field
    // `watchedDate` (entity: WatchedEpisodeAddRequest).
    if (watchedDate) body.watchedDate = watchedDate;
    return this._request("POST", "/watched/episode", body);
  }

  /** Mark a whole season as watched. */
  addWatchedSeason(watchedId, seasonNumber, status) {
    return this._request("POST", "/watched/season", {
      watchedId: Number(watchedId),
      seasonNumber: Number(seasonNumber),
      status,
    });
  }

  /**
   * Fetches the TV detail page including the `watched` entry with all watched
   * episodes (`watched.watchedEpisodes`) – the only Watcharr API with
   * episode-level granularity (search and the /watched list only carry
   * `watchingSeason`, i.e. the *last* watched episode).
   */
  getWatchedShow(tmdbId) {
    return this._request("GET", "/content/tv/" + Number(tmdbId));
  }
}

/**
 * Minimal client for plex.tv's pin-based OAuth flow (v2 API), mirroring the
 * flow Watcharr's own web UI uses (src/lib/util/plex.ts).
 */
const PlexTvAuth = {
  baseHeaders(clientId) {
    return {
      Accept: "application/json",
      "X-Plex-Product": "Watcharr Scrobbler",
      "X-Plex-Client-Identifier": clientId,
      "X-Plex-Version": "1.0.0",
      "X-Plex-Model": "Plex OAuth",
      "X-Plex-Platform": "Firefox",
      "X-Plex-Platform-Version": "Plex OAuth",
      "X-Plex-Device": "Firefox",
      "X-Plex-Device-Name": "Watcharr Scrobbler",
    };
  },

  /** Create a (strong) pin and return { id, code }. */
  async createPin(clientId) {
    let resp;
    try {
      resp = await fetch("https://plex.tv/api/v2/pins?strong=true", {
        method: "POST",
        headers: this.baseHeaders(clientId),
        credentials: "omit",
      });
    } catch (err) {
      throw clientError(
        "plex_network",
        "Connection to plex.tv failed: " + err.message,
        { reason: err.message },
      );
    }
    if (!resp.ok) {
      throw clientError(
        "plex_http",
        "plex.tv pin request failed (HTTP " + resp.status + ").",
        { status: resp.status },
      );
    }
    const data = await resp.json();
    if (!data || !data.id || !data.code)
      throw clientError("plex_invalid", "plex.tv returned an invalid pin.");
    return { id: data.id, code: data.code };
  },

  /** Poll a pin. Returns the auth token once the user approved the login in
   *  the plex.tv popup, or null while it is still pending. */
  async pollPin(clientId, pinId, pinCode) {
    let resp;
    try {
      resp = await fetch("https://plex.tv/api/v2/pins/" + pinId, {
        method: "GET",
        headers: { ...this.baseHeaders(clientId), code: pinCode },
        credentials: "omit",
      });
    } catch (err) {
      throw clientError(
        "plex_network",
        "Connection to plex.tv failed: " + err.message,
        { reason: err.message },
      );
    }
    if (!resp.ok) {
      throw clientError(
        "plex_http",
        "plex.tv pin poll failed (HTTP " + resp.status + ").",
        { status: resp.status },
      );
    }
    const data = await resp.json();
    return (data && data.authToken) || null;
  },

  /** URL for the plex.tv popup where the user logs in and grants access. */
  authUrl(clientId, pinCode) {
    return (
      "https://app.plex.tv/auth/#!?" +
      "clientID=" +
      clientId +
      "&code=" +
      pinCode +
      "&context=Watcharr" +
      "&context[device][device]=" +
      encodeURIComponent("Firefox") +
      "&context[device][deviceName]=" +
      encodeURIComponent("Watcharr Scrobbler") +
      "&context[device][platform]=" +
      encodeURIComponent("Firefox") +
      "&context[device][platformVersion]=" +
      "&context[device][product]=" +
      encodeURIComponent("Watcharr Scrobbler")
    );
  },
};
