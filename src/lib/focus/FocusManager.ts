import type { FocusKey, FocusSnapshot, LayerConfig, ShortcutConfig, ZoneConfig } from './types.js'

interface Layer {
  id: string
  onEscape?: () => boolean
  initialZone?: string
  zones: Map<string, ZoneConfig>
  activeZoneId: string | null
  /** Zone that was active before the current one (focus restore on unregister). */
  lastActiveZoneId: string | null
  /**
   * False until focusZone/Tab explicitly picks a zone. While false, the
   * lowest-order zone wins as zones register in arbitrary React-effect order.
   */
  explicitFocus: boolean
  shortcuts: ShortcutConfig[]
  keyHandlers: ((key: FocusKey) => boolean)[]
}

type ZoneKeyHandler = (key: FocusKey) => boolean

/**
 * Framework-agnostic focus state: a stack of layers (base screen + modals),
 * each holding an ordered ring of zones (panes) plus layer-scoped shortcuts
 * and raw key handlers. Only the top layer receives keys.
 *
 * Dispatch (see handleKey): ctrl+c pass-through → Tab ring → active zone keys
 * → layer key handlers → Escape chain → layer shortcuts. Keys nobody claims
 * are left unstopped so the natively focused renderable (textarea, scrollbox)
 * still receives them.
 *
 * All mutation APIs tolerate unknown ids and arbitrary registration order
 * (React child effects run before parents): zones may register before their
 * layer is pushed, key handlers before their zone exists, and focusZone may
 * target a zone that mounts a commit later (pending focus).
 */
export class FocusManager {
  private layers: Layer[]
  /** Zones registered before their layer was pushed, keyed by layer id. */
  private pendingZones = new Map<string, ZoneConfig[]>()
  private pendingShortcuts = new Map<string, ShortcutConfig[]>()
  private pendingKeyHandlers = new Map<string, ((key: FocusKey) => boolean)[]>()
  /** Handlers for zone-local keys, keyed by `${layerId}:${zoneId}`; independent of zone existence. */
  private zoneKeyHandlers = new Map<string, ZoneKeyHandler[]>()
  /** Zone id to activate as soon as it registers (focusZone on an unmounted zone). */
  private pendingFocusZoneId: string | null = null

  private listeners = new Set<() => void>()
  private version = 0
  private snapshot: FocusSnapshot

  constructor(rootLayerId = 'root') {
    this.layers = [this.createLayer({ id: rootLayerId })]
    this.snapshot = this.buildSnapshot()
  }

  // ── Layers ──────────────────────────────────────────────────────────────

  pushLayer(cfg: LayerConfig): void {
    if (this.findLayer(cfg.id)) return
    const layer = this.createLayer(cfg)
    this.layers.push(layer)
    this.drainPending(layer)
    this.bump()
  }

  popLayer(id: string): void {
    const idx = this.layers.findIndex((l) => l.id === id)
    if (idx <= 0) return // never pop the root layer
    this.layers.splice(idx, 1)
    this.bump()
  }

  // ── Zones ───────────────────────────────────────────────────────────────

  registerZone(layerId: string, cfg: ZoneConfig): void {
    const layer = this.findLayer(layerId)
    if (!layer) {
      const list = this.pendingZones.get(layerId) ?? []
      this.pendingZones.set(layerId, [...list.filter((z) => z.id !== cfg.id), cfg])
      return
    }
    layer.zones.set(cfg.id, cfg)
    const current = layer.activeZoneId ? layer.zones.get(layer.activeZoneId) : undefined
    const shouldClaim =
      layer.activeZoneId === null ||
      cfg.id === this.pendingFocusZoneId ||
      (!layer.explicitFocus && cfg.id === layer.initialZone) ||
      // Zones register in React-effect order (children before parents), not
      // ring order — until an explicit focus, the lowest-order zone wins.
      (!layer.explicitFocus && cfg.order < (current?.order ?? Infinity))
    if (shouldClaim) {
      const next = this.pickInitialZone(layer, cfg)
      if (cfg.id === this.pendingFocusZoneId && next === cfg.id) {
        this.pendingFocusZoneId = null
        layer.explicitFocus = true
      }
      this.setActiveZone(layer, next)
    }
    this.bump()
  }

