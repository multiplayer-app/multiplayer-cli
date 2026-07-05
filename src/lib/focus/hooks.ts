import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import type { KeyEvent, ScrollBoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { FocusContext, LayerContext } from './FocusProvider.js'
import type { FocusHint, FocusKey, FocusSnapshot, ShortcutConfig, ZoneKind } from './types.js'

const noopSubscribe = (): (() => void) => () => {}
const nullSnapshot = (): null => null

// ── useFocusZone ──────────────────────────────────────────────────────────

export interface UseFocusZoneConfig {
  id: string
  order: number
  kind?: ZoneKind
  fallbackZone?: string
  /** Register/unregister the zone (hidden panes drop out of the Tab ring). */
  enabled?: boolean
  onKey?: (key: KeyEvent) => boolean
  onEscape?: () => boolean
  /** Status-bar nav hints while active. Captured at registration — keep static. */
  hints?: readonly FocusHint[]
}

/**
 * Registers a zone (pane) on the nearest FocusLayer (or the root layer).
 * `isActive` is true only while the zone's layer is the top layer AND the
 * zone is the layer's active zone — map it onto scrollbox/textarea `focused`
 * props and border colors. `focus()` is the click-to-focus handler.
 */
export function useFocusZone(cfg: UseFocusZoneConfig): { isActive: boolean; focus: () => void } {
  const manager = useContext(FocusContext)
  const layerId = useContext(LayerContext)
  const onKeyRef = useRef(cfg.onKey)
  onKeyRef.current = cfg.onKey
  const onEscapeRef = useRef(cfg.onEscape)
  onEscapeRef.current = cfg.onEscape
  const hintsRef = useRef(cfg.hints)
  hintsRef.current = cfg.hints
  const enabled = cfg.enabled ?? true

  useLayoutEffect(() => {
    if (!manager || !enabled) return
    manager.registerZone(layerId, {
      id: cfg.id,
      order: cfg.order,
      kind: cfg.kind,
      fallbackZone: cfg.fallbackZone,
      onKey: (key: FocusKey) => onKeyRef.current?.(key as KeyEvent) ?? false,
      onEscape: () => onEscapeRef.current?.() ?? false,
      hints: hintsRef.current,
    })
    return () => manager.unregisterZone(layerId, cfg.id)
  }, [manager, layerId, enabled, cfg.id, cfg.order, cfg.kind, cfg.fallbackZone])

  const isActive = useSyncExternalStore(
    manager?.subscribe ?? noopSubscribe,
    useCallback(
      () => (manager && enabled ? manager.isZoneActive(layerId, cfg.id) : false),
      [manager, layerId, cfg.id, enabled],
    ),
  )
  const focus = useCallback(() => manager?.focusZone(cfg.id), [manager, cfg.id])
  return { isActive, focus }
}

// ── useListNavigation ─────────────────────────────────────────────────────

export interface ListNavigationOptions<T> {
  /** Zone whose active state gates these keys (zone may be registered elsewhere). */
  zoneId: string
  items: readonly T[]
  /** Controlled index; omit for uncontrolled (internal state). */
  index?: number
  onIndexChange?: (index: number) => void
  /** Enter (and Space unless activateOnEnterOnly) on the current item. */
  onActivate?: (item: T, index: number) => void
  activateOnEnterOnly?: boolean
  /** Stable child id for scrollChildIntoView; return undefined to skip scrolling. */
  itemId?: (item: T, index: number) => string | undefined
  scrollRef?: RefObject<ScrollBoxRenderable | null>
  /** Handle PgUp/PgDn/Home/End against scrollRef. */
  pageScroll?: boolean
  /** Extra zone-local keys; return true = handled. */
  extraKeys?: (key: KeyEvent, index: number) => boolean
}

/**
 * The shared up/down/activate model for a zone's focusable elements: owns
 * clamping when items shrink and keeps the current item scrolled into view.
 * Keys only fire while the zone is active (dispatched via the manager).
 */
export function useListNavigation<T>(opts: ListNavigationOptions<T>): {
  index: number
  setIndex: (index: number) => void
} {
  const manager = useContext(FocusContext)
  const layerId = useContext(LayerContext)
  const [internalIndex, setInternalIndex] = useState(0)
  const controlled = opts.index !== undefined
  const count = opts.items.length
  const rawIndex = controlled ? opts.index! : internalIndex
  const index = Math.max(0, Math.min(rawIndex, count - 1))

  const optsRef = useRef(opts)
  optsRef.current = opts
  const indexRef = useRef(index)
  indexRef.current = index
  const controlledRef = useRef(controlled)
  controlledRef.current = controlled

  const setIndex = useCallback((next: number) => {
    if (!controlledRef.current) setInternalIndex(next)
    optsRef.current.onIndexChange?.(next)
  }, [])

  // Notify the owner when an out-of-range controlled index needs clamping
  // (item count shrank, or the caller set an index past the end).
  useEffect(() => {
    if (controlled && count > 0 && opts.index! > count - 1) {
      opts.onIndexChange?.(count - 1)
    }
  }, [controlled, count, opts.index])

  useLayoutEffect(() => {
    if (!manager) return
    return manager.registerZoneKeyHandler(layerId, opts.zoneId, (key: FocusKey) => {
      const o = optsRef.current
      const i = indexRef.current
      const n = o.items.length
      if (n > 0) {
        if (key.name === 'up') {
          setIndex(Math.max(0, i - 1))
          return true
        }
        if (key.name === 'down') {
          setIndex(Math.min(n - 1, i + 1))
          return true
        }
        if (o.onActivate && (key.name === 'return' || (key.name === 'space' && !o.activateOnEnterOnly))) {
          o.onActivate(o.items[i]!, i)
          return true
        }
      }
      const scrollbox = o.pageScroll ? o.scrollRef?.current : null
      if (scrollbox) {
        if (key.name === 'pageup') {
          scrollbox.scrollBy(-0.5, 'viewport')
          return true
        }
        if (key.name === 'pagedown') {
          scrollbox.scrollBy(0.5, 'viewport')
          return true
        }
        if (key.name === 'home') {
          scrollbox.scrollBy(-1, 'content')
          return true
        }
        if (key.name === 'end') {
          scrollbox.scrollBy(1, 'content')
          return true
        }
      }
      return o.extraKeys?.(key as KeyEvent, i) ?? false
    })
  }, [manager, layerId, opts.zoneId, setIndex])

  // Keep the current item visible whenever it changes.
  useLayoutEffect(() => {
    const o = optsRef.current
    if (count === 0 || !o.itemId || !o.scrollRef?.current) return
    const childId = o.itemId(o.items[index]!, index)
    if (childId) o.scrollRef.current.scrollChildIntoView(childId)
  }, [index, count])

  return { index, setIndex }
}

// ── useZoneKeys ───────────────────────────────────────────────────────────

/**
 * Zone-local key handler without list semantics (e.g. page-scroll keys).
 * The zone itself may be registered by another component. Return true =
 * handled. Only fires while the zone is active on the top layer.
 */
export function useZoneKeys(zoneId: string, handler: (key: KeyEvent) => boolean): void {
  const manager = useContext(FocusContext)
  const layerId = useContext(LayerContext)
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useLayoutEffect(() => {
    if (!manager) return
    return manager.registerZoneKeyHandler(layerId, zoneId, (key: FocusKey) => handlerRef.current(key as KeyEvent))
  }, [manager, layerId, zoneId])
}

// ── useShortcut ───────────────────────────────────────────────────────────

export interface UseShortcutConfig extends Omit<ShortcutConfig, 'run'> {
  run: () => void
  enabled?: boolean
}

/**
 * Layer-scoped shortcut. `label`/`displayKeys` feed the StatusBar hint
 * registry; suppressed while an 'input' zone is active unless `reserve`.
 */
export function useShortcut(cfg: UseShortcutConfig): void {
  const manager = useContext(FocusContext)
  const layerId = useContext(LayerContext)
  const runRef = useRef(cfg.run)
  runRef.current = cfg.run
  const enabled = cfg.enabled ?? true
  const keys = cfg.keys.join(' ')

  useLayoutEffect(() => {
    if (!manager || !enabled) return
    return manager.registerShortcut(layerId, {
      id: cfg.id,
      keys: keys.split(' '),
      run: () => runRef.current(),
      label: cfg.label,
      displayKeys: cfg.displayKeys,
      order: cfg.order,
      hidden: cfg.hidden,
      reserve: cfg.reserve,
    })
    // Metadata (label/displayKeys/order/hidden) is patched by the effect below,
    // so it's intentionally excluded here to avoid re-registering the shortcut.
  }, [manager, layerId, enabled, cfg.id, keys, cfg.reserve])

  // Presentational metadata patches in place — no re-register on label/hidden
  // flips (logs show/hide, demo start/stop, compose hidden-in-composer).
  useLayoutEffect(() => {
    if (!manager || !enabled) return
    manager.updateShortcut(layerId, cfg.id, {
      label: cfg.label,
      displayKeys: cfg.displayKeys,
      order: cfg.order,
      hidden: cfg.hidden,
    })
  }, [manager, layerId, enabled, cfg.id, cfg.label, cfg.displayKeys, cfg.order, cfg.hidden])
}

// ── useLayerKeys ──────────────────────────────────────────────────────────

/**
 * Raw layer-scoped key handler (sub-step state machines like ModelStep).
 * Runs after the active zone's keys, before Escape/shortcuts. Return true =
 * handled. Without a FocusProvider it degrades to a plain useKeyboard
 * subscription, so components using it still work on unmigrated screens.
 */
export function useLayerKeys(handler: (key: KeyEvent) => boolean): void {
  const manager = useContext(FocusContext)
  const layerId = useContext(LayerContext)
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (manager) return // dispatched through the manager instead
        if (handlerRef.current(key)) key.stopPropagation()
      },
      [manager],
    ),
  )

  useLayoutEffect(() => {
    if (!manager) return
    return manager.registerLayerKeyHandler(layerId, (key: FocusKey) => handlerRef.current(key as KeyEvent))
  }, [manager, layerId])
}

