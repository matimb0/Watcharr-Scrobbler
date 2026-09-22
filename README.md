# Watcharr Scrobbler (Firefox + Chrome)

A browser extension (Firefox and Chrome) that works like the
[Universal Trakt Scrobbler](https://github.com/trakt-tools/universal-trakt-scrobbler) –
but **only for your own, self-hosted [Watcharr](https://github.com/sbondCo/Watcharr)-instance**.

**Current status:** **Netflix**, **Prime Video** and **Jellyfin** are
integrated as services.

<br>

## What it does

- Automatically detects what is currently playing on Netflix, Prime Video or
  Jellyfin (movie or series, including season & episode).
- Searches for the title via your Watcharr instance (TMDB search) and adds it to your watchlist.
  For Jellyfin the TMDB ID reported by the server is used directly when available.
- While you are watching, the entry remains **WATCHING**.
- Once a movie or episode reaches the configurable threshold,
  it is marked as watched in Watcharr (**FINISHED**).
- For series, the individual **episode** is marked as watched – Watcharr
  automatically updates the series status (“Automate Show Statuses”).
- **History page:** Import your previous viewing history (Netflix, Prime
  Video or Jellyfin) in a controlled way – with comparison, match
  correction, and selective import (movies as watched series episodes
  individually).

<br>

## Installation

> **Note regarding permissions:** The manifest requests access to the
> service hosts at runtime.

**Firefox**

- **Firefox Add-ons (AMO):** The add-on is available in the
  [Firefox Add-ons Store](https://addons.mozilla.org/de/firefox/addon/watcharr-scrobbler/) – this is the
  recommended way to install it.
- **Manual (`.xpi`):** Alternatively, you can install the `.xpi` file attached
  to the respective [GitHub Release](https://github.com/matimb0/Watcharr-Scrobbler/releases)
  (the `.xpi` is uploaded to each release as soon as it has been signed by
  Mozilla). To install it manually, open `about:addons` in Firefox, click the
  gear icon and choose **“Install Add-on From File…**”.

**Chrome**

- The add-on is **not yet available** in the Chrome Web Store. If there is
  interest, it will also be uploaded to the Chrome Web Store.
- **In the meantime:** You can build a current, ready-to-use version yourself.
  Run `npm run build` – this creates the unpacked extension in `dist/chrome/`
  (to build only Chrome, use `npm run build:chrome`). Then open
  `chrome://extensions`, enable **Developer mode** and click
  **“Load unpacked”**, selecting the `dist/chrome` folder.

<br>

## Setup

1. Open the extension settings (Popup → **Settings**).
2. Enter the **Watcharr URL** (base URL, e.g. `https://watcharr.example.com`,
   without `/api`).
3. Enter your username & password and click **“Save & Connect”**.
   - The password is **not stored**. It is only used for logging in;
     only the JWT token is stored.
   - If your Watcharr server has a **Jellyfin** or **Plex** host configured,
     those login methods are offered automatically in the settings (the add-on
     asks the server via `GET /api/auth/available`). Jellyfin uses username &
     password, Plex opens a plex.tv popup for the OAuth login.
4. Optional: Adjust the scrobbling threshold (e.g. 90% if only the ending should count).
5. **Jellyfin (optional):** Enter the **base URL of your Jellyfin server**
   (e.g. `http://192.168.1.10:8096`) in the “Jellyfin server” section and press
   Enter. Then just log in to Jellyfin in the browser – the extension reuses
   that session (access token + user from the web client), so no second login
   and no API key is needed. The content script is registered for exactly that
   server and injected into already-open Jellyfin tabs.
6. Open Netflix, Prime Video or your Jellyfin server and get started 🍿

You can see the status and progress at any time in the **Popup**.

> **Prime Video:** Reachable exclusively via **primevideo.com** – the
> account's Amazon marketplace is not used.

<br>

## History import

The **History page** (Popup → **“History”**) gives you full
Control similar to Universal Trakt Scrobbler: a **side-by-side comparison** of each
watched title (Netflix, Prime Video or Jellyfin – the service is selected
automatically from the open tab) with the automatically found **Watcharr match**,
including **match correction** and **selective import**. No separate
synchronization is required – the page loads the history directly from the open
service tab.

<br>

## History export

**“Data” › “Export …”** on the history page writes the **complete viewing history** of
the current service (Netflix, Prime Video or Jellyfin) into a file – nothing is
imported into Watcharr. Choose **CSV** or **JSON**:

| Column                                        | Meaning                                                     |
| --------------------------------------------- | ----------------------------------------------------------- |
| `service` / `serviceId`                       | Netflix, Prime Video or Jellyfin                            |
| `title`, `type`, `year`                       | Title as reported by the service (`type` = `movie` \| `tv`) |
| `season`, `episode`                           | Only for series (empty for movies)                          |
| `watchedAt`                                   | Watch date/time (ISO-8601, UTC)                             |
| `tmdbId`, `tmdbType`, `tmdbTitle`, `tmdbYear` | Added optionally (see below)                                |

With **“Add TMDB data via Watcharr”** (enabled by default) every entry is
additionally matched against TMDB **through your Watcharr instance** – the
identical entries of a series share one lookup. The resulting `tmdbId` +
`tmdbType` + `season`/`episode` + `watchedAt` combination is what other
services (Trakt, Simkl, Letterboxd, …) expect for an import, so the file can be
handed over there directly. Entries that cannot be matched keep empty TMDB
columns and can still be imported by title/year.

The export crawls the whole history, so it can take a moment; progress is shown
in the dialog and the export can be aborted at any time. Without the TMDB
option the export needs no Watcharr connection at all.

<br>

## History import from a file

**“Data” › “Load from file …”** on the history page fills the list from a
previously exported **CSV or JSON** file instead of the open service tab.
Everything else stays the same: the entries are matched against Watcharr, shown
side by side, and the selected ones can be imported with **“Import selected”**.

- Rows that carry **TMDB data** are matched on exactly that TMDB ID (the ID is
  looked up through Watcharr, which also returns whether the title is already
  in your watchlist – so nothing is created twice). Rows whose TMDB ID cannot
  be resolved are marked and can be corrected manually via **“Change match”**.
- Rows **without** TMDB data are matched by title/year like a service history.
- The file order does not matter: entries are sorted by their watch date
  (newest first), exactly like a service history, so **View › Newest first /
  Oldest first** behaves identically.
- Besides our own export, other column spellings are understood
  (`name`, `seasonNumber`/`episodeNumber`, `watched_date`, nested
  `ids.tmdb`, `Film`/`Series` type names, …).
- **“Back”** returns to the history of the open service tab; **Export** (in the
  same **“Data”** menu) is only available for the service history.

<br>

## Troubleshooting

> **Note:** The Watcharr API can currently (v4.2.1) only import exact viewing dates for
> movies/series (not per episode). The history is therefore transferred
> correctly in terms of what was watched. In the meantime, you shouldn't use
> the exact match Mode.

<br>

## AI Disclosure

> **AI-assisted:** The largest part of this codebase has been personally reviewed and verified. Some parts, however, were written by AI and have not yet been checked by me. A thorough personal review of these parts is planned. The extension currently appears to be working without any errors.
