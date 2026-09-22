/*
 * Jellyfin – mapping server items onto the scrobbler's metadata shape and
 * resolving their TMDB ids.
 *
 * Jellyfin usually knows the TMDB id itself (`ProviderIds`). Series expose only
 * the EPISODE's id there, so the series id is looked up once and cached.
 */
"use strict";

(function () {
  const Api = globalThis.WatcharrContentApi;

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /** TMDB id out of a Jellyfin DTO's `ProviderIds` (or null). */
  function tmdbOf(dto) {
    const ids = dto && dto.ProviderIds;
    if (!ids) return null;
    const raw = ids.Tmdb != null ? ids.Tmdb : ids.tmdb;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /**
   * Maps a Jellyfin `NowPlayingItem` (BaseItemDto) onto the metadata shape used
   * by the scrobbler. Returns null for item types we do not scrobble (trailer,
   * music, …).
   */
  function mapNowPlaying(dto) {
    if (!dto) return null;
    const type = String(dto.Type || "");

    if (type === "Episode") {
      const title = dto.SeriesName || dto.Name || "";
      if (!title) return null;
      return {
        type: "tv",
        title,
        // The episode's own year is not what TMDB searches for a series; the
        // series is looked up by title (and its TMDB id, when available).
        year: null,
        seasonNumber: numberOrNull(dto.ParentIndexNumber),
        episodeNumber: numberOrNull(dto.IndexNumber),
        episodeTitle: dto.Name || "",
        // `ProviderIds` holds the EPISODE's TMDB id – Watcharr needs the SERIES
        // id, which is resolved through SeriesId below.
        tmdbId: null,
        seriesId: dto.SeriesId ? String(dto.SeriesId) : null,
        seriesTmdbId: tmdbOf({ ProviderIds: dto.SeriesProviderIds }),
      };
    }

    if (type === "Movie") {
      const title = dto.Name || "";
      if (!title) return null;
      return {
        type: "movie",
        title,
        year: numberOrNull(dto.ProductionYear),
        seasonNumber: null,
        episodeNumber: null,
        episodeTitle: null,
        tmdbId: tmdbOf(dto),
        seriesId: null,
        seriesTmdbId: null,
      };
    }

    return null;
  }

  const seriesTmdbCache = new Map(); // Jellyfin series id -> Promise<tmdbId|null>

  /** TMDB id of a Jellyfin series (looked up once, then cached). */
  function lookupSeriesTmdb(seriesId) {
    if (!seriesId) return Promise.resolve(null);
    if (seriesTmdbCache.has(seriesId)) return seriesTmdbCache.get(seriesId);

    const pending = (async () => {
      const login = WatcharrJellyfinAuth.getLogin();
      if (!login.ok) return null;
      try {
        const dto = await WatcharrJellyfinAuth.jellyfinJson(
          "/Users/" +
            encodeURIComponent(login.userId) +
            "/Items/" +
            encodeURIComponent(seriesId),
        );
        return tmdbOf(dto);
      } catch (_) {
        return null;
      }
    })();
    seriesTmdbCache.set(seriesId, pending);
    return pending;
  }

  /**
   * Resolves the medium through Watcharr's TMDB search. The search result is
   * also the only way to learn whether the medium is ALREADY on the user's list
   * (and with which status) – that `watched` entry keeps the import from
   * downgrading an already finished medium.
   *
   * When Jellyfin knows the TMDB id, it picks the EXACT search result (and is
   * the last resort), so the match does not depend on title/year guessing.
   */
  async function resolveTmdb(item) {
    const meta = item.metadata;
    const wantType = meta.type === "movie" ? "movie" : "tv";
    let knownTmdbId = meta.tmdbId || meta.seriesTmdbId || null;
    if (!knownTmdbId && meta.type === "tv" && meta.seriesId) {
      knownTmdbId = await lookupSeriesTmdb(meta.seriesId);
    }

    let best = null;
    // Typed search + year filter first (see Api.buildQueries: a "multi" search
    // ignores the year, which would match the wrong same-titled medium).
    for (const { query, searchType } of Api.buildQueries(
      meta.title,
      meta.year,
      meta.type,
    )) {
      let results = [];
      try {
        const resp = await browser.runtime.sendMessage({
          type: "watcharr:search",
          query,
          searchType,
        });
        if (!resp || !resp.ok) continue;
        results = (resp.data && resp.data.results) || [];
      } catch (_) {
        continue;
      }
      if (!results.length) continue;

      if (knownTmdbId) {
        const wanted = Number(knownTmdbId);
        best = results.find((r) => Api.resultTmdbId(r) === wanted) || null;
        if (best) break;
      } else {
        best = Api.pickBestMatch(results, meta);
        if (best) break;
      }
    }

    if (best && Api.resultTmdbId(best)) {
      item.tmdb = {
        tmdbId: Api.resultTmdbId(best),
        contentType: knownTmdbId
          ? wantType
          : best.type === "tmdb_movie"
            ? "movie"
            : "tv",
        name: best.name || meta.title,
      };
      if (best.watched && best.watched.id) {
        item.watchedId = best.watched.id;
        item.watchedStatus = best.watched.status;
      }
      return true;
    }

    // Watcharr's search found nothing usable – but Jellyfin knows the id, so
    // the item can still be scrobbled.
    if (knownTmdbId) {
      item.tmdb = {
        tmdbId: Number(knownTmdbId),
        contentType: wantType,
        name: meta.title,
      };
      return true;
    }
    return false;
  }

  globalThis.WatcharrJellyfinItems = {
    numberOrNull,
    tmdbOf,
    mapNowPlaying,
    resolveTmdb,
  };
})();
