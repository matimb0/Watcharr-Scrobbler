/*
 * File export: add TMDB data to the collected history rows.
 *
 * The rows themselves come from the service crawl (background/history/index.js)
 * and never touch Watcharr – this module only ENRICHES them, by searching each
 * title through the user's Watcharr instance (which proxies TMDB). That makes
 * the exported file importable by other services.
 */
"use strict";

(function () {
  const { log, logErr, normTitle } = globalThis.WatcharrUtil;

  // Parallel lookups: 4 finish a large history quickly without hammering the
  // Watcharr instance.
  const CONCURRENCY = 4;

  const matcher = globalThis.WatcharrHistoryMatcher;

  /**
   * TMDB match of one export row. `cache` holds one Promise per
   * "title|year|type", so every episode of the same series shares a lookup and
   * a long history only needs a handful of requests.
   */
  function lookupRow(row, client, cache) {
    const key = normTitle(row.title) + "|" + (row.year || "") + "|" + row.type;
    if (cache.has(key)) return cache.get(key);

    const pending = (async () => {
      // Same query order as the history matching (typed + year filter first,
      // see background/history/matcher.js).
      const isTv = row.type === "tv";

      for (const { query, type } of matcher.buildQueries(
        row.title,
        row.year,
        isTv,
      )) {
        let results = [];
        try {
          const data = await client.search(query, type);
          results = (data && data.results) || [];
        } catch (err) {
          // A single failed lookup must not abort the whole export – the row
          // simply stays without TMDB data.
          logErr("lookupRow: search failed for", row.title, "->", err.message);
          return null;
        }
        const match = matcher.resultToMatch(
          matcher.pickBest(results, row.title, isTv, row.year),
        );
        if (match) return match;
      }
      return null;
    })();

    cache.set(key, pending);
    return pending;
  }

  /** Writes the TMDB data of a match into an export row. */
  function applyMatch(row, match) {
    if (!match) return;
    const year = match.year != null ? parseInt(String(match.year), 10) : NaN;
    row.tmdbId = match.tmdbId;
    row.tmdbType = match.contentType;
    row.tmdbTitle = match.name || null;
    row.tmdbYear = isNaN(year) ? null : year;
  }

  /**
   * Adds TMDB data to all rows, with limited concurrency.
   *
   * @param options { shouldStop(), onProgress(processed, matched) }
   * @returns { processed, matched }
   */
  async function enrich(rows, client, options) {
    const opts = options || {};
    const shouldStop = opts.shouldStop || (() => false);
    const onProgress = opts.onProgress || (() => {});

    const cache = new Map();
    let next = 0;
    let processed = 0;
    let matched = 0;

    const worker = async () => {
      while (next < rows.length && !shouldStop()) {
        const row = rows[next++];
        const match = await lookupRow(row, client, cache);
        if (shouldStop()) return;
        applyMatch(row, match);
        if (match) matched++;
        processed++;
        onProgress(processed, matched);
      }
    };

    log("enrich: resolving TMDB data for", rows.length, "rows …");
    const workers = [];
    const count = Math.min(CONCURRENCY, rows.length);
    for (let w = 0; w < count; w++) workers.push(worker());
    await Promise.all(workers);
    log("enrich: TMDB data for", matched, "/", rows.length, "rows");

    return { processed, matched };
  }

  globalThis.WatcharrHistoryExporter = { enrich };
})();