  updateZone(layerId: string, id: string, patch: Partial<ZoneConfig>): void {
    const layer = this.findLayer(layerId)
    const zone = layer?.zones.get(id)
    if (!layer || !zone) return
    layer.zones.set(id, { ...zone, ...patch, id })
    this.bump()
  }

  unregisterZone(layerId: string, id: string): void {
    const pending = this.pendingZones.get(layerId)
    if (pending) this.pendingZones.set(layerId, pending.filter((z) => z.id !== id))
    const layer = this.findLayer(layerId)
    if (!layer || !layer.zones.has(id)) return
    const zone = layer.zones.get(id)!
    layer.zones.delete(id)
    if (layer.activeZoneId === id) {
      // Restore focus to wherever it was before this zone took it (natural
      // when a pane closes), else the zone's declared fallback, else the ring.
      const restore =
        (layer.lastActiveZoneId !== id && layer.lastActiveZoneId && layer.zones.get(layer.lastActiveZoneId)) ||
        (zone.fallbackZone && layer.zones.get(zone.fallbackZone)) ||
        this.sortedZones(layer)[0]
      layer.activeZoneId = restore?.id ?? null
      layer.lastActiveZoneId = null
    }
    this.bump()
  }

  // ── Shortcuts & raw key handlers ────────────────────────────────────────

  registerShortcut(layerId: string, cfg: ShortcutConfig): () => void {
    const layer = this.findLayer(layerId)
    if (!layer) {
      const list = this.pendingShortcuts.get(layerId) ?? []
      this.pendingShortcuts.set(layerId, [...list.filter((s) => s.id !== cfg.id), cfg])
      return () => {
        const cur = this.pendingShortcuts.get(layerId) ?? []
        this.pendingShortcuts.set(layerId, cur.filter((s) => s.id !== cfg.id))
        this.removeShortcut(layerId, cfg.id)
      }
    }
    layer.shortcuts = [...layer.shortcuts.filter((s) => s.id !== cfg.id), cfg]
    this.bump()
    return () => this.removeShortcut(layerId, cfg.id)
  }

  /** Patch a shortcut's metadata (label/hidden/…) in place without re-registering. */
  updateShortcut(layerId: string, id: string, patch: Partial<ShortcutConfig>): void {
    const patchList = (list: ShortcutConfig[] | undefined): boolean => {
      const idx = list?.findIndex((s) => s.id === id) ?? -1
      if (idx < 0 || !list) return false
      list[idx] = { ...list[idx]!, ...patch, id }
      return true
    }
    if (patchList(this.findLayer(layerId)?.shortcuts)) {
      this.bump()
      return
    }
    patchList(this.pendingShortcuts.get(layerId))
  }

  registerLayerKeyHandler(layerId: string, handler: (key: FocusKey) => boolean): () => void {
    const layer = this.findLayer(layerId)
    if (!layer) {
      const list = this.pendingKeyHandlers.get(layerId) ?? []
      this.pendingKeyHandlers.set(layerId, [...list, handler])
      return () => {
        const cur = this.pendingKeyHandlers.get(layerId) ?? []
        this.pendingKeyHandlers.set(layerId, cur.filter((h) => h !== handler))
        this.removeKeyHandler(layerId, handler)
      }
    }
    layer.keyHandlers.push(handler)
    return () => this.removeKeyHandler(layerId, handler)
  }

