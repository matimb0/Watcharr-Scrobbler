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
  // Guard, but versioned: a NEWER probe (after an extension update) must be
  // able to take over in a page that still runs the old one – Firefox keeps
  // the already loaded scripts of an open tab otherwise.
  var PROBE_VERSION = 2;
  if (window.__watcharrNetflixProbeVersion__ >= PROBE_VERSION) return;
  window.__watcharrNetflixProbeVersion__ = PROBE_VERSION;

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

  /*
   * Metadata requests on behalf of the content script (isolated world).
   *
   * Netflix answers its member API (…/nq/website/memberapi/…) with 401 unless
   * the request comes from the page itself, so the fetch runs HERE – same
   * origin, same cookies and the same headers as Netflix' own app.
   *
   * Both directions carry a JSON STRING in `detail`, because Chrome does not
   * clone objects from a content script into the page (and a string needs no
   * conversion in either browser).
   */
  var METADATA_EVENT = "watcharr:netflix:metadata";

  // Only the routes the extension itself uses are fetched: this bridge lives in
  // the page's world, so it must never become a general same-origin request
  // proxy for whatever script happens to be running there.
  var METADATA_URL_PREFIXES = [
    "https://www.netflix.com/nq/website/memberapi/",
    "https://www.netflix.com/api/shakti/",
  ];

  function allowedMetadataUrl(url) {
    if (typeof url !== "string") return false;
    for (var i = 0; i < METADATA_URL_PREFIXES.length; i++) {
      if (url.indexOf(METADATA_URL_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  function fetchMetadata(rawDetail) {
    var request = null;
    try {
      request = JSON.parse(rawDetail);
    } catch (e) {
      return;
    }
    var id = request && request.id;
    var url = request && request.url;
    if (!id || !allowedMetadataUrl(url)) return;

    fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then(function (resp) {
        return resp.text().then(function (text) {
          return { ok: resp.ok, status: resp.status, text: text };
        });
      })
      .catch(function (err) {
        return { ok: false, status: 0, error: String(err) };
      })
      .then(function (result) {
        document.dispatchEvent(
          new CustomEvent(METADATA_EVENT + ":" + id, {
            detail: JSON.stringify(result),
          }),
        );
      });
  }

  document.addEventListener(
    METADATA_EVENT,
    function (e) {
      fetchMetadata(e.detail);
    },
    false,
  );

  setInterval(dispatch, 500);
  dispatch();
})();
