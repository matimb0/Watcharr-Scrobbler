/*
 * ZDF Mediathek – viewing history for the history page.
 *
 * ZDF has no viewing-activity export either. The history is what the site
 * itself loads for its "Weiterschauen" page:
 *
 *   GET /usage-data/user-histories/{userId}/seamless-view-entries
 *
 * That answer carries only the video ids plus `eventDate`, `duration` and
 * `currentPosition` – no titles. The ZDF web app enriches the ids through the
 * GraphQL API afterwards, and so does this crawl (one lookup per entry, with a
 * small worker pool). That is the same code path the live scrobbling uses, so a
 * title is only ever looked up once.
 *
 * Notes on the data:
 *  – One request returns the whole list the site works with (ZDF caps it at
 *    100 entries), so there is nothing to page through on the API side.
 *  – Entries the user removed in the UI (`deletedByUser`) are skipped, and so
 *    are trailers/previews – they are not a watch.
 *
 * Both tokens come from the ZDF page (content/zdf/zdf-session.js); the request
 * runs through the background (background/messages/zdf.js).
 */
"use strict";

(function () {
  const PAGE_SIZE = 20;
  const DESCRIPTION_CONCURRENCY = 6;
  // The ZDF app strips this marker prefix off its ids before using them.
  const ID_PREFIX_RE = /^SCMS_/;

  const metadata = WatcharrZdfMetadata;

  const historyState = {
    loadId: null,
    fetched: false,
    raw: [], // { id, eventDate, duration, currentPosition } – newest first
    dropped: 0, // entries without usable metadata (trailers, removed videos)
    warned: false, // the "skipped" note is logged once per load
    profile: "",
  };

  /** Stable error the history page maps to a localized message. */
  function historyError(code, message) {
    const err = new Error(message);
    err.userCode = code;
    return err;
  }

  /** Epoch milliseconds of a ZDF timestamp (ISO string or numeric), or null. */
  function toMillis(value) {
    if (value == null) return null;
    if (typeof value === "number") {
      // The API reports seconds; anything that large can only be milliseconds.
      return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
    }
    const parsed = Date.parse(String(value));
    return isNaN(parsed) ? null : parsed;
  }

  /** The video id of one entry, without the app's own marker prefix. */
  function cleanId(raw) {
    return String(raw || "").replace(ID_PREFIX_RE, "");
  }

  /** Reads the whole play history once (see the file header). */
  async function fetchRawHistory() {
    const session = await WatcharrZdfSession.getSession();
    if (!historyState.profile) historyState.profile = session.displayName || "";

    let resp;
    try {
      resp = await browser.runtime.sendMessage({
        type: "watcharr:zdf:playhistory",
        apiToken: session.apiToken,
        sessionToken: session.sessionToken,
        userId: session.userId,
      });
    } catch (err) {
      throw historyError(
        "zdf_unavailable",
        "The ZDF Mediathek could not be reached. (" +
          ((err && err.message) || err) +
          ")",
      );
    }

    if (!resp || !resp.ok) {
      if (resp && (resp.status === 401 || resp.status === 403)) {
        throw historyError(
          "zdf_session_expired",
          "The ZDF Mediathek session has expired. Please reload the ZDF Mediathek page and try again.",
        );
      }
      throw historyError(
        "zdf_api_failed",
        "The ZDF Mediathek viewing history could not be read" +
          (resp && resp.status ? " (HTTP " + resp.status + ")" : "") +
          ".",
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(resp.text);
    } catch (_) {
      throw historyError(
        "zdf_api_failed",
        "The ZDF Mediathek returned an unreadable answer.",
      );
    }

    const list = (parsed && parsed.seamlessViewEntries) || [];
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || entry.deletedByUser === true) continue;
      const id = cleanId(entry.externalId);
      if (!id) continue;
      historyState.raw.push({
        id,
        eventDate: toMillis(entry.eventDate),
        duration:
          typeof entry.duration === "number" && entry.duration > 0
            ? entry.duration
            : null,
        currentPosition:
          typeof entry.currentPosition === "number" && entry.currentPosition > 0
            ? entry.currentPosition
            : null,
      });
    }
    // Newest first, like the ZDF app itself sorts them.
    historyState.raw.sort((a, b) => (b.eventDate || 0) - (a.eventDate || 0));
    historyState.fetched = true;
  }

  /** Runs `fn` over `items` with at most `limit` parallel workers. */
  async function mapConcurrent(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    };
    const workers = [];
    const count = Math.min(limit, items.length);
    for (let w = 0; w < count; w++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  /** Converts one raw entry into a history-page entry (with metadata). */
  async function enrichRawItem(raw) {
    const description = await metadata.lookupId(raw.id);
    // No metadata (the video is gone), or nothing watchable (a trailer) – a
    // trailer in the history would only produce an unmatchable row.
    if (!description || description.skippable) {
      historyState.dropped++;
      return null;
    }
    const date = raw.eventDate ? new Date(raw.eventDate) : null;
    const iso = date && !isNaN(date.getTime()) ? date.toISOString() : null;
    const isTv = description.isTv;
    return {
      date: iso,
      isTv,
      // For an episode the series is what can be matched on TMDB, exactly like
      // the other services do it.
      title: isTv ? description.seriesTitle : description.clipTitle,
      // Only a film reports a usable release year (see zdf-metadata.js).
      year: isTv ? null : description.year,
      providerYear: isTv ? null : description.year,
      season: isTv ? description.season : null,
      episode: isTv ? description.episode : null,
      episodeTitle: isTv ? description.episodeTitle : null,
      providerId: raw.id,
      providerType: description.providerType,
    };
  }

  /**
   * One page of the ZDF viewing history. `loadId` identifies a fresh load: a new
   * id resets the buffer, so the crawl starts at the top of the history again.
   */
  async function fetchForUi(page, loadId) {
    if (loadId != null && historyState.loadId !== loadId) {
      historyState.loadId = loadId;
      historyState.fetched = false;
      historyState.raw = [];
      historyState.dropped = 0;
      historyState.warned = false;
      historyState.profile = "";
    }
    if (!historyState.fetched) await fetchRawHistory();

    const start = page * PAGE_SIZE;
    const slice = historyState.raw.slice(start, start + PAGE_SIZE);
    const enriched = await mapConcurrent(
      slice,
      DESCRIPTION_CONCURRENCY,
      enrichRawItem,
    );

    const entries = enriched.filter(Boolean);
    const done = start + PAGE_SIZE >= historyState.raw.length;
    if (done && historyState.dropped && !historyState.warned) {
      historyState.warned = true;
      console.warn(
        "[watcharr-scrobbler] ZDF: " +
          historyState.dropped +
          " entries skipped (trailer or video no longer available)",
      );
    }
    return {
      status: "ok",
      entries,
      done,
      profile: historyState.profile,
    };
  }

  globalThis.WatcharrZdfHistory = { fetchForUi };
})();
