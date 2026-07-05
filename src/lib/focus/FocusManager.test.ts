import { describe, expect, test } from 'bun:test'
import { FocusManager } from './FocusManager.js'
import type { FocusKey } from './types.js'

function key(name: string, mods: Partial<Pick<FocusKey, 'ctrl' | 'shift' | 'meta'>> = {}): FocusKey & { stopped: boolean } {
  const k = {
    name,
    ctrl: mods.ctrl ?? false,
    shift: mods.shift ?? false,
    meta: mods.meta ?? false,
    stopped: false,
    stopPropagation: () => {
      k.stopped = true
    },
  }
  return k
}

function zone(id: string, order: number, extra: Record<string, unknown> = {}) {
  return { id, order, ...extra }
}

describe('tab ring', () => {
  test('tab cycles enabled zones in order; shift+tab reverses', () => {
    const m = new FocusManager()
    m.registerZone('root', zone('detail', 1))
    m.registerZone('root', zone('list', 0))
    m.registerZone('root', zone('logs', 2))
    // first registered zone became active, then order governs the ring
    m.focusZone('list')

    const t1 = key('tab')
    m.handleKey(t1)
    expect(m.getSnapshot().activeZoneId).toBe('detail')
    expect(t1.stopped).toBe(true)

    m.handleKey(key('tab'))
    expect(m.getSnapshot().activeZoneId).toBe('logs')
    m.handleKey(key('tab'))
    expect(m.getSnapshot().activeZoneId).toBe('list') // wraps

    m.handleKey(key('tab', { shift: true }))
    expect(m.getSnapshot().activeZoneId).toBe('logs') // reverse wrap
  })

  test('tab passes through when the top layer has no zones', () => {
    const m = new FocusManager()
    const t = key('tab')
    m.handleKey(t)
    expect(t.stopped).toBe(false)
  })
})

describe('zone lifecycle', () => {
  test('before any explicit focus, the lowest-order zone is active regardless of registration order', () => {
    const m = new FocusManager()
    // Children register before parents in React — a higher-order zone can register first.
    m.registerZone('root', zone('sidebar', 3))
    m.registerZone('root', zone('list', 0))
    m.registerZone('root', zone('detail', 1))
    expect(m.getSnapshot().activeZoneId).toBe('list')
  })

  test('unregistering the active zone restores the previously active zone', () => {
    const m = new FocusManager()
    m.registerZone('root', zone('list', 0))
    m.registerZone('root', zone('detail', 1))
    m.registerZone('root', zone('logs', 4, { fallbackZone: 'list' }))
    m.focusZone('detail')
    m.focusZone('logs')

    // Restore to where focus came from (detail), NOT the declared fallback (list).
    m.unregisterZone('root', 'logs')
    expect(m.getSnapshot().activeZoneId).toBe('detail')
  })

  test('unregistering falls back to fallbackZone when the prior active zone is also gone', () => {
    const m = new FocusManager()
    m.registerZone('root', zone('list', 0))
    m.registerZone('root', zone('detail', 1))
    m.registerZone('root', zone('sidebar', 3, { fallbackZone: 'detail' }))
    m.focusZone('sidebar') // prior active = 'list' (initial)
    m.unregisterZone('root', 'list') // prior active now gone
    m.unregisterZone('root', 'sidebar')
    expect(m.getSnapshot().activeZoneId).toBe('detail') // fallbackZone, not the stale 'list'
  })

  test('unregistering falls back to first in ring when neither prior nor fallback survive', () => {
    const m = new FocusManager()
    m.registerZone('root', zone('list', 0))
    m.registerZone('root', zone('detail', 1))
    m.registerZone('root', zone('sidebar', 3, { fallbackZone: 'gone' }))
    m.focusZone('sidebar')
    m.unregisterZone('root', 'list') // prior active gone; fallbackZone 'gone' never existed
    m.unregisterZone('root', 'sidebar')
    expect(m.getSnapshot().activeZoneId).toBe('detail') // lowest-order survivor
  })

  test('focusZone on a not-yet-registered zone activates it when it registers', () => {
    const m = new FocusManager()
    m.registerZone('root', zone('list', 0))
    m.focusZone('composer')
    expect(m.getSnapshot().activeZoneId).toBe('list')

    m.registerZone('root', zone('composer', 2))
    expect(m.getSnapshot().activeZoneId).toBe('composer')
  })

  test('unknown ids are tolerated', () => {
    const m = new FocusManager()
    m.unregisterZone('nope', 'x')
    m.unregisterZone('root', 'x')
    m.popLayer('nope')
    m.updateZone('root', 'x', { order: 5 })
    expect(m.getSnapshot().topLayerId).toBe('root')
  })

  test('registration is idempotent', () => {
    const m = new FocusManager()
    m.registerZone('root', zone('list', 0))
    m.registerZone('root', zone('list', 0))
    expect(m.getSnapshot().zoneOrder).toEqual(['list'])
  })
})

