// Minimal structured logger. JSON in prod (so journald can ship to
// any aggregator), prose in dev for grep'ability. Mirrors un1t-crm's
// log.js shape so the format is consistent across both sides of the
// wire.

import { config } from './config.js'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[config.logLevel] || LEVELS.info
const isProd = process.env.NODE_ENV === 'production'

function emit(level, module, msg, meta) {
  if (LEVELS[level] < threshold) return
  const m = meta && typeof meta === 'object' ? { ...meta } : {}
  if (m.err instanceof Error) m.err = { name: m.err.name, message: m.err.message, stack: m.err.stack }

  if (isProd) {
    const entry = { ts: new Date().toISOString(), level, module, msg, ...m }
    // eslint-disable-next-line no-console
    ;(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(JSON.stringify(entry))
    return
  }
  const head = `[${module}] ${msg}`
  // eslint-disable-next-line no-console
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (Object.keys(m).length === 0) fn(head)
  else fn(head, m)
}

export const logDebug = (module, msg, meta) => emit('debug', module, msg, meta)
export const logInfo  = (module, msg, meta) => emit('info',  module, msg, meta)
export const logWarn  = (module, msg, meta) => emit('warn',  module, msg, meta)
export const logError = (module, msg, meta) => emit('error', module, msg, meta)
