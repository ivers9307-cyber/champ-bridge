// Silence ant-plus-next's leftover debug print.
//
// WHERE THE STRAY `0` CAME FROM (2026-08-12): it is NOT our code. It is a
// forgotten debug statement inside the dependency, in `AntPlusScanner.decodeData`:
//
//   node_modules/ant-plus-next/dist/index.mjs  (minified, offset ~24702)
//   node_modules/ant-plus-next/dist/index.cjs  (minified, offset ~24431)
//
//     decodeData(view) {
//       ...
//       const deviceId = view.getUint16(BUFFER_INDEX_EXT_MSG_BEGIN + 1, true)
//       console.log(this.deviceId)          // ← this
//       if (view.getUint8(...) === this.deviceType()) { ... }
//     }
//
// `decodeData` runs once per received ANT+ page. In SCANNING mode the scanner
// pins itself to the wildcard channel and sets `this.deviceId = 0`, so it
// prints a bare `0` — with straps in the room that is ~4 lines per strap per
// second, forever. It drowned the journal during the incident (and contributed
// to the 41s of CPU the wedged process had burned), which is why we filter it.
//
// We can't patch node_modules (`npm ci --omit=dev` on the Pi restores it every
// deploy) and the print is unreachable from any option the library exposes. So
// we install ONE narrow console.log guard: swallow calls whose arguments are
// exactly a single numeric `0`, and account for them at debug level instead.
//
// Why that is safe: our own logger (log.js) always calls console.log with a
// STRING first argument — a JSON line in prod, `[module] msg` in dev. It can
// never produce `console.log(0)`. Nothing else in the bridge logs a bare
// number. Every other console.log — including ant-plus-next's genuinely useful
// "wrong message format" and "Unhandled event:" lines — passes through
// untouched.

import { logDebug, logInfo } from './log.js'

let installed = false
let original = null
let suppressed = 0

/**
 * Pure: is this console.log invocation the dependency's stray scanner print?
 * Exactly one argument, and it is the number 0. Deliberately strict — `'0'`,
 * `0` alongside other args, and any other number all pass through.
 *
 * @param {any[]} args
 * @returns {boolean}
 */
export function isStrayScannerLog(args) {
  return Array.isArray(args) && args.length === 1 && typeof args[0] === 'number' && args[0] === 0
}

/** How many stray prints we've swallowed since install. */
export function suppressedCount() {
  return suppressed
}

/**
 * Install the filter. Idempotent — safe to call on every ANT+ (re)open.
 * Only meaningful in real-hardware mode; the fake adapter never loads
 * ant-plus-next.
 */
export function installAntLogFilter() {
  if (installed) return false
  installed = true
  original = console.log
  // eslint-disable-next-line no-console
  console.log = (...args) => {
    if (isStrayScannerLog(args)) {
      suppressed += 1
      // Cheap breadcrumb at debug level so the noise is still *countable*
      // without being printed: one line per 10k pages, not one per page.
      if (suppressed % 10_000 === 0) {
        logDebug('ant', 'suppressed ant-plus-next stray scanner prints', { count: suppressed })
      }
      return
    }
    original(...args)
  }
  logInfo('ant', 'filtering ant-plus-next stray scanner debug print (bare 0)')
  return true
}

/** Restore the original console.log. Used by tests. */
export function uninstallAntLogFilter() {
  if (!installed) return false
  // eslint-disable-next-line no-console
  console.log = original
  installed = false
  original = null
  suppressed = 0
  return true
}
