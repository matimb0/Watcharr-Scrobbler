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

/** Builds an Error with a stable i18n code + params (see background/errors.js).
 *  The UI maps these codes to translation keys (options/options.js and
 *  history/history.js), so extension-authored error text is localized instead
 *  of shown raw. */
const clientError = WatcharrErrors.create;

/**
 * Short-lived cache of content items (`/content/tv|movie/:id`): one history load
 * asks for the same series once per row, and the search enrichment asks for the
 * same id again. Importing invalidates it (see clearContentCache), so a status
 * that was just changed is never served stale.
 */
const contentCache = new Map(); // "tv|movie:id" -> { at, value }
const CONTENT_CACHE_MS = 60000;

/**
 * Short-lived cache of the plain watchlist (`GET /watched`), keyed by
 * instance+token. It is only read when a content page failed (see
 * getWatchedStateResult), and a history load asks that question for many rows,
 * so it must not be downloaded per row.
 */
const watchedListCache = new Map(); // "url|token" -> { at, value }
const WATCHED_LIST_CACHE_MS = 60000;

/**
 * True when a Watcharr error message says the entry is already on the list.
 *
 * Watcharr reports this as a plain HTTP 403 with `{"error":"watched entry
 * exists"}` (domain.ErrWatchedExists) – indistinguishable from any other
 * service error by status alone, so the message has to be inspected.
 */
