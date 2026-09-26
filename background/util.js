/*
 * Small helpers shared by the background scripts (dates, titles, logging).
 */
"use strict";

(function () {
  const log = (...args) => console.log("[watcharr-bg]", ...args);
  const logErr = (...args) => console.error("[watcharr-bg]", ...args);

  /** Lower-cased, whitespace-collapsed title (comparisons and cache keys). */
  function normTitle(s) {
    return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  /**
   * Aggressive comparison form of an episode/title NAME: accents removed,
   * lower case, every non-alphanumeric character (apostrophes, dashes, dots,
   * exclamation marks, …) turned into a separator, whitespace collapsed.
   *
   * "I Have a Great Fucking Idea!" and "Ich hab' eine geile Idee" differ in
   * wording, but "Leiche macht mobil - bei …" and "Leiche macht mobil – bei …"
   * only differ in punctuation and must compare equal.
   */
  function normName(value) {
    return String(value == null ? "" : value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // accents/diacritics
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  /**
   * Similarity of two strings, 0..1 (Dice coefficient over character bigrams).
   * Used as a last resort for names that are not identical after normalization,
   * so a small typo or a slightly different spelling still matches.
   */
  function nameSimilarity(a, b) {
    const x = normName(a);
    const y = normName(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return 0;

    const bigrams = (value) => {
      const map = new Map();
      for (let i = 0; i < value.length - 1; i++) {
        const gram = value.slice(i, i + 2);
        map.set(gram, (map.get(gram) || 0) + 1);
      }
      return map;
    };
    const left = bigrams(x);
    const right = bigrams(y);
    let shared = 0;
    for (const [gram, count] of left) {
      const other = right.get(gram);
      if (other) shared += Math.min(count, other);
    }
    return (2 * shared) / (x.length - 1 + y.length - 1);
  }

  // A fuzzy match has to be this similar, and this far ahead of the runner-up –
  // names like "Teil 1"/"Teil 2" are close to each other and must NOT be picked
  // by mistake.
  const FUZZY_MIN_SIMILARITY = 0.86;
  const FUZZY_MIN_MARGIN = 0.06;

  // Prefix of the keys an episode is additionally indexed under (see
  // episodeKeys). They never take part in the fuzzy comparison.
  const POSITION_PREFIX = "#pos:";

  // Word lists for names that describe a POSITION instead of a title. Services
  // and TMDB label the same episode differently depending on the language
  // ("Pilot" in one, "Folge 1" in the other), so those labels are compared by
  // the position they mean (see positionKey).
  const SEASON_WORDS = [
    "season",
    "staffel",
    "saison",
    "temporada",
    "stagione",
    "seizoen",
    "sezon",
    "sasong",
    "kausi",
  ];
  const EPISODE_WORDS = [
    "episode",
    "folge",
    "ep",
    "episodio",
    "aflevering",
    "avsnitt",
    "odcinek",
    "jakso",
    "epizoda",
  ];
  const PART_WORDS = ["part", "teil", "parte", "partie", "chapter", "kapitel"];
  // Labels meaning "the first episode" – a series' pilot IS its first episode.
  const PILOT_WORDS = [
    "pilot",
    "pilotfolge",
    "pilotepisode",
    "pilotaflevering",
    "pilotavsnitt",
    "pilote",
    "pilota",
    "piloto",
    "episode pilote",
    "episodio pilota",
    "episodio piloto",
    "series premiere",
    "premiere",
    "serienstart",
    "erste folge",
    "first episode",
    "premier episode",
    "primer episodio",
    "primeiro episodio",
  ];

  /**
   * The POSITION a generic episode name means as an index key, or null.
   *
   *   "Pilot", "Pilotfolge", "Premiere"        -> "#pos:first"  (series pilot)
   *   "Folge 7", "Episode 7", "Part. 7", "Ep 7"-> "#pos:e7"
   *   "Staffel 3 Folge 7", "Season 3 Ep 7"     -> "#pos:s3e7"
   *
   * Only such labels are mapped – a real title is never positional, so nothing
   * is guessed from ordinary names.
   */
  function positionKey(name) {
    const value = normName(name);
    if (!value) return null;
    const season = SEASON_WORDS.join("|");
    const episode = EPISODE_WORDS.join("|");
    const part = PART_WORDS.join("|");

    let match = value.match(
      new RegExp(
        "^(?:" +
          season +
          ")\\s*(\\d+)\\s*(?:(?:" +
          episode +
          "|" +
          part +
          ")\\s*)?(\\d+)$",
      ),
    );
    if (match)
      return POSITION_PREFIX + "s" + Number(match[1]) + "e" + Number(match[2]);

    match = value.match(
      new RegExp("^(?:" + episode + "|" + part + ")\\.?\\s*(\\d+)$"),
    );
    if (match) return POSITION_PREFIX + "e" + Number(match[1]);

    if (PILOT_WORDS.indexOf(value) !== -1) return POSITION_PREFIX + "first";
    return null;
  }

  /**
   * Index keys of ONE episode: its normalized name, the position its name means
   * (if any) and always its own position – so a row can be matched even when
   * the service and TMDB label the episode in different ways.
   */
  function episodeKeys(name, season, episode) {
    const keys = [];
    const normalized = normName(name);
    if (normalized) keys.push(normalized);
    const positional = positionKey(name);
    if (positional) keys.push(positional);
    if (Number.isInteger(season) && Number.isInteger(episode)) {
      keys.push(POSITION_PREFIX + "s" + season + "e" + episode);
      keys.push(POSITION_PREFIX + "e" + episode);
      // A series' pilot is its first episode, whatever it is called.
      if (season === 1 && episode === 1) keys.push(POSITION_PREFIX + "first");
    }
    return keys;
  }

  /**
   * Stores `value` under every key of `episodeKeys`. A key used by more than one
   * episode is remembered in `ambiguous` (and dropped by the caller afterwards),
   * so an ambiguous label/position can never resolve to a guessed episode.
   */
  function addEpisodeToIndex(index, ambiguous, keys, value) {
    for (const key of keys) {
      if (index.has(key)) {
        ambiguous.add(key);
        continue;
      }
      index.set(key, value);
    }
  }

  /**
   * Value for a NAME out of an episode index (`Map<key, value>`, built with
   * `addEpisodeToIndex`, see tmdb-site.js and matcher.js), or null.
   *
   *  1. the normalized name,
   *  2. the position the name means ("Pilot", "Folge 7", …),
   *  3. the single best fuzzy match – but only when it is clearly better than
   *     every other candidate.
   *
   * Nothing is ever guessed: steps 1/2 only hit what the index actually holds
   * (ambiguous ones were removed), and step 3 needs a unique close match.
   */
  function lookupName(index, name) {
    if (!index || !name) return null;
    const key = normName(name);
    if (!key) return null;
    if (index.has(key)) return index.get(key);

    const positional = positionKey(name);
    if (positional && index.has(positional)) return index.get(positional);

    let best = null;
    let bestScore = 0;
    let runnerUp = 0;
    for (const [candidate, value] of index) {
      if (candidate.indexOf(POSITION_PREFIX) === 0) continue;
      const score = nameSimilarity(key, candidate);
      if (score > bestScore) {
        runnerUp = bestScore;
        bestScore = score;
        best = value;
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }
    if (bestScore < FUZZY_MIN_SIMILARITY) return null;
    if (bestScore - runnerUp < FUZZY_MIN_MARGIN) return null;
    return best;
  }

  /**
   * ISO-8601 string for a date value. Never assume a `Date` instance survives
   * the message channel – it may already be a string or a number, so
   * `.toISOString()` is never called on the raw value.
   */
  function toIsoDateString(v) {
    if (v == null) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
    const date = new Date(v); // ISO-8601 string or numeric ms
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  /** ISO-8601 string that is `minutes` before `iso`, or null. */
  function subtractMinutes(iso, minutes) {
    if (iso == null) return null;
    const date = new Date(iso);
    if (isNaN(date.getTime())) return null;
    return new Date(date.getTime() - minutes * 60000).toISOString();
  }

  /** "season:episode" key for the per-episode maps. */
  function epKey(season, episode) {
    return Number(season) + ":" + Number(episode);
  }

  /** Whole seconds of an ISO date (tolerates server-side ms truncation). */
  function toEpochSeconds(iso) {
    if (iso == null) return null;
    const t = new Date(iso).getTime();
    return isNaN(t) ? null : Math.floor(t / 1000);
  }

  /** RFC 4122 v4 UUID (with a fallback for contexts without crypto.randomUUID). */
  function uuid() {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /**
   * Decodes the `username`/`type` claims out of a Watcharr JWT. The signature
   * is NOT verified – the token comes from the server we just logged in to and
   * is only used to show the user name.
   */
  function decodeJwtClaims(token) {
    try {
      const base64 = String(token)
        .split(".")[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      const json = decodeURIComponent(
        atob(padded)
          .split("")
          .map((ch) => "%" + ("00" + ch.charCodeAt(0).toString(16)).slice(-2))
          .join(""),
      );
      return JSON.parse(json) || {};
    } catch (_) {
      return {};
    }
  }

  globalThis.WatcharrUtil = {
    log,
    logErr,
    normTitle,
    normName,
    nameSimilarity,
    positionKey,
    episodeKeys,
    addEpisodeToIndex,
    lookupName,
    toIsoDateString,
    subtractMinutes,
    epKey,
    toEpochSeconds,
    uuid,
    decodeJwtClaims,
  };
})();
