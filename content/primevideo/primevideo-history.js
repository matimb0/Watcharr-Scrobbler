/*
 * Amazon Prime Video – viewing history for the history page.
 *
 * Amazon serves the history from the account's marketplace host, which is only
 * known after asking the "GetAppStartupConfig" endpoint – and the extension
 * fetches it through the BACKGROUND script, because the content script's own
 * fetch is blocked by the page CORS for those cross-origin API hosts.
 *
 * Endpoints, headers and the recursion over `nextToken` mirror the Amazon
 * Prime implementation of Universal Trakt Scrobbler.
 */
"use strict";

(function () {
  const DEVICE_ID = "1a740c71-27ac-409a-a360-549a3dadacc6";
  const DEVICE_TYPE_ID = "AOAGZA014O5RE";
  const PAGE_SIZE = 20;

  // One pause per UI page before the crawl pulls a NEW Amazon page (pages
  // already buffered are served without a pause).
  const PAGE_GAP_MS = 500;
  const throttle = WatcharrContentUtil.createThrottle(PAGE_GAP_MS);

  const api = {
    active: false,
    failed: false,
    error: null,
    hostUrl: "https://www.primevideo.com",
    apiUrl: "https://atv-ps.primevideo.com",
    profileUrl: null,
    historyUrl: null,
    itemUrl: null,
  };

  /** Runs an Amazon API request through the background (see file header). */
  async function amazonJson(url) {
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:primevideo:api",
      url,
    });
    if (!resp || !resp.ok) {
      if (resp && resp.status) {
        throw new Error("Amazon API request failed (HTTP " + resp.status + ")");
      }
      const err = new Error(
        (resp && resp.error) || "Amazon API request failed.",
      );
      // The background names the host it was not allowed to reach. Carried as
      // a stable code + param so the history page can translate it AND request
      // exactly that origin on the next "Reload" click.
      if (resp && resp.blockedOrigin) {
        err.userCode = "network_blocked";
        err.userParams = { origin: resp.blockedOrigin };
      }
      throw err;
    }
    try {
      return JSON.parse(resp.text);
    } catch (_) {
      throw new Error("Amazon API returned invalid JSON.");
    }
  }

  /**
   * Determines the account's marketplace/region and the matching API hosts
   * (GetAppStartupConfig -> homeRegion), exactly like UTS does.
   */
  async function ensureApi() {
    if (api.active) return;
    if (api.failed) {
      throw api.error || new Error("Amazon session could not be activated.");
    }

    try {
      const configUrl =
        api.apiUrl +
        "/cdp/usage/GetAppStartupConfig?deviceID=&deviceTypeID=" +
        DEVICE_TYPE_ID +
        "&firmware=1&gascEnabled=false&version=1";
      const config = await amazonJson(configUrl);
      const region = (
        (config.customerConfig && config.customerConfig.homeRegion) ||
        ""
      ).toLowerCase();
      const host =
        (config.territoryConfig &&
          config.territoryConfig.defaultVideoWebsite) ||
        api.hostUrl;

      api.hostUrl = host;
      api.apiUrl = host
        .replace("www.", "")
        .replace(
          "//",
          "//atv-ps" + (region === "na" ? "" : "-" + region) + ".",
        );

      const apiPath = /https:\/\/(?:www\.)?amazon\./.test(host)
        ? "/gp/video/api"
        : "/region/" + region + "/api";

      api.profileUrl = host + apiPath + "/getProfiles";
      api.historyUrl =
        host + apiPath + "/getWatchHistorySettingsPage?widgetArgs=%7B{args}%7D";
      api.itemUrl =
        api.apiUrl +
        "/cdp/catalog/GetPlaybackResources?asin={id}&consumptionType=Streaming&desiredResources=CatalogMetadata&deviceID=" +
        DEVICE_ID +
        "&deviceTypeID=" +
        DEVICE_TYPE_ID +
        "&firmware=1&gascEnabled=true&resourceUsage=CacheResources&videoMaterialType=Feature&titleDecorationScheme=primary-content&uxLocale=en_US";

      api.active = true;
    } catch (err) {
      api.failed = true;
      api.error = new Error(
        "Prime Video session could not be determined – please log in to Prime Video. (" +
          (err.message || String(err)) +
          ")",
      );
      // Keep the stable code/params of the original failure (a blocked host is
      // actionable in the UI – see amazonJson).
      api.error.userCode = (err && err.userCode) || null;
      api.error.userParams = (err && err.userParams) || null;
      throw api.error;
    }
  }

  /** Recursively flattens nested history groups down to single views. */
  function flattenHistoryItems(list) {
    const out = [];
    for (const it of list || []) {
      if (it.children && it.children.length > 0) {
        out.push(...flattenHistoryItems(it.children));
      } else if (it && it.gti) {
        out.push(it);
      }
    }
    return out;
  }

  const metadataCache = new Map(); // ASIN -> Promise<metadata|null>

  /**
   * Catalog metadata of one ASIN. Amazon only exposes it per item, so every
   * history entry costs one request (see mapConcurrent).
   */
  function getMetadata(id) {
    if (metadataCache.has(id)) return metadataCache.get(id);
    const pending = (async () => {
      try {
        const meta = await amazonJson(
          api.itemUrl.replace("{id}", encodeURIComponent(id)),
        );
        const catalogMetadata = meta && meta.catalogMetadata;
        const catalog = catalogMetadata && catalogMetadata.catalog;
        if (!catalogMetadata || !catalog || !catalog.id || !catalog.title) {
          return null;
        }
        const ancestors =
          catalogMetadata.family &&
          Array.isArray(catalogMetadata.family.tvAncestors)
            ? catalogMetadata.family.tvAncestors
            : [];
        const season = ancestors[0] && ancestors[0].catalog;
        const show = ancestors[1] && ancestors[1].catalog;
        return {
          id: catalog.id,
          entityType: catalog.entityType || "",
          // Some media append a version tag, e.g. "Movie [dubbed/de]".
          title: (catalog.title || "").replace(/ \[[\w.]+\/[\w.]+\]$/, ""),
          episodeNumber:
            typeof catalog.episodeNumber === "number"
              ? catalog.episodeNumber
              : null,
          seasonNumber:
            season && typeof season.seasonNumber === "number"
              ? season.seasonNumber
              : null,
          showTitle:
            show && show.title
              ? show.title.replace(/ \[[\w.]+\/[\w.]+\]$/, "")
              : null,
        };
      } catch (_) {
        return null;
      }
    })();
    metadataCache.set(id, pending);
    return pending;
  }

  const historyState = {
    loadId: null,
    started: false,
    reachedEnd: false,
    nextToken: "",
    raw: [], // { gti, time } – newest first, as returned by Amazon
  };

  async function fetchRawHistoryPage() {
    const args = historyState.nextToken
      ? "%22nextToken%22%3A%22" + historyState.nextToken + "%22"
      : "";
    const data = await amazonJson(api.historyUrl.replace("{args}", args));
    const widget = (data.widgets || []).find(
      (w) => w.widgetType === "watch-history",
    );
    if (!widget) {
      historyState.reachedEnd = true;
      return;
    }
    const content = widget.content && widget.content.content;
    if (!content || !content.titles) {
      historyState.reachedEnd = true;
      return;
    }
    for (const group of content.titles) {
      for (const it of flattenHistoryItems(group.titles)) {
        historyState.raw.push({ gti: it.gti, time: it.time });
      }
    }
    historyState.nextToken = content.nextToken || "";
    if (!content.nextToken) historyState.reachedEnd = true;
  }

  /**
   * Runs `fn` over `items` with at most `limit` parallel workers, results in
   * input order. Enriching 20 rows sequentially would be far too slow, because
   * Amazon metadata is per item.
   */
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

  /** Converts one raw history item into a history-page entry (with metadata). */
  async function enrichRawItem(raw) {
    const meta = await getMetadata(raw.gti);
    if (!meta) return null;
    if (meta.entityType === "Trailer") return null;
    const date = new Date(raw.time);
    const iso = isNaN(date.getTime()) ? null : date.toISOString();
    if (meta.entityType === "TV Show" || meta.entityType === "Bonus Content") {
      return {
        date: iso,
        isTv: true,
        title: meta.showTitle || meta.title,
        year: null,
        season: meta.seasonNumber,
        episode: meta.episodeNumber,
      };
    }
    return {
      date: iso,
      isTv: false,
      title: meta.title,
      year: null,
      season: null,
      episode: null,
    };
  }

  /**
   * One page of the Prime Video history. `loadId` identifies a fresh load: a
   * new id resets the buffer, so the crawl starts at the top of the history
   * again.
   */
  async function fetchForUi(page, loadId) {
    if (loadId != null && historyState.loadId !== loadId) {
      historyState.loadId = loadId;
      historyState.started = false;
      historyState.reachedEnd = false;
      historyState.nextToken = "";
      historyState.raw = [];
    }
    if (!historyState.started) {
      await ensureApi();
      historyState.started = true;
    }

    const needed = (page + 1) * PAGE_SIZE;
    if (historyState.raw.length < needed && !historyState.reachedEnd) {
      await throttle();
    }
    while (historyState.raw.length < needed && !historyState.reachedEnd) {
      await fetchRawHistoryPage();
    }

    const start = page * PAGE_SIZE;
    const slice = historyState.raw.slice(start, start + PAGE_SIZE);
    const enriched = await mapConcurrent(slice, 6, enrichRawItem);
    return {
      status: "ok",
      entries: enriched.filter(Boolean),
      done:
        historyState.reachedEnd && start + PAGE_SIZE >= historyState.raw.length,
    };
  }

  globalThis.WatcharrPrimeHistory = { fetchForUi };
})();
