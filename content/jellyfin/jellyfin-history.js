/*
 * Jellyfin – viewing history for the history page.
 *
 * Jellyfin has no per-view log (that needs the "Playback Reporting" plugin);
 * the closest built-in equivalent is the list of items this user has marked as
 * played, sorted by their last played date.
 */
"use strict";

(function () {
  const PAGE_SIZE = 20;

  /** One Jellyfin item -> a history-page entry (or null if unusable). */
  function itemToEntry(item) {
    if (!item) return null;
    const date = (item.UserData && item.UserData.LastPlayedDate) || null;

    if (item.Type === "Episode") {
      const title = item.SeriesName || item.Name;
      if (!title) return null;
      return {
        date,
        isTv: true,
        title,
        // Jellyfin reports `ProductionYear` for an episode as the EPISODE's own
        // year, not the series year – and there is no series year on this item.
        // Both the TMDB lookup and the row's year therefore stay empty for
        // episodes (showing the episode year under "Series" would be wrong and
        // would trip the year-mismatch warning against the series year).
        year: null,
        providerYear: null,
        season: WatcharrJellyfinItems.numberOrNull(item.ParentIndexNumber),
        episode: WatcharrJellyfinItems.numberOrNull(item.IndexNumber),
        // Jellyfin's own name of the episode and its server-side identifiers.
        episodeTitle: item.Name || null,
        providerId: item.Id ? String(item.Id) : null,
        providerType: item.Type,
      };
    }

    if (item.Type === "Movie") {
      if (!item.Name) return null;
      return {
        date,
        isTv: false,
        title: item.Name,
        year: WatcharrJellyfinItems.numberOrNull(item.ProductionYear),
        season: null,
        episode: null,
        episodeTitle: null,
        providerId: item.Id ? String(item.Id) : null,
        providerType: item.Type,
      };
    }

    return null;
  }

  /** One page of the Jellyfin history, newest first. */
  async function fetchForUi(page) {
    const login = WatcharrJellyfinAuth.getLogin();
    if (!login.ok) {
      throw WatcharrJellyfinAuth.jfError(
        "jellyfin_not_logged_in",
        "No Jellyfin login found – please log in to Jellyfin in this browser.",
      );
    }

    const start = Math.max(0, page) * PAGE_SIZE;
    const data = await WatcharrJellyfinAuth.jellyfinJson(
      "/Users/" + encodeURIComponent(login.userId) + "/Items",
      {
        Recursive: "true",
        IncludeItemTypes: "Movie,Episode",
        Filters: "IsPlayed",
        SortBy: "DatePlayed",
        SortOrder: "Descending",
        StartIndex: start,
        Limit: PAGE_SIZE,
        ImageTypeLimit: 0,
        EnableImages: false,
      },
    );

    const raw = (data && data.Items) || [];
    const total = Number((data && data.TotalRecordCount) || 0);
    return {
      status: "ok",
      entries: raw.map(itemToEntry).filter(Boolean),
      done:
        raw.length < PAGE_SIZE || (total > 0 && start + raw.length >= total),
    };
  }

  globalThis.WatcharrJellyfinHistory = { fetchForUi };
})();
