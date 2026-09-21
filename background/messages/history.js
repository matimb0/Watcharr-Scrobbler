/*
 * History page messages: loading the service history (or a file), matching it
 * against Watcharr, importing the selected entries and exporting everything to
 * a file.
 *
 * All of it is delegated to `WatcharrHistory` (background/history/index.js);
 * this module only routes the messages and shapes the responses.
 */
"use strict";

(function () {
  /** Runs a handler, turning a thrown error into a coded response. */
  async function guarded(fn) {
    try {
      return await fn();
    } catch (err) {
      return WatcharrErrors.toResponse(err);
    }
  }

  const HANDLERS = {
    "watcharr:history:load": (msg) =>
      guarded(async () => {
        WatcharrHistory.setSource("service");
        WatcharrHistory.setService(msg.service);
        WatcharrHistory.setOldestFirst(msg.oldestFirst === true);
        const data = await WatcharrHistory.load();
        return {
          ok: true,
          items: data.items,
          total: data.total,
          done: data.done,
          cancelled: !!data.cancelled,
          source: data.source,
          file: data.file,
        };
      }),

    // Import path: the list is filled from an exported CSV/JSON file instead of
    // the open service tab. Matching/selection/import are unchanged.
    "watcharr:history:loadFile": (msg) =>
      guarded(async () => {
        WatcharrHistory.setOldestFirst(msg.oldestFirst === true);
        const data = await WatcharrHistory.loadFromFile(
          msg.text || "",
          msg.filename || "",
        );
        return {
          ok: true,
          items: data.items,
          total: data.total,
          done: data.done,
          cancelled: !!data.cancelled,
          source: data.source,
          file: data.file,
          fileTotal: data.fileTotal,
        };
      }),

    "watcharr:history:more": (msg) =>
      guarded(async () => {
        WatcharrHistory.setService(msg.service);
        WatcharrHistory.setOldestFirst(msg.oldestFirst === true);
        const data = await WatcharrHistory.more();
        return {
          ok: true,
          items: data.items,
          total: data.total,
          done: data.done,
          error: data.error || null,
          errorCode: data.errorCode || null,
        };
      }),

    "watcharr:history:rematch": (msg) =>
      guarded(async () => ({
        ok: true,
        item: await WatcharrHistory.rematch(msg.key, msg.result),
      })),

    "watcharr:history:import": (msg) =>
      guarded(async () => ({
        ok: true,
        results: await WatcharrHistory.importItems(msg.keys || []),
      })),

    // Writes the COMPLETE history of the selected service to a file, optionally
    // enriched with TMDB data resolved through Watcharr's TMDB search. Nothing is
    // written to Watcharr itself – this is an export, not an import.
    "watcharr:history:export": (msg) =>
      guarded(async () => {
        WatcharrHistory.setService(msg.service);
        const data = await WatcharrHistory.collectForExport({
          enrich: msg.enrich === true,
        });
        return {
          ok: true,
          rows: data.rows,
          total: data.total,
          done: !!data.done,
          truncated: !!data.truncated,
          enriched: !!data.enriched,
          matched: data.matched || 0,
          cancelled: !!data.cancelled,
        };
      }),

    // Abort a running "oldest first" full load / file export.
    "watcharr:history:cancel": () => {
      WatcharrHistory.cancelHistoryLoad();
      return { ok: true };
    },

    // Progress of a running full load / export: `loaded` counts the entries
    // fetched so far, `export` carries the export phase and its counters.
    "watcharr:history:progress": () => ({
      ok: true,
      loaded: WatcharrHistory.getLoadProgress(),
      export: WatcharrHistory.getExportProgress(),
    }),
  };

  /** Handles the message, or returns undefined when it belongs to another module. */
  async function handle(msg) {
    const fn = msg && HANDLERS[msg.type];
    return fn ? fn(msg) : undefined;
  }

  globalThis.WatcharrMessageHistory = { handle };
})();
