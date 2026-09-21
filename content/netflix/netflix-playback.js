/*
 * Netflix – playback detection.
 *
 * Netflix' player state is not readable from the isolated world, so
 * content/netflix/netflix-probe.js (MAIN world) reports it through the
 * CustomEvent `watcharr:netflix:playback`; that report is collected here.
 *
 * `getSession()` exposes the account information the history needs (the probe
 * reads it from the same place the player state comes from).
 */
"use strict";

(function () {
  // Last report of the probe.
  const lastProbe = { sessions: [], session: null };

  document.addEventListener("watcharr:netflix:playback", (e) => {
    const d = e.detail || {};
    lastProbe.sessions = Array.isArray(d.sessions) ? d.sessions : [];
    if (d.session) lastProbe.session = d.session;
  });

  /** Netflix video id from the /watch/<id> URL, or null. */
  function getVideoId() {
    const m = window.location.pathname.match(/\/watch\/(\d+)/);
    return m ? m[1] : null;
  }

  /**
   * Playback info to use:
   *   1. the probe session whose videoId matches the /watch/<id> URL (this is
   *      what keeps a trailer playing next to the episode out of the way),
   *   2. otherwise the page's <video> element – but only while no OTHER
   *      session is playing.
   */
  function pickPlayback(videoId) {
    const match = lastProbe.sessions.find(
      (s) => s.videoId && String(s.videoId) === videoId,
    );
    if (match) return match;

    const foreignActive = lastProbe.sessions.some(
      (s) => s.playing && s.videoId && String(s.videoId) !== videoId,
    );
    if (foreignActive) return null;

    return WatcharrPlayback.readPlayback();
  }

  /** Session of the logged-in account from the probe report, or null. */
  function getSession() {
    return lastProbe.session && lastProbe.session.userGuid
      ? lastProbe.session
      : null;
  }

  globalThis.WatcharrNetflixPlayback = {
    getVideoId,
    pickPlayback,
    getSession,
  };
})();
