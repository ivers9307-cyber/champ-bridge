// Strap source — the dual-protocol orchestrator.
//
// Instantiates the ANT+ adapter (primary) and the BLE adapter
// (fallback), merges their event streams, and presents index.js with
// a single adapter-shaped interface: { on, start, stop,
// getCurrentStraps }.
//
// No cross-protocol de-dup is needed. Device keys are namespaced by
// protocol (`ant:` vs `ble:`), so a dual-band strap broadcasting on
// both shows up as two distinct keys. The bridge faithfully reports
// both; the server's registration model (a member registers exactly
// one device_key) decides which one routes to a session — the other
// is simply an unregistered strap and is dropped. Keeping the bridge
// dumb and the server smart is deliberate.
//
// Which adapters run is config-driven (ENABLE_ANT / ENABLE_BLE) so a
// studio can disable a protocol without a code change.

import { EventEmitter } from 'node:events'
import { config } from './config.js'
import { logInfo, logWarn } from './log.js'
import { createAntAdapter } from './ant.js'
import { createBleAdapter } from './ble.js'

const FORWARDED_EVENTS = ['strap-sample', 'strap-seen', 'strap-lost']

class StrapSource extends EventEmitter {
  constructor() {
    super()
    this.adapters = []
    if (config.enableAnt) this.adapters.push({ name: 'ant', adapter: createAntAdapter() })
    if (config.enableBle) this.adapters.push({ name: 'ble', adapter: createBleAdapter() })
  }

  async start() {
    if (this.adapters.length === 0) {
      logWarn('strap-source', 'no protocols enabled — bridge will read nothing')
      return
    }
    logInfo('strap-source', 'starting protocols', {
      protocols: this.adapters.map((a) => a.name),
    })
    for (const { adapter } of this.adapters) {
      for (const evt of FORWARDED_EVENTS) {
        adapter.on(evt, (payload) => this.emit(evt, payload))
      }
    }
    // Start each adapter independently — one protocol failing (e.g.
    // no ANT+ stick plugged in) must not stop the other.
    await Promise.all(
      this.adapters.map(({ name, adapter }) =>
        adapter.start().catch((err) => {
          logWarn('strap-source', `${name} adapter failed to start`, { err })
        }),
      ),
    )
  }

  async stop() {
    await Promise.all(
      this.adapters.map(({ name, adapter }) =>
        adapter.stop().catch((err) => {
          logWarn('strap-source', `${name} adapter failed to stop`, { err })
        }),
      ),
    )
  }

  getCurrentStraps() {
    const all = []
    for (const { adapter } of this.adapters) {
      try {
        all.push(...adapter.getCurrentStraps())
      } catch {
        // A misbehaving adapter must not break the scan snapshot.
      }
    }
    return all
  }
}

export function createStrapSource() {
  return new StrapSource()
}