describe('layers', () => {
  test('push silences lower zones; pop restores the lower layer focus', () => {
    const m = new FocusManager()
    m.registerZone('root', zone('list', 0))
    m.registerZone('root', zone('detail', 1))
    m.focusZone('detail')

    m.pushLayer({ id: 'modal' })
    expect(m.isZoneActive('root', 'detail')).toBe(false)
    expect(m.getSnapshot().topLayerId).toBe('modal')

    // keys don't reach root zones while the modal is on top
    let zoneKeys = 0
    m.registerZoneKeyHandler('root', 'detail', () => {
      zoneKeys += 1
      return true
    })
    m.handleKey(key('up'))
    expect(zoneKeys).toBe(0)

    m.popLayer('modal')
    expect(m.isZoneActive('root', 'detail')).toBe(true)
    m.handleKey(key('up'))
    expect(zoneKeys).toBe(1)
  })

  test('zones registered before their layer is pushed are drained on push', () => {
    const m = new FocusManager()
    m.registerZone('modal', zone('form', 0))
    m.pushLayer({ id: 'modal' })
    expect(m.getSnapshot().activeZoneId).toBe('form')
  })

  test('initialZone wins over registration order', () => {
    const m = new FocusManager()
    m.pushLayer({ id: 'modal', initialZone: 'b' })
    m.registerZone('modal', zone('a', 0))
    expect(m.getSnapshot().activeZoneId).toBe('a')
    m.registerZone('modal', zone('b', 1))
    expect(m.getSnapshot().activeZoneId).toBe('b')
  })
})

describe('dispatch precedence', () => {
  test('ctrl+c is never touched', () => {
    const m = new FocusManager()
    let ran = false
    m.registerZone('root', zone('z', 0, { onKey: () => ((ran = true), true) }))
    const k = key('c', { ctrl: true })
    m.handleKey(k)
    expect(ran).toBe(false)
    expect(k.stopped).toBe(false)
  })

  test('zone onKey runs before zone key handlers, layer handlers, and shortcuts', () => {
    const m = new FocusManager()
    const calls: string[] = []
    m.registerZone('root', zone('z', 0, {
      onKey: (k: FocusKey) => {
        calls.push('zone')
        return k.name === 'a'
      },
    }))
    m.registerZoneKeyHandler('root', 'z', (k) => {
      calls.push('zoneHandler')
      return k.name === 'b'
    })
    m.registerLayerKeyHandler('root', (k) => {
      calls.push('layer')
      return k.name === 'd'
    })
    m.registerShortcut('root', { id: 's', keys: ['e'], run: () => calls.push('shortcut') })

    m.handleKey(key('a'))
    expect(calls).toEqual(['zone'])
    calls.length = 0

    m.handleKey(key('b'))
    expect(calls).toEqual(['zone', 'zoneHandler'])
    calls.length = 0

    m.handleKey(key('d'))
    expect(calls).toEqual(['zone', 'zoneHandler', 'layer'])
    calls.length = 0

    m.handleKey(key('e'))
    expect(calls).toEqual(['zone', 'zoneHandler', 'layer', 'shortcut'])
  })

  test('unclaimed keys are not stopped (fall through to the focused renderable)', () => {
    const m = new FocusManager()
    m.registerZone('root', zone('z', 0))
    const k = key('x')
    m.handleKey(k)
    expect(k.stopped).toBe(false)
  })
})

