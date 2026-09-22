/*
 * Netflix – viewing activity for the history page.
 *
 * Netflix has no simple history API: the list is pulled page by page from the
 * `aui/pathEvaluator` endpoint (the same one Universal Trakt Scrobbler uses –
 * the old `/api/shakti/.../viewingactivity` answers 404). Each raw entry is
 * then enriched with year/season/episode from the metadata endpoint.
 */
"use strict";

(function () {
  const PAGE_SIZE = 20;

  // One pause per Netflix page (20 entries): keeps the "oldest first" full
  // crawl from walking hundreds of pages at full speed, without slowing the
  // incremental scroll mode (which is already human paced).
  const PAGE_GAP_MS = 500;
  const throttle = WatcharrContentUtil.createThrottle(PAGE_GAP_MS);

  const rawMetadataCache = new Map(); // Netflix id -> Promise<{video}|null>

  /**
   * Session for the history API: from the injected probe when available,
   * otherwise parsed out of the /settings/viewed/ page.
   */
  async function getSession() {
    const fromProbe = WatcharrNetflixPlayback.getSession();
    if (fromProbe) return fromProbe;

    try {
      const resp = await fetch("https://www.netflix.com/settings/viewed/", {
        credentials: "include",
      });
      if (!resp.ok) return null;
      const html = await resp.text();
      const match = html.match(
        /"userInfo":\{"data":\{[^}]*"userGuid":"([^"]+)"/,
      );
      if (!match || !match[1]) return null;
      return { userGuid: match[1] };
    } catch (_) {
      return null;
    }
  }

  /** One page of the history, retried so a transient error loses no page. */
  async function fetchPage(session, page, pageSize) {
    const callPath = '["aui","viewingActivity",' + page + "," + pageSize + "]";
    const url =
      "https://www.netflix.com/api/aui/pathEvaluator/web/%5E2.0.0?method=call&callPath=" +
      encodeURIComponent(callPath) +
      "&falcor_server=0.1.0";
    const body =
      "param=" + encodeURIComponent(JSON.stringify({ guid: session.userGuid }));
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-netflix.request.routing":
        '{"path":"/nq/aui/endpoint/%5E1.0.0-web/pathEvaluator","control_tag":"auinqweb"}',
    };

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await throttle();
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body,
          credentials: "include",
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        const viewed =
          data &&
          data.jsonGraph &&
          data.jsonGraph.aui &&
          data.jsonGraph.aui.viewingActivity &&
          data.jsonGraph.aui.viewingActivity.value &&
          data.jsonGraph.aui.viewingActivity.value.viewedItems;
        return Array.isArray(viewed) ? viewed : [];
      } catch (err) {
        lastError = err;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    throw lastError || new Error("History page could not be loaded");
  }

  /** Raw metadata of one Netflix id (one request per unique id). */
  function fetchRawMetadata(id) {
    if (rawMetadataCache.has(id)) return rawMetadataCache.get(id);
    const pending = (async () => {
      try {
        const url =
          "https://www.netflix.com/nq/website/memberapi/release/metadata?languages=en-US&movieid=" +
          encodeURIComponent(id);
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) return null;
        const data = await resp.json();
        const video = data && data.video;
        return video && video.type ? { video } : null;
      } catch (_) {
        return null;
      }
    })();
    rawMetadataCache.set(id, pending);
    return pending;
  }

  /**
   * Netflix reports `date` in Unix milliseconds; values in seconds are accepted
   * as fallback. (Multiplying unconditionally by 1000 once produced absurd
   * years and HTTP 400 from Watcharr.)
   */
  function toDate(ts) {
    const n = Number(ts);
    if (!isFinite(n) || n <= 0) return null;
    return new Date(n < 1e11 ? n * 1000 : n);
  }

  /** ISO-8601 string (a string survives the message channel, a Date may not). */
  function toIsoDate(ts) {
    const date = toDate(ts);
    return date ? date.toISOString() : null;
  }

  /**
   * Adds year (and for series season/episode) to raw history entries. The extra
   * provider fields (episode title, Netflix video id, raw media type) are
   * displayed as-is on the provider side of the comparison page.
   */
  async function enrich(rawItems) {
    const enriched = [];
    for (const raw of rawItems) {
      if (!raw || raw.movieID == null) continue;
      const isTv = "series" in raw && raw.series != null;
      const metadataId = isTv ? String(raw.series) : String(raw.movieID);
      const metadata = await fetchRawMetadata(metadataId);
      const video = metadata && metadata.video;

      if (isTv) {
        let season = null;
        let episode = null;
        let episodeTitle = null;
        if (video && video.type === "show") {
          const seasons = Array.isArray(video.seasons) ? video.seasons : [];
          outer: for (const s of seasons) {
            const episodes = Array.isArray(s.episodes) ? s.episodes : [];
            for (const ep of episodes) {
              if (String(ep.id) === String(raw.movieID)) {
                season = typeof s.seq === "number" ? s.seq : null;
                episode = typeof ep.seq === "number" ? ep.seq : null;
                episodeTitle = ep.title || null;
                break outer;
              }
            }
          }
        }
        enriched.push({
          date: raw.date ? toIsoDate(raw.date) : null,
          isTv: true,
          title: raw.seriesTitle || raw.title || (video && video.title) || "",
          year: video ? video.year : null,
          season,
          episode,
          episodeTitle,
          // Netflix' own identifiers (the view is the episode's video id).
          providerId: String(raw.movieID),
          providerType: (video && video.type) || "show",
        });
      } else {
        enriched.push({
          date: raw.date ? toIsoDate(raw.date) : null,
          isTv: false,
          title: raw.title || (video && video.title) || "",
          year: video ? video.year : null,
          season: null,
          episode: null,
          episodeTitle: null,
          providerId: String(raw.movieID),
          providerType: (video && video.type) || "movie",
        });
      }
    }
    return enriched.filter((e) => e.title);
  }

  /** One page of history for the history page. */
  async function fetchForUi(page) {
    const session = await getSession();
    if (!session || !session.userGuid) {
      throw new Error(
        "Netflix session could not be determined – please log in to Netflix.",
      );
    }
    const raw = await fetchPage(session, page, PAGE_SIZE);
    return {
      status: "ok",
      entries: await enrich(raw),
      done: raw.length === 0,
    };
  }

  globalThis.WatcharrNetflixHistory = { fetchForUi };
})();
