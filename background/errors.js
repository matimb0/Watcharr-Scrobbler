/*
 * Error carrying a stable i18n code + params.
 *
 * The UI maps these codes to translation keys (options/options.js,
 * history/history.js), so extension-authored error text is localized instead of
 * being shown raw; `userParams` fills the placeholders of that text.
 */
"use strict";

/** Creates an Error with `userCode` / `userParams` attached. */
function createUserError(code, message, params) {
  const err = new Error(message);
  err.userCode = code;
  err.userParams = params || {};
  return err;
}

/** Converts a thrown Error into a message response (stable code + params). */
function toErrorResponse(err) {
  return {
    ok: false,
    error: (err && err.message) || String(err),
    errorCode: (err && err.userCode) || null,
    errorParams: (err && err.userParams) || null,
  };
}

globalThis.WatcharrErrors = {
  create: createUserError,
  toResponse: toErrorResponse,
};