  /** Zone-local key handler (e.g. list navigation); may register before the zone exists. */
  registerZoneKeyHandler(layerId: string, zoneId: string, handler: ZoneKeyHandler): () => void {
    const key = `${layerId}:${zoneId}`
    const list = this.zoneKeyHandlers.get(key) ?? []
    this.zoneKeyHandlers.set(key, [...list, handler])
    return () => {
      const cur = this.zoneKeyHandlers.get(key) ?? []
      this.zoneKeyHandlers.set(key, cur.filter((h) => h !== handler))
    }
  }

  // ── Focus ───────────────────────────────────────────────────────────────

  /**
   * Focus a zone in whichever layer owns it (keys still only reach the top
   * layer). Unknown zones are remembered and focused when they register —
   * callers may focus a zone whose pane mounts on the next commit.
   */
  focusZone(zoneId: string): void {
    for (const layer of this.layers) {
      if (layer.zones.has(zoneId)) {
        this.pendingFocusZoneId = null
        layer.explicitFocus = true
        this.setActiveZone(layer, zoneId)
        this.bump()
        return
      }
    }
    this.pendingFocusZoneId = zoneId
  }

  focusNext(): void {
    this.moveFocus(1)
  }

  focusPrev(): void {
    this.moveFocus(-1)
  }

  isZoneActive(layerId: string, zoneId: string): boolean {
    const top = this.top()
    return top.id === layerId && top.activeZoneId === zoneId
  }

  // ── Dispatch ────────────────────────────────────────────────────────────

  /** Called only by the FocusProvider's single useKeyboard handler. */
  handleKey(key: FocusKey): void {
    // App.tsx owns ctrl+c (double-press quit) — never touch it.
    if (key.ctrl && key.name === 'c') return

    const layer = this.top()
    const hasZones = layer.zones.size > 0

    // 1. Tab ring. Gated on the layer having zones so unmigrated screens
    //    (startup wizard, legacy modal internals) keep their own Tab behavior.
    if (key.name === 'tab' && hasZones) {
      if (key.shift) this.focusPrev()
      else this.focusNext()
      key.stopPropagation()
      return
    }

    // 2. Active zone keys: zone.onKey, then zone key handlers (list nav etc).
    const zone = layer.activeZoneId ? layer.zones.get(layer.activeZoneId) : undefined
    if (zone) {
      if (zone.onKey?.(key)) {
        key.stopPropagation()
        return
      }
      for (const handler of this.zoneKeyHandlers.get(`${layer.id}:${zone.id}`) ?? []) {
        if (handler(key)) {
          key.stopPropagation()
          return
        }
      }
    }

    // 3. Layer raw key handlers (sub-step state machines like ModelStep).
    for (const handler of layer.keyHandlers) {
      if (handler(key)) {
        key.stopPropagation()
        return
      }
    }

    // 4. Escape chain: zone.onEscape → zone.fallbackZone → layer.onEscape.
    //    Unclaimed Escape continues to the shortcuts (and then falls through).
    if (key.name === 'escape') {
      if (zone?.onEscape?.()) {
        key.stopPropagation()
        return
      }
      if (zone?.fallbackZone && zone.fallbackZone !== zone.id) {
        const target = this.resolveZone(zone.fallbackZone)
        if (target) {
          this.focusZone(zone.fallbackZone)
          key.stopPropagation()
          return
        }
      }
      if (layer.onEscape?.()) {
        key.stopPropagation()
        return
      }
    }

    // 5. Layer shortcuts (case-insensitive). Suppressed while typing.
    const suppressed = zone?.kind === 'input'
    const keyName = key.name.toLowerCase()
    for (const shortcut of layer.shortcuts) {
      if (suppressed && !shortcut.reserve) continue
      if (shortcut.keys.some((k) => k.toLowerCase() === keyName)) {
        shortcut.run()
        key.stopPropagation()
        return
      }
    }
  }

  // ── Store ───────────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): FocusSnapshot => this.snapshot

  // ── Internals ───────────────────────────────────────────────────────────

