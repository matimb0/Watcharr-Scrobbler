/*
 * Netflix – probe (runs in the MAIN world of the Netflix page).
 *
 * Loaded by content/netflix/netflix-inject.js as an external <script src>
 * (not inline text – Netflix' CSP blocks inline scripts but allows the
 * extension's own origin), so it runs where Netflix' internal player state
 * lives. It reports that state back to the content script (isolated world) via
 * a CustomEvent on `document`.
 */
(function () {
  if (window.__watcharrNetflixProbeInstalled__) return;
  window.__watcharrNetflixProbeInstalled__ = true;

  /** Player state of all active sessions, or [] when unavailable. */
  function readPlayback() {
    try {
      var appState =
        window.netflix &&
        window.netflix.appContext &&
        window.netflix.appContext.state &&
        window.netflix.appContext.state.playerApp &&
        window.netflix.appContext.state.playerApp.getState();
      if (!appState || !appState.videoPlayer) return [];
      var sessions = appState.videoPlayer.playbackStateBySessionId;
      if (!sessions) return [];
      return Object.keys(sessions)
        .map(function (k) {
          var s = sessions[k];
          if (!s || !s.duration || s.duration <= 0) return null;
          return {
            currentTime: s.currentTime || 0,
            duration: s.duration,
            progress: Math.min(100, (s.currentTime / s.duration) * 100),
            isPaused: !!s.paused,
            playing: !!s.playing,
            videoId: s.videoId,
          };
        })
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  /** Session info (authURL, userGuid, BUILD_IDENTIFIER) – needed for the
   *  Netflix history (viewing activity). */
  function readSession() {
    try {
      var r =
        window.netflix &&
        window.netflix.reactContext &&
        window.netflix.reactContext.models;
      var userInfo = r && r.userInfo && r.userInfo.data;
      if (!userInfo) return null;
      var serverDefs = r && r.serverDefs && r.serverDefs.data;
      var s = {
        authUrl: userInfo.authURL || null,
        profileName: userInfo.name || null,
        userGuid: userInfo.userGuid || null,
      };
      if (serverDefs && serverDefs.BUILD_IDENTIFIER) {
        s.buildIdentifier = serverDefs.BUILD_IDENTIFIER;
      }
      return s;
    } catch (e) {
      return null;
    }
  }

  function dispatch() {
    var data = {
      sessions: readPlayback(),
      session: readSession(),
    };
    document.dispatchEvent(
      new CustomEvent("watcharr:netflix:playback", { detail: data }),
    );
  }

  setInterval(dispatch, 500);
  dispatch();
})();
