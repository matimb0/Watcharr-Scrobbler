/*
 * Import: write the selected history entries into Watcharr.
 *
 * Only the normal `/watched` endpoints are used (never `/import`), so the same
 * rules apply as for manual scrobbling – and an entry that already exists is
 * updated instead of being created twice.
 */
"use strict";

(function () {
  const { subtractMinutes, log, logErr } = globalThis.WatcharrUtil;
  const userError = WatcharrErrors.create;

  /**
   * Titles this extension CREATED recently: "tv:12" / "movie:12" -> watchedId.
   *
   * Watcharr keeps one entry per title, so only the first row of a title may
   * create it; every further row writes into that entry. A large import is sent
   * in batches (see history/history.js), so this has to outlive one call –
   * otherwise every batch would ask Watcharr again whether the title is already
   * on the list (hundreds of needless requests for a series with hundreds of
   * episodes, and one more chance to create a duplicate per batch).
   *
   * Entries expire and the map is cleared whenever a fresh list is loaded, so a
   * title that was deleted in Watcharr in the meantime is not written into.
   */
  const createdEntries = new Map(); // key -> { watchedId, at }
  const CREATED_TTL_MS = 10 * 60 * 1000;

  /** Remembers the entry a row just created (see createdEntries). */
  function rememberCreated(key, watchedId) {
    if (!key || !watchedId) return;
    createdEntries.set(key, { watchedId, at: Date.now() });
  }

  /** Known entry of a title created by this extension recently, or null. */
  function knownCreated(key) {
    const hit = createdEntries.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CREATED_TTL_MS) {
      createdEntries.delete(key);
      return null;
    }
    return hit.watchedId;
  }

  /** Forgets the created entries (a fresh list / reload owns the state again). */
  function clearCreatedEntries() {
    createdEntries.clear();
  }

  /** Result object for a failed step. */
  function failure(err) {
    return {
      status: "error",
      error: err.message,
      code: (err && err.userCode) || null,
    };
  }

  /**
   * Drops the extension's cached Watcharr state of the title this row belongs to.
   *
   * Used twice: BEFORE a "the entry is already there" re-read (the create was
   * refused, so the state this row was matched with is outdated – the caches of
   * the matching phase must not answer that question again) and AFTER a write
   * (the next row or the next "Import selected" must not read the state from
   * before it). Both are the same cause: the content page and the watchlist are
   * cached for a minute, the matcher's episode/show caches until the next
   * reload, so an import a moment later fails – the entry is created a second
   * time (Watcharr answers 403) and the watch date is never written.
   */
  function forgetTitleState(item) {
    if (!item || !item.match) return;
    const tmdbId = Number(item.match.tmdbId);
    if (Number.isFinite(tmdbId) && globalThis.WatcharrClientCache) {
      globalThis.WatcharrClientCache.clearContentCache([tmdbId]);
    }
    const matcher = globalThis.WatcharrHistoryMatcher;
    if (matcher && typeof matcher.forgetWatcharrState === "function") {
      matcher.forgetWatcharrState(tmdbId);
    }
  }

  /** True when this result wrote something to Watcharr (or tried to write into
   *  an entry that is already there – both mean the cached state is outdated). */
  function changedWatcharrState(result) {
    return (
      result.status === "imported" ||
      result.status === "updated" ||
      result.code === "watched_exists"
    );
  }

  /**
   * Records a watch of a MOVIE that is already on the list.
   *
   * Watcharr keeps ONE entry per movie, so every further watch of it is an
   * activity ("play"). Its API has no request that adds a dated play, so this
   * does what Watcharr's own UI does: a status change adds the activity, and the
   * date the service reported is then stored on it.
   *
   * A status change is therefore REQUIRED – and Watcharr only creates the
   * activity when the status really changes, so an entry that is already
   * FINISHED needs the detour over WATCHING. That detour is taken whenever a
   * date is to be stored: the row's `watchedStatus` may be unknown or outdated
   * (nothing is read here, see the importer's cache invalidation), and without
   * the detour the date of the rewatch was silently dropped. The intermediate
   * activity is removed again, so exactly one dated play of this row remains.
   */
  async function addMovieWatch(client, item) {
    const { watchedId } = item.match;
    // The date of this very watch is already recorded -> nothing to add.
    if (item.watchDateMatched) return { status: "updated" };

    let intermediateActivity = null;
    if (item.date) {
      try {
        const resp = await client.updateWatched(watchedId, {
          status: "WATCHING",
        });
        intermediateActivity = (resp && resp.newActivity) || null;
      } catch (err) {
        return failure(err);
      }
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
    if (item.date && newActivity && newActivity.id) {
      try {
        await client.updateActivityDate(newActivity.id, item.date);
      } catch (err) {
        return failure(err);
      }
    }

    // The status change only existed to make Watcharr create the play.
    if (intermediateActivity && intermediateActivity.id) {
      try {
        await client.deleteActivity(intermediateActivity.id);
      } catch (err) {
        logErr(
          "addMovieWatch: could not remove the intermediate status activity",
          intermediateActivity.id,
          "->",
          err.message,
        );
      }
    }

    item.match.watchedStatus = "FINISHED";
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
    // Watcharr refused the create because the entry IS there – so the state this
    // row was matched with is outdated. Drop it before looking again: the read
    // below would otherwise be answered from the caches of the matching phase
    // (content page/watchlist: one minute) and report "not on the list" a second
    // time, which makes the import fail on a title a first import just created.
    forgetTitleState(item);
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

  /**
   * Marks the episode and stores the reported watch date on the activity
   * Watcharr created for it.
   *
   * An episode's watch date belongs on its activity, and the episode request
   * has NO date field (domain.WatchedEpisodeSetRequest.AddActivityDate is
   * `json:"-"`), so the date has to be written afterwards – otherwise the
   * episode is recorded without its date and the row is offered for import
   * again and again without anything changing.
   */
  async function writeEpisode(client, seriesId, item) {
    const watchedDate = item.date || null;
    let resp;
    try {
      resp = await client.addWatchedEpisode(
        seriesId,
        item.season,
        item.episode,
        "FINISHED",
        watchedDate,
      );
    } catch (err) {
      return failure(err);
    }

    const activity = resp && resp.newActivity;
    // Nothing new was created (this very episode is already FINISHED in this
    // state) -> the watch itself is recorded, which is what the row asked for.
    if (!watchedDate || !activity || !activity.id) {
      return { status: "updated", episodes: 1 };
    }
    try {
      await client.updateActivityDate(activity.id, watchedDate);
    } catch (err) {
      return {
        status: "error",
        error:
          "The episode was marked as watched, but its watch date could not be stored: " +
          err.message,
        code: (err && err.userCode) || null,
      };
    }
    return { status: "updated", episodes: 1 };
  }

  async function importEpisode(client, item) {
    const { tmdbId, watchedId } = item.match;
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
      return writeEpisode(client, seriesId, item);
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
        subtractMinutes(item.date || null, 1),
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
        const written = await writeEpisode(client, newId, item);
        // The episode itself failed (its date could not be stored) -> report
        // that instead of claiming the whole row was imported.
        if (written.status === "error") return written;
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
        return writeEpisode(client, item.match.watchedId, item);
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
    const results = [];

    for (const item of ordered) {
      const key = item.match
        ? (item.isTv ? "tv:" : "movie:") + item.match.tmdbId
        : null;
      // A title that was created by an EARLIER row (of this call or of an
      // earlier batch of the same import) is written into instead of being
      // created a second time (Watcharr allows one entry per title).
      if (key && !item.match.watchedId) {
        const known = knownCreated(key);
        if (known) item.match.watchedId = known;
      }

      // One row may never abort the run: an unexpected error (a shape the row
      // did not have, a Watcharr answer nobody mapped) belongs to THIS row and
      // is reported on it – the other selected rows are still imported.
      let result;
      try {
        result = await importOne(client, item);
      } catch (err) {
        logErr(
          "importItems: unexpected error for",
          item.title,
          "->",
          err && err.message,
        );
        result = failure(err);
      }
      item.status = result.status;
      item.error = result.error || null;
      item.errorCode = result.code || null;

      // The write changed the Watcharr state of this title – the caches must not
      // outlive it (see forgetTitleState), or the next row/import reads the
      // state from before.
      if (changedWatcharrState(result)) forgetTitleState(item);

      if (result.watchedId && item.match) {
        item.match.watchedId = result.watchedId;
        rememberCreated(key, result.watchedId);
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

  globalThis.WatcharrHistoryImporter = { importItems, clearCreatedEntries };
})();
