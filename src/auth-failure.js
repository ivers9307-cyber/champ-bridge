// Pure 401/403 "zombie" detector for the API client.
//
// A dead bearer token (rotated without updating the Pi, or revoked)
// makes every request return 401/403 forever. The old client just
// warn-looped on that — the bridge stayed "up" but relayed nothing, a
// silent zombie no one noticed. We now count CONSECUTIVE auth failures
// and, past a threshold, tell the caller to exit non-zero so systemd
// restarts it and the failure surfaces in the journal.
//
// A network error / 5xx / any success must RESET the counter, so a
// normal token rotation (which pairs with a CRM-side dual-token grace
// window) doesn't trip this — only a genuinely dead token, which fails
// every consecutive call, does.
//
// This is the pure state machine; api.js owns the mutable counter and
// the actual process.exit.

// Consecutive 401/403s before we treat the token as dead and bail.
export const MAX_CONSECUTIVE_AUTH_FAILURES = 3

/**
 * Is this response status an auth failure (as opposed to a network
 * error, a 5xx, or a normal 2xx/4xx-not-auth)?
 * @param {number|null|undefined} statusCode
 * @returns {boolean}
 */
export function isAuthFailure(statusCode) {
  return statusCode === 401 || statusCode === 403
}

/**
 * Fold one request outcome into the consecutive-auth-failure counter.
 *
 * @param {number} current                 consecutive count so far
 * @param {{ statusCode?: number|null, networkError?: boolean }} outcome
 * @param {number} [threshold=MAX_CONSECUTIVE_AUTH_FAILURES]
 * @returns {{ count: number, exit: boolean }}
 *   count → new consecutive count; exit → true once the threshold is
 *   reached (caller should log ERROR + exit non-zero).
 */
export function nextAuthFailureState(current, outcome, threshold = MAX_CONSECUTIVE_AUTH_FAILURES) {
  // A network error can't distinguish a dead token from a dead link —
  // it must NOT count toward the auth-zombie threshold. Leave the
  // counter untouched so a flaky-WiFi burst doesn't look like a bad
  // token, but a real 401 streak interrupted by the odd network blip
  // still reaches the threshold.
  if (outcome && outcome.networkError) {
    return { count: current, exit: false }
  }
  if (outcome && isAuthFailure(outcome.statusCode)) {
    const count = current + 1
    return { count, exit: count >= threshold }
  }
  // Any non-auth response (2xx success, or a non-auth 4xx/5xx) means
  // the token is being accepted → reset.
  return { count: 0, exit: false }
}
