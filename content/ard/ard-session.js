/*
 * ARD Mediathek – the user's own login session.
 *
 * ARD keeps the play history in its own Firebase project (`ardmt-prod`), and
 * the ID token that may read it lives in the Firebase Auth store of the ARD
 * page: the IndexedDB `firebaseLocalStorageDb` (store `firebaseLocalStorage`,
 * record `firebase:authUser:<apiKey>:[DEFAULT]`). The config (API key, project
 * id) is server-rendered into the page as `#env`.
 *
 * Both are read here, in the content script: they belong to the page's origin,
 * so this is the same identity the ARD web app itself uses – no ARD password,
 * no separate login, no API key of our own.
 *
 * The token is deliberately NOT refreshed here. The ARD page keeps its own
 * session alive while it is open (Firebase refreshes on a timer), so an
 * expired token means the page has not been used for a while – asking the user
 * to reload it is both simpler and safer than minting tokens behind the SDK's
 * back.
 */
"use strict";

(function () {
  const DB_NAME = "firebaseLocalStorageDb";
  const STORE_NAME = "firebaseLocalStorage";
  const KEY_PATH = "fbase_key";
  // Version the Firebase SDK itself opens this database with (see its
  // `indexedDB.open("firebaseLocalStorageDb", 1)`).
  const DB_VERSION = 1;
  const ENV_ELEMENT_ID = "env";
  // A token that expires within this window counts as expired.
  const EXPIRY_MARGIN_MS = 60 * 1000;

  /** The page's server-rendered config (`#env`), or null. */
  function readEnv() {
    const el = document.getElementById(ENV_ELEMENT_ID);
    if (!el || !el.textContent) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (_) {
      return null;
    }
  }

  /**
   * Opens the Firebase Auth database and returns its records.
   *
   * The store is created when it is missing, exactly like the Firebase SDK
   * does it – a browser that never logged in to ARD then simply reports no
   * session instead of leaving a database behind that the page cannot use.
   */
  function readRecords() {
    return new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (_) {
        return resolve([]); // storage unavailable (private mode, blocked)
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: KEY_PATH });
        }
      };
      request.onerror = () => resolve([]);
      request.onblocked = () => resolve([]);
      request.onsuccess = () => {
        const db = request.result;
        let getAll;
        try {
          const store = db
            .transaction(STORE_NAME, "readonly")
            .objectStore(STORE_NAME);
          getAll = store.getAll();
        } catch (_) {
          db.close();
          return resolve([]);
        }
        getAll.onerror = () => {
          db.close();
          resolve([]);
        };
        getAll.onsuccess = () => {
          const records = getAll.result || [];
          db.close();
          resolve(records);
        };
      };
    });
  }

  /** True when the record describes a signed-in ARD/Firebase user. */
  function isUserRecord(record) {
    const user = record && record.value;
    return !!(
      user &&
      user.uid &&
      user.stsTokenManager &&
      user.stsTokenManager.accessToken
    );
  }

  /**
   * The record of the signed-in user. Several projects can share this
   * database, so a record for the page's own API key wins; without a readable
   * `#env` the first usable record is taken.
   */
  function pickUserRecord(records, apiKey) {
    const users = records.filter(isUserRecord);
    if (!users.length) return null;
    if (apiKey) {
      const key = ":" + apiKey + ":";
      const match = users.find(
        (r) => typeof r.fbase_key === "string" && r.fbase_key.includes(key),
      );
      if (match) return match;
    }
    return users[0];
  }

  /** Session of the signed-in user, or null when there is none. */
  async function read() {
    const env = readEnv();
    const firebase = (env && env.FIREBASE) || {};
    const records = await readRecords();
    const record = pickUserRecord(records, firebase.apiKey);
    if (!record) return null;

    const user = record.value;
    const tokens = user.stsTokenManager || {};
    return {
      uid: String(user.uid),
      idToken: String(tokens.accessToken || ""),
      // Milliseconds since epoch, as the SDK stores it.
      expiresAt: Number(tokens.expirationTime) || 0,
      email: user.email || "",
      name: user.displayName || "",
      projectId: firebase.projectId || "",
      apiKey: firebase.apiKey || "",
    };
  }

  /** An error the history page can turn into a localized hint. */
  function sessionError(code, message) {
    const err = new Error(message);
    err.userCode = code;
    return err;
  }

  /**
   * Current session, ready to use. Throws with a stable `userCode` when the
   * user is not logged in to ARD or the stored token has expired.
   */
  async function get() {
    const session = await read();
    if (!session || !session.idToken) {
      throw sessionError(
        "ard_not_logged_in",
        "No ARD Mediathek login found. Please log in to the ARD Mediathek in this browser and reload the page.",
      );
    }
    if (
      session.expiresAt &&
      Date.now() > session.expiresAt - EXPIRY_MARGIN_MS
    ) {
      throw sessionError(
        "ard_session_expired",
        "The ARD Mediathek session has expired. Please reload the ARD Mediathek page and try again.",
      );
    }
    return session;
  }

  globalThis.WatcharrArdSession = { get, read };
})();