  private createLayer(cfg: LayerConfig): Layer {
    return {
      id: cfg.id,
      onEscape: cfg.onEscape,
      initialZone: cfg.initialZone,
      zones: new Map(),
      activeZoneId: null,
      lastActiveZoneId: null,
      explicitFocus: false,
      shortcuts: [],
      keyHandlers: [],
    }
  }

  private drainPending(layer: Layer): void {
    for (const zone of this.pendingZones.get(layer.id) ?? []) this.registerZone(layer.id, zone)
    this.pendingZones.delete(layer.id)
    for (const s of this.pendingShortcuts.get(layer.id) ?? []) layer.shortcuts.push(s)
    this.pendingShortcuts.delete(layer.id)
    for (const h of this.pendingKeyHandlers.get(layer.id) ?? []) layer.keyHandlers.push(h)
    this.pendingKeyHandlers.delete(layer.id)
  }

  private removeShortcut(layerId: string, id: string): void {
    const layer = this.findLayer(layerId)
    if (!layer) return
    const idx = layer.shortcuts.findIndex((s) => s.id === id)
    if (idx >= 0) {
      layer.shortcuts.splice(idx, 1)
      this.bump()
    }
  }

  private removeKeyHandler(layerId: string, handler: (key: FocusKey) => boolean): void {
    const layer = this.findLayer(layerId)
    if (!layer) return
    const idx = layer.keyHandlers.indexOf(handler)
    if (idx >= 0) layer.keyHandlers.splice(idx, 1)
  }

  private findLayer(id: string): Layer | undefined {
    return this.layers.find((l) => l.id === id)
  }

  private top(): Layer {
    return this.layers[this.layers.length - 1]!
  }

  private sortedZones(layer: Layer): ZoneConfig[] {
    return [...layer.zones.values()].sort((a, b) => a.order - b.order)
  }

  private resolveZone(zoneId: string): ZoneConfig | undefined {
    for (const layer of this.layers) {
      const zone = layer.zones.get(zoneId)
      if (zone) return zone
    }
    return undefined
  }

  /** Before any explicit focus, prefer pending focus, then initialZone, then lowest order. */
  private pickInitialZone(layer: Layer, justRegistered: ZoneConfig): string {
    if (justRegistered.id === this.pendingFocusZoneId) return justRegistered.id
    if (layer.initialZone && layer.zones.has(layer.initialZone)) return layer.initialZone
    if (layer.explicitFocus && layer.activeZoneId && layer.zones.has(layer.activeZoneId)) {
      return layer.activeZoneId
    }
    return this.sortedZones(layer)[0]!.id
  }

  private setActiveZone(layer: Layer, zoneId: string): void {
    if (!layer.zones.has(zoneId) || layer.activeZoneId === zoneId) return
    layer.lastActiveZoneId = layer.activeZoneId
    layer.activeZoneId = zoneId
    this.bump()
  }

  private moveFocus(direction: 1 | -1): void {
    const layer = this.top()
    const ring = this.sortedZones(layer)
    if (ring.length === 0) return
    this.pendingFocusZoneId = null
    layer.explicitFocus = true
    const idx = ring.findIndex((z) => z.id === layer.activeZoneId)
    const next = ring[(idx + direction + ring.length) % ring.length]!
    this.setActiveZone(layer, next.id)
  }

  private bump(): void {
    this.version += 1
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }

  private buildSnapshot(): FocusSnapshot {
    const top = this.top()
    const activeZone = top.activeZoneId ? top.zones.get(top.activeZoneId) : undefined
    return {
      topLayerId: top.id,
      activeZoneId: top.activeZoneId,
      activeZoneKind: activeZone?.kind ?? null,
      activeZoneHints: activeZone?.hints ?? [],
      zoneOrder: this.sortedZones(top).map((z) => z.id),
      shortcuts: [...top.shortcuts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      version: this.version,
    }
  }
}
