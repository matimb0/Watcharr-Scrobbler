/*
 * Import: write the selected history entries into Watcharr.
 *
 * Only the normal `/watched` endpoints are used (never `/import`), so the same
 * rules apply as for manual scrobbling – and an entry that already exists is
 * updated instead of being created twice.
 */
"use strict";

(function () {
  const { subtractMinutes } = globalThis.WatcharrUtil;
  const userError = WatcharrErrors.create;

  /** Result object for a failed step. */
  function failure(err) {
    return {
      status: "error",
      error: err.message,
      code: (err && err.userCode) || null,
    };
  }

  async function importMovie(client, item) {
    const { tmdbId, watchedId, watchedStatus } = item.match;

    // Already on the list: only lift it to FINISHED when needed.
    if (watchedId) {
      if (watchedStatus !== "FINISHED") {
        try {
          await client.updateWatched(watchedId, { status: "FINISHED" });
        } catch (err) {
          return failure(err);
        }
      }
      return { status: "updated" };
    }

    try {
      const created = await client.addWatched(
        tmdbId,
        "movie",
        "FINISHED",
        item.date || null,
      );
      const newId = created && Number(created.id);
      if (!newId) {
        return {
          status: "error",
          error: "Create failed (no watchedId in response)",
          code: "create_failed",
        };
      }
      return { status: "imported", watchedId: newId };
    } catch (err) {
      return failure(err);
    }
  }

  async function importEpisode(client, item) {
    const { tmdbId, watchedId } = item.match;
    const watchedDate = item.date || null;
    const hasEpisode = item.season != null && item.episode != null;

    // Does the series already exist in Watcharr? A matched row or a series
    // created earlier in this run already carries a watchedId.
    let seriesId = watchedId;
    if (!seriesId) {
      try {
        const show = await client.getWatchedShow(tmdbId);
        const existing = show && show.watched && Number(show.watched.id);
        if (existing) seriesId = existing;
      } catch (_) {
        /* check unavailable -> treat as new (a duplicate would be an error) */
      }
    }

    if (seriesId) {
      if (!hasEpisode) return { status: "updated", episodes: 0 };
      try {
        await client.addWatchedEpisode(
          seriesId,
          item.season,
          item.episode,
          "FINISHED",
          watchedDate,
        );
        return { status: "updated", episodes: 1 };
      } catch (err) {
        return failure(err);
      }
    }

    // The series does not exist yet:
    // 1. create it as WATCHING with the episode's watch date MINUS one minute
    //    as its "date added", so its creation precedes the finished episode,
    // 2. then mark exactly this episode as FINISHED with the original date.
    try {
      const created = await client.addWatched(
        tmdbId,
        "tv",
        "WATCHING",
        subtractMinutes(watchedDate, 1),
      );
      const newId = created && Number(created.id);
      if (!newId) {
        return {
          status: "error",
          error: "Create failed (no watchedId in response)",
          code: "create_failed",
        };
      }
      if (hasEpisode) {
        await client.addWatchedEpisode(
          newId,
          item.season,
          item.episode,
          "FINISHED",
          watchedDate,
        );
      }
      return {
        status: "imported",
        watchedId: newId,
        episodes: hasEpisode ? 1 : 0,
      };
    } catch (err) {
      return failure(err);
    }
  }

  async function importOne(client, item) {
    if (!item.match) {
      return { status: "skipped", error: "no match", code: "no_match" };
    }
    return item.isTv ? importEpisode(client, item) : importMovie(client, item);
  }

  /** Oldest watch date first; entries without a usable date go last. */
  function byDateAscending(a, b) {
    const ta = a.date ? new Date(a.date).getTime() : Infinity;
    const tb = b.date ? new Date(b.date).getTime() : Infinity;
    return ta - tb;
  }

  /**
   * Imports the given entries into Watcharr.
   *
   * They are always sent ordered by watch date ASCENDING, independent of the
   * order they arrive in and of the display order – so a series imported in
   * this run is created with its oldest (original) watch date.
   *
   * When several episodes of a series that does not exist yet are imported at
   * once, only the first may create it (POST /watched); every further episode
   * of the same series reuses that new watched id.
   */
  async function importItems(entries) {
    const settings = await WatcharrSettings.get();
    if (!settings.watcharrUrl || !settings.token) {
      throw userError("not_configured", "Watcharr is not configured.");
    }
    const client = new WatcharrClient(settings);

    const ordered = entries.slice().sort(byDateAscending);
    const createdSeries = new Map(); // tmdbId -> watchedId created in this run
    const results = [];

    for (const item of ordered) {
      // Episode of a series created just above -> mark the episode on that
      // existing entry instead of adding the series again.
      if (
        item.isTv &&
        item.match &&
        !item.match.watchedId &&
        createdSeries.has(item.match.tmdbId)
      ) {
        item.match.watchedId = createdSeries.get(item.match.tmdbId);
      }

      const result = await importOne(client, item);
      item.status = result.status;
      item.error = result.error || null;
      item.errorCode = result.code || null;

      if (result.watchedId && item.match) {
        item.match.watchedId = result.watchedId;
        if (item.isTv) createdSeries.set(item.match.tmdbId, result.watchedId);
      }

      results.push({
        key: item.key,
        title: item.title,
        status: result.status,
        error: result.error,
        code: result.code || null,
        episodes: result.episodes,
        watchedId: result.watchedId || null,
      });
    }

    return results;
  }

  globalThis.WatcharrHistoryImporter = { importItems };
})();
