/*
 * Jellyfin – what is playing right now.
 *
 * The authoritative source is the server session (`GET /Sessions`,
 * NowPlayingItem). Because it only refreshes the position every few seconds,
 * the page's <video> element is used for the precise position whenever both
 * agree on the item's runtime.
 */
"use strict";

(function () {
  // The server refreshes a session's position only every few seconds, so the
  // (cheap, same-origin) /Sessions call runs less often than the DOM poll.
  const SESSION_POLL_INTERVAL_MS = 2000;
  // Jellyfin reports durations and positions in .NET ticks (100 ns).
  const TICKS_PER_SECOND = 10000000;

  const nowPlaying = { at: 0, session: null };

  /** True for the session of a Jellyfin *web* client (see file header). */
  function isWebClientSession(session) {
    return /jellyfin\s*web/i.test((session && session.Client) || "");
  }

  /**
   * Session of this user's web client that has a NowPlayingItem, or null.
   * Cached for SESSION_POLL_INTERVAL_MS; `force` skips the cache.
   */
  async function getNowPlaying(force) {
    const login = WatcharrJellyfinAuth.getLogin();
    if (!login.ok) return null;

    const now = Date.now();
    if (!force && now - nowPlaying.at < SESSION_POLL_INTERVAL_MS) {
      return nowPlaying.session;
    }

    const sessions = await WatcharrJellyfinAuth.jellyfinJson("/Sessions");
    nowPlaying.at = Date.now();

    let found = null;
    if (Array.isArray(sessions)) {
      const mine = sessions.filter(
        (s) =>
          s &&
          s.NowPlayingItem &&
          String(s.UserId || "") === login.userId &&
          isWebClientSession(s),
      );
      // A playing session wins over a merely paused one.
      const playing = mine.filter(
        (s) => !(s.PlayState && s.PlayState.IsPaused),
      );
      found = playing[0] || mine[0] || null;
    }
    nowPlaying.session = found;
    return found;
  }

  /**
   * The player's <video> element. Jellyfin Web keeps one element around while
   * something plays; preview/hover videos never play, so preferring a playing
   * element is a reliable discriminator.
   */
  function readVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    let idle = null;
    for (const video of videos) {
      if (!isFinite(video.duration) || video.duration <= 0) continue;
      if (!video.paused && !video.ended) return video;
      if (!idle) idle = video;
    }
    return idle;
  }

  function readPlayback() {
    return WatcharrPlayback.playbackFromVideo(readVideo());
  }

  /** Playback state derived from the server session (no <video> available). */
  function playbackFromSession(session) {
    const item = session && session.NowPlayingItem;
    const playState = session && session.PlayState;
    if (!item || !playState) return null;

    const durationTicks = Number(item.RunTimeTicks || 0);
    if (!durationTicks) return null;

    const duration = durationTicks / TICKS_PER_SECOND;
    const currentTime = Number(playState.PositionTicks || 0) / TICKS_PER_SECOND;
    return {
      currentTime,
      duration,
      progress: Math.min(100, (currentTime / duration) * 100),
      isPaused: !!playState.IsPaused,
      playing: !playState.IsPaused,
      ended: false,
    };
  }

  /**
   * Combines the DOM playback state (precise, updated every frame) with the
   * session state (authoritative). The DOM value is only trusted when both
   * agree on the runtime – otherwise an unrelated <video> element would have
   * been picked up.
   */
  function resolvePlayback(session) {
    const fromApi = playbackFromSession(session);
    const fromDom = readPlayback();
    if (!fromDom) return fromApi;
    if (!fromApi) return fromDom;
    const ratio =
      fromApi.duration > 0 ? fromDom.duration / fromApi.duration : 1;
    return ratio > 0.9 && ratio < 1.1 ? fromDom : fromApi;
  }

  /** Forgets the cached session, so the next call queries the server again. */
  function resetSession() {
    nowPlaying.session = null;
    nowPlaying.at = 0;
  }

  globalThis.WatcharrJellyfinPlayback = {
    getNowPlaying,
    resetSession,
    readPlayback,
    resolvePlayback,
  };
})();