describe('escape chain', () => {
  test('zone onEscape → fallbackZone → layer onEscape', () => {
    const m = new FocusManager()
    let dismissed = 0
    m.pushLayer({ id: 'modal', onEscape: () => ((dismissed += 1), true) })
    m.registerZone('modal', zone('a', 0))
    m.registerZone('modal', zone('b', 1, { fallbackZone: 'a' }))

    // zone with fallback: escape focuses the fallback, not the layer dismiss
    m.focusZone('b')
    m.handleKey(key('escape'))
    expect(m.getSnapshot().activeZoneId).toBe('a')
    expect(dismissed).toBe(0)

    // zone without fallback: layer dismiss
    m.handleKey(key('escape'))
    expect(dismissed).toBe(1)

    // zone onEscape wins over everything
    m.updateZone('modal', 'a', { onEscape: () => true })
    m.handleKey(key('escape'))
    expect(dismissed).toBe(1)
  })

  test('escape on the base layer with no handlers falls through unstopped', () => {
    const m = new FocusManager()
    m.registerZone('root', zone('list', 0))
    const k = key('escape')
    m.handleKey(k)
    expect(k.stopped).toBe(false)
  })

  test('an unclaimed escape still reaches a matching layer shortcut', () => {
    const m = new FocusManager()
    let closed = false
    m.registerZone('root', zone('list', 0))
    m.registerShortcut('root', { id: 'close', keys: ['escape'], run: () => (closed = true) })
    const k = key('escape')
    m.handleKey(k)
    expect(closed).toBe(true)
    expect(k.stopped).toBe(true)
  })
})

describe('input zones and shortcuts', () => {
  test('input zone suppresses non-reserve shortcuts; reserve still fires', () => {
    const m = new FocusManager()
    const fired: string[] = []
    m.registerZone('root', zone('composer', 0, { kind: 'input' }))
    m.registerShortcut('root', { id: 'l', keys: ['l'], run: () => fired.push('l') })
    m.registerShortcut('root', { id: 'r', keys: ['x'], run: () => fired.push('x'), reserve: true })

    const l = key('l')
    m.handleKey(l)
    expect(fired).toEqual([])
    expect(l.stopped).toBe(false) // falls through to the textarea

    m.handleKey(key('x'))
    expect(fired).toEqual(['x'])
  })

  test('shortcuts fire for nav zones and stop propagation', () => {
    const m = new FocusManager()
    const fired: string[] = []
    m.registerZone('root', zone('list', 0))
    m.registerShortcut('root', { id: 'q', keys: ['q', 'Q'], run: () => fired.push('q') })
    const k = key('Q')
    m.handleKey(k)
    expect(fired).toEqual(['q'])
    expect(k.stopped).toBe(true)
  })

  test('shortcut key matching is case-insensitive', () => {
    const m = new FocusManager()
    let n = 0
    m.registerZone('root', zone('list', 0))
    m.registerShortcut('root', { id: 'q', keys: ['q'], run: () => (n += 1) })
    m.handleKey(key('q'))
    m.handleKey(key('Q'))
    expect(n).toBe(2)
  })

  test('unregistering a shortcut stops it firing', () => {
    const m = new FocusManager()
    const fired: string[] = []
    m.registerZone('root', zone('list', 0))
    const off = m.registerShortcut('root', { id: 'q', keys: ['q'], run: () => fired.push('q') })
    off()
    m.handleKey(key('q'))
    expect(fired).toEqual([])
  })

  test('updateShortcut patches metadata in place without dropping the binding', () => {
    const m = new FocusManager()
    let n = 0
    m.registerZone('root', zone('list', 0))
    m.registerShortcut('root', { id: 'logs', keys: ['l'], run: () => (n += 1), label: 'logs' })
    m.updateShortcut('root', 'logs', { label: 'hide logs' })
    expect(m.getSnapshot().shortcuts.find((s) => s.id === 'logs')?.label).toBe('hide logs')
    m.handleKey(key('l'))
    expect(n).toBe(1) // still bound after the patch
  })
})

describe('snapshot input kind', () => {
  test('activeZoneKind reflects the active zone', () => {
    const m = new FocusManager()
    m.registerZone('root', zone('list', 0))
    m.registerZone('root', zone('composer', 2, { kind: 'input' }))
    expect(m.getSnapshot().activeZoneKind).toBe(null) // list has no kind
    m.focusZone('composer')
    expect(m.getSnapshot().activeZoneKind).toBe('input')
  })
})

describe('snapshot', () => {
  test('subscribe fires on mutation; snapshot identity changes', () => {
    const m = new FocusManager()
    let notified = 0
    m.subscribe(() => (notified += 1))
    const before = m.getSnapshot()
    m.registerZone('root', zone('list', 0))
    expect(notified).toBeGreaterThan(0)
    expect(m.getSnapshot()).not.toBe(before)
    expect(m.getSnapshot().zoneOrder).toEqual(['list'])
  })
})