// ── Snapshot selectors ────────────────────────────────────────────────────

export function useFocusSnapshot(): FocusSnapshot | null {
  const manager = useContext(FocusContext)
  return useSyncExternalStore(manager?.subscribe ?? noopSubscribe, manager?.getSnapshot ?? nullSnapshot)
}

/** Active zone id of the given layer when it is on top, else null. */
export function useActiveZone(layerId = 'root'): string | null {
  const snapshot = useFocusSnapshot()
  if (!snapshot || snapshot.topLayerId !== layerId) return null
  return snapshot.activeZoneId
}

/**
 * Status-bar hints derived from the focus registry: Tab (when the top layer
 * has a ring), the active zone's nav hints, then the top layer's labelled
 * shortcuts in order — clicking a shortcut hint runs it.
 */
export function useStatusHints(): FocusHint[] {
  const snapshot = useFocusSnapshot()
  return useMemo(() => {
    if (!snapshot) return []
    const hints: FocusHint[] = []
    if (snapshot.zoneOrder.length > 1) {
      hints.push({ id: 'tab', keys: 'tab', label: 'navigate' })
    }
    hints.push(...snapshot.activeZoneHints)
    // Match the dispatcher: single-char shortcuts don't fire while an input
    // zone is active, so don't advertise them (they'd type, not run).
    const suppressed = snapshot.activeZoneKind === 'input'
    for (const s of snapshot.shortcuts) {
      if (s.hidden || !s.label) continue
      if (suppressed && !s.reserve) continue
      hints.push({ id: s.id, keys: s.displayKeys ?? s.keys[0] ?? '', label: s.label, onPress: s.run })
    }
    return hints
  }, [snapshot])
}
