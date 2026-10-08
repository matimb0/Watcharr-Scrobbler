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

  /**
   * Records a watch of a MOVIE that is already on the list.
   *
   * Watcharr keeps ONE entry per movie, so every further watch of it is an
   * activity ("play"). Its API has no request that adds a dated play, so this
   * does what Watcharr's own UI does: a status change adds the activity, and the
   * date the service reported is then stored on it.
   */
  async function addMovieWatch(client, item) {
    const { watchedId, watchedStatus } = item.match;
    // The date of this very watch is already recorded -> nothing to add.
    if (watchedStatus === "FINISHED" && item.watchDateMatched) {
      return { status: "updated" };
    }

    let newActivity = null;
    try {
      const resp = await client.updateWatched(watchedId, {
        status: "FINISHED",
      });
      newActivity = resp && resp.newActivity;
    } catch (err) {
      return failure(err);
    }

    // Without a date there is nothing to correct (the activity counts as a
    // play, dated now).
    if (!item.date || !newActivity || !newActivity.id) {
      return { status: "updated" };
    }
    try {
      await client.updateActivityDate(newActivity.id, item.date);
    } catch (err) {
      return failure(err);
    }
    return { status: "updated" };
  }

  /** True when Watcharr refused a create because the entry is already there. */
  function isAlreadyOnList(err) {
    return !!(err && err.userCode === "watched_exists");
  }

  /**
   * Takes over the Watcharr entry of this row after the create was refused with
   * "already on the list" (or when the row's state was never readable, see
   * matcher.fillWatchedState). Refreshes the row's Watcharr-side state – the
   * watch date included, so `addMovieWatch` does not record a second play for a
   * watch that is already there.
   *
   * Returns true when an entry was found and adopted.
   */
  async function adoptExistingEntry(client, item) {
    const contentType = item.isTv ? "tv" : "movie";
    const state = await client.getWatchedStateResult(
      item.match.tmdbId,
      contentType,
    );
    if (!state.watched || !state.watched.id) return false;
    item.match.watchedId = state.watched.id;
    item.match.watchedStatus = state.watched.status || null;
    item.match.watchedCreatedAt = state.watched.createdAt || null;
    item.match.watchedStateUnknown = false;
    // Which watch dates Watcharr already holds for this entry – resolved the
    // same way a fresh load does it (see matcher.resolveItemEpisodeStatus).
    if (globalThis.WatcharrHistoryMatcher) {
      await WatcharrHistoryMatcher.resolveItemEpisodeStatus(item);
    }
    return true;
  }

  async function importMovie(client, item) {
    const { tmdbId, watchedId } = item.match;

    // Already on the list: the watch itself exists, so an import can only add
    // the watch date this row reports (exact mode) or lift the entry to
    // FINISHED.
    if (watchedId) return addMovieWatch(client, item);

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
      // The movie IS on the list, only this row did not know it: the create was
      // the wrong move, not a failure to report. Take the existing entry and
      // write into it instead (its watch date, or nothing when this very watch
      // is already recorded).
      if (isAlreadyOnList(err) && (await adoptExistingEntry(client, item))) {
        return addMovieWatch(client, item);
      }
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
      const state = await client.getWatchedStateResult(tmdbId, "tv");
      if (state.watched && state.watched.id) seriesId = state.watched.id;
      // A failed lookup is NOT "does not exist": creating the series then
      // collides with the existing entry (Watcharr answers 403) – the create
      // below is healed for that case instead of reported as an error.
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
      // The series IS on the list (see importMovie for the same case): use the
      // entry that is there and mark the episode on it.
      if (isAlreadyOnList(err) && (await adoptExistingEntry(client, item))) {
        if (!hasEpisode) return { status: "updated", episodes: 0 };
        try {
          await client.addWatchedEpisode(
            item.match.watchedId,
            item.season,
            item.episode,
            "FINISHED",
            watchedDate,
          );
          return { status: "updated", episodes: 1 };
        } catch (inner) {
          return failure(inner);
        }
      }
      return failure(err);
    }
  }

  async function importOne(client, item) {
    if (!item.match) {
      return { status: "skipped", error: "no match", code: "no_match" };
    }
    // A series row without season/episode is BLOCKED (the page does not offer it
    // for selection either): importing it would only create the series itself.
    // The user assigns the numbers via "Change match" first.
    if (item.isTv && item.season == null && item.episode == null) {
      return {
        status: "skipped",
        error: "Episode number is missing",
        code: "episode_missing",
      };
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
   * order they arrive in and of the display order – so a series/ movie imported
   * in this run is created with its oldest (original) watch date.
   *
   * When several entries of the same title are imported at once – episodes of a
   * series or rewatches of a movie – only the first may create the entry
   * (POST /watched); every further one reuses that new watched id (an episode is
   * marked on it, a movie watch becomes another play).
   */
  async function importItems(entries) {
    const settings = await WatcharrSettings.get();
    if (!settings.watcharrUrl || !settings.token) {
      throw userError("not_configured", "Watcharr is not configured.");
    }
    const client = new WatcharrClient(settings);

    const ordered = entries.slice().sort(byDateAscending);
    const created = new Map(); // "tv:12" / "movie:12" -> watchedId of this run
    const results = [];

    for (const item of ordered) {
      const key = item.match
        ? (item.isTv ? "tv:" : "movie:") + item.match.tmdbId
        : null;
      // Entry created just above -> write into that one instead of creating it
      // a second time (Watcharr allows one entry per title).
      if (key && !item.match.watchedId && created.has(key)) {
        item.match.watchedId = created.get(key);
      }

      const result = await importOne(client, item);
      item.status = result.status;
      item.error = result.error || null;
      item.errorCode = result.code || null;

      if (result.watchedId && item.match) {
        item.match.watchedId = result.watchedId;
        created.set(key, result.watchedId);
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
