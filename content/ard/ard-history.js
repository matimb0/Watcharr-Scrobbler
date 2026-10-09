/*
 * ARD Mediathek – play history for the history page.
 *
 * Unlike every other service, ARD has no viewing-activity export: the "watch
 * history" is a Firestore collection of the ARD web app
 * (`mediathek/{uid}/lists/playhistory/items`) that the site reads to build its
 * "Weiterschauen" page.
 *
 * Two things about that collection matter here:
 *
 *  1. It only stores the CLIP ID plus `playtime`, `completed` and `updatedOn`.
 *     Titles come from the public teaser route (content/ard/ard-metadata.js),
 *     one request per entry.
 *  2. `completed` entries are NOT returned to the user by the ARD page itself
 *     – its "Weiterschauen" list filters them out. They are still very much in
 *     the collection, and they are exactly what a watch history is about, so
 *     the crawl reads all of them.
 *
 * The read itself is bounded by ARD: one query returns at most 240 entries,
 * the same cap the web app works with. Everything older is simply not part of
 * the user's ARD history any more.
 *
 * The Firestore request runs through the background (see
 * background/messages/ard.js); the session comes from the ARD page
 * (content/ard/ard-session.js).
 */
"use strict";

(function () {
  const PAGE_SIZE = 20;
  // One pause per UI page before the crawl pulls a NEW chunk of entries.
  const PAGE_GAP_MS = 500;
  const throttle = WatcharrContentUtil.createThrottle(PAGE_GAP_MS);

  const metadata = WatcharrArdMetadata;

  const historyState = {
    loadId: null,
    reachedEnd: false,
    raw: [], // { id, completed, playtime, updatedOn } – newest first
    dropped: 0, // entries whose metadata is gone (clip no longer available)
    warned: false, // the "skipped" note is logged once per load
    profile: "",
  };

  /** Firestore field value -> plain JSON (the REST API types every value). */
  function fieldValue(value) {
    if (!value || typeof value !== "object") return null;
    if ("stringValue" in value) return value.stringValue;
    if ("booleanValue" in value) return value.booleanValue;
    if ("integerValue" in value) return Number(value.integerValue);
    if ("doubleValue" in value) return Number(value.doubleValue);
    if ("timestampValue" in value) return value.timestampValue;
    if ("nullValue" in value) return null;
    return null;
  }

  /** Document id of a Firestore document name (`…/items/{id}`). */
  function documentId(name) {
    const parts = String(name || "").split("/");
    return parts.length ? parts[parts.length - 1] : "";
  }

  /** One page of raw entries (all of them – ARD caps the collection at 240). */
  async function fetchRawHistory() {
    const session = await WatcharrArdSession.get();
    if (!historyState.profile) {
      historyState.profile = session.name || session.email || "";
    }

    let resp;
    try {
      resp = await browser.runtime.sendMessage({
        type: "watcharr:ard:playhistory",
        uid: session.uid,
        idToken: session.idToken,
      });
    } catch (err) {
      throw historyError(
        "ard_unavailable",
        "The ARD Mediathek could not be reached. (" +
          ((err && err.message) || err) +
          ")",
      );
    }

    if (!resp || !resp.ok) {
      if (resp && (resp.status === 401 || resp.status === 403)) {
        throw historyError(
          "ard_session_expired",
          "The ARD Mediathek session has expired. Please reload the ARD Mediathek page and try again.",
        );
      }
      throw historyError(
        "ard_api_failed",
        "The ARD Mediathek play history could not be read" +
          (resp && resp.status ? " (HTTP " + resp.status + ")" : "") +
          ".",
      );
    }

    let rows;
    try {
      rows = JSON.parse(resp.text);
    } catch (_) {
      throw historyError(
        "ard_api_failed",
        "The ARD Mediathek returned an unreadable answer.",
      );
    }

    for (const row of Array.isArray(rows) ? rows : []) {
      const document = row && row.document;
      if (!document || !document.fields) continue;
      const fields = document.fields;
      const id = fieldValue(fields.id) || documentId(document.name);
      if (!id) continue;
      historyState.raw.push({
        id,
        completed: fieldValue(fields.completed) === true,
        playtime: Number(fieldValue(fields.playtime)) || 0,
        updatedOn: fieldValue(fields.updatedOn),
      });
    }
    // One query returns everything ARD keeps for the user.
    historyState.reachedEnd = true;
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

  /** Stable error the history page maps to a localized message. */
  function historyError(code, message) {
    const err = new Error(message);
    err.userCode = code;
    return err;
  }

  /** Converts one raw entry into a history-page entry (with metadata). */
  async function enrichRawItem(raw) {
    const description = await metadata.lookup(raw.id);
    if (!description) {
      // The clip is not in the mediathek any more (availability ended), so
      // there is nothing left to show or to match. Counted, not shown.
      historyState.dropped++;
      return null;
    }
    const date = raw.updatedOn ? new Date(raw.updatedOn) : null;
    const iso = date && !isNaN(date.getTime()) ? date.toISOString() : null;
    const isTv = description.isTv;
    return {
      date: iso,
      isTv,
      // For an episode ARD reports the episode title; the series is the entry
      // that can be matched on TMDB, exactly like the other services do it.
      title: isTv ? description.seriesTitle : description.clipTitle,
      year: null,
      providerYear: null,
      season: isTv ? description.season : null,
      episode: isTv ? description.episode : null,
      episodeTitle: isTv ? description.episodeTitle : null,
      providerId: raw.id,
      providerType: description.providerType,
    };
  }

  /**
   * One page of the ARD play history. `loadId` identifies a fresh load: a new
   * id resets the buffer, so the crawl starts at the top of the history again.
   */
  async function fetchForUi(page, loadId) {
    if (loadId != null && historyState.loadId !== loadId) {
      historyState.loadId = loadId;
      historyState.reachedEnd = false;
      historyState.raw = [];
      historyState.dropped = 0;
      historyState.warned = false;
      historyState.profile = "";
    }

    const needed = (page + 1) * PAGE_SIZE;
    if (!historyState.reachedEnd && historyState.raw.length < needed) {
      await throttle();
      await fetchRawHistory();
    }

    const start = page * PAGE_SIZE;
    const slice = historyState.raw.slice(start, start + PAGE_SIZE);
    const enriched = await mapConcurrent(slice, 6, enrichRawItem);

    const entries = enriched.filter(Boolean);
    const done =
      historyState.reachedEnd && start + PAGE_SIZE >= historyState.raw.length;
    if (done && historyState.dropped && !historyState.warned) {
      historyState.warned = true;
      console.warn(
        "[watcharr-scrobbler] ARD: " +
          historyState.dropped +
          " entries skipped (clip no longer available in the mediathek)",
      );
    }
    return {
      status: "ok",
      entries,
      done,
      profile: historyState.profile,
    };
  }

  globalThis.WatcharrArdHistory = { fetchForUi };
})();