function isAlreadyOnListMessage(message) {
  return /already (in|on the)? ?list|entry exists|already exists|already added/i.test(
    String(message || ""),
  );
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

    if (resp.status === 401) {
      // The JWT was rejected (or a permission is missing – Watcharr's
      // `PermRequired` answers 401 as well).
      const e = clientError(
        "auth_failed",
        "Authentication failed – please log in again.",
      );
      e.authRequired = true;
      throw e;
    }
    if (!resp.ok) {
      // NOT 403 = auth: Watcharr uses 403 as its GENERIC error status for the
      // watched routes (`POST /watched` when the entry already exists, any
      // service error of an import/update – see feature/watched/router.go). So
      // the body carries the actual reason and must be read instead of telling
      // the user to log in again.
      let msg = "HTTP " + resp.status;
      try {
        const j = await resp.json();
        if (j && j.error) msg = j.error;
      } catch (_) {
        /* no json body */
      }
      throw clientError(
        resp.status === 403 && isAlreadyOnListMessage(msg)
          ? "watched_exists"
          : "watcharr_error",
        msg,
        { status: resp.status, reason: msg },
      );
    }

    if (resp.status === 204) return null;
    // Some routes (e.g. PUT /activity/:id) answer 200 with an EMPTY body, so
    // the body is read as text first – calling resp.json() on it would throw.
    const text = await resp.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      throw clientError(
        "watcharr_error",
        "Watcharr returned an unexpected (non-JSON) response.",
      );
    }
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

  /**
   * Sets the watch date of one activity.
   *
   * Watcharr has no request that adds a dated watch, so recording a watch of a
   * MOVIE that is already on the list is done the way Watcharr's own UI does
   * it: a status change adds the activity (the "play") and its date is stored
   * afterwards. Only activities (not the watched entry) accept a date, which is
   * why the two steps are needed.
   */
  updateActivityDate(id, watchedDate) {
    return this._request("PUT", "/activity/" + Number(id), {
      customDate: watchedDate,
    });
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
   *
   * `seasons` carries TMDB's own overview (number + episode count) – the
   * extension uses it as the fallback for the season list when TMDB itself
   * cannot be asked (no API key and the website is unreachable).
   */
  getWatchedShow(tmdbId) {
    return this.getContentItem(tmdbId, "tv");
  }

  /**
   * TMDB content item of the user's instance (TV or movie). This is Watcharr's
   * job: it knows whether the title is on the list, with which status and which
   * episodes are watched – TMDB itself has none of that.
   *
   * Cached briefly: a single history load asks for the same series with every
   * row, and the search enrichment asks for the same id again.
   */
  getContentItem(tmdbId, contentType) {
    const type = contentType === "movie" ? "movie" : "tv";
    const key = type + ":" + Number(tmdbId);
    const hit = contentCache.get(key);
    if (hit && Date.now() - hit.at < CONTENT_CACHE_MS) return hit.value;
    const value = this._request(
      "GET",
      "/content/" + type + "/" + Number(tmdbId),
      // A FAILED lookup must not be cached: the promise would be handed out (and
      // its rejection re-thrown) for the whole TTL, so one transient problem
      // with this title would make the extension treat it as "not on the list"
      // for the rest of the minute – and an import would then try to create an
      // entry that already exists.
    ).catch((err) => {
      contentCache.delete(key);
      throw err;
    });
    contentCache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * The `watched` entry of a title, or null: `{ id, status, … }`. Used to fill
   * in what a TMDB search cannot know (see getContentItem).
   */
  async getWatchedState(tmdbId, contentType) {
    const res = await this.getWatchedStateResult(tmdbId, contentType);
    return res.watched;
  }

  /**
   * Like `getWatchedState`, but says WHEN the question could not be answered.
   *
   * The difference matters: `null` means "this title is not on the list" and
   * the history page promises to add it, while a failure means the extension
   * simply does not know – reporting it as "not on the list" is what made an
   * import create an entry that was already there (and Watcharr answers such a
   * create with its generic 403, see _request).
   *
   * The content page is the primary source (it also carries the watched
   * episodes), but it is NOT the only one: Watcharr builds it with TMDB plus a
   * "similar titles" lookup and answers 500 when that fails, which has nothing
   * to do with the user's list. The plain watchlist below answers the same
   * question without any of that, so a broken content page no longer makes a
   * watched title look unwatched.
   */
  async getWatchedStateResult(tmdbId, contentType) {
    let contentError = null;
    try {
      const item = await this.getContentItem(tmdbId, contentType);
      return { ok: true, watched: (item && item.watched) || null };
    } catch (err) {
      contentError = err;
    }
    try {
      const entry = await this.findWatchedInList(tmdbId, contentType);
      if (entry) {
        WatcharrUtil.log(
          "getWatchedStateResult: took",
          contentType,
          tmdbId,
          "from the watchlist (content page failed)",
        );
        return {
          ok: true,
          watched: {
            id: Number(entry.id) || null,
            status: entry.status || null,
            createdAt: entry.createdAt || null,
          },
        };
      }
      return { ok: true, watched: null };
    } catch (listError) {
      WatcharrUtil.logErr(
        "getWatchedStateResult: could not read the state of",
        contentType,
        tmdbId,
        "->",
        contentError.message,
        "/",
        listError.message,
      );
      return { ok: false, watched: null };
    }
  }

  /**
   * The plain watchlist (`GET /watched`, the non-paginated route Watcharr keeps
   * for "download the whole list"). Cached briefly, see watchedListCache.
   */
  getWatchedList() {
    const key = this.url + "|" + this.token;
    const hit = watchedListCache.get(key);
    if (hit && Date.now() - hit.at < WATCHED_LIST_CACHE_MS) return hit.value;
    const value = this._request("GET", "/watched").catch((err) => {
      watchedListCache.delete(key);
      throw err;
    });
    watchedListCache.set(key, { at: Date.now(), value });
    return value;
  }

  /** The watchlist entry of one title (see getWatchedList), or null. */
  async findWatchedInList(tmdbId, contentType) {
    const type = contentType === "movie" ? "movie" : "tv";
    const id = Number(tmdbId);
    const list = await this.getWatchedList();
    for (const entry of Array.isArray(list) ? list : []) {
      const content = entry && entry.content;
      if (!content) continue;
      if (Number(content.tmdbId) === id && String(content.type) === type) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Watch events (`activity`) of one watched entry. Watch events carry a
   * `customDate` – the watch date – which the search/watchlist DTOs do not
   * expose, and unlike the content detail pages this route needs no country.
   */
  getActivity(watchedId) {
    return this._request("GET", "/activity/" + Number(watchedId));
  }
}

/**
 * Drops the cached content items of one or more TMDB ids (all media types) –
 * called after an import/update so the next read sees the new state instead of
 * the cached one.
 */
function clearContentCache(tmdbIds) {
  const wanted = new Set((tmdbIds || []).map((id) => Number(id)));
  for (const key of [...contentCache.keys()]) {
    const id = Number(key.split(":")[1]);
    if (!wanted.size || wanted.has(id)) contentCache.delete(key);
  }
  // The watchlist entries carry the status/date an import just changed, so it
  // must not be served stale either.
  watchedListCache.clear();
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
