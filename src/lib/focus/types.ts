/**
 * Minimal structural view of an OpenTUI KeyEvent — everything the manager
 * needs to dispatch. Real KeyEvents satisfy this, and tests can use plain
 * objects without importing @opentui/core.
 */
export interface FocusKey {
  name: string
  ctrl: boolean
  shift: boolean
  meta: boolean
  stopPropagation: () => void
}

/**
 * 'input' zones receive raw typing: single-character layer shortcuts are
 * suppressed while such a zone is active (Tab/Escape still work).
 */
export type ZoneKind = 'nav' | 'input'

/** A StatusBar-compatible key hint ({ keys: '↑↓', label: 'select' }). */
export interface FocusHint {
  id: string
  keys: string
  label?: string
  onPress?: () => void
}

export interface ZoneConfig {
  id: string
  /** Position in the layer's Tab ring (ascending). */
  order: number
  kind?: ZoneKind
  /**
   * Zone to focus when this zone unregisters while active, and the default
   * Escape target (Escape chain: onEscape → fallbackZone → layer onEscape).
   */
  fallbackZone?: string
  /** Zone-local keys (list navigation, page scroll). Return true = handled. */
  onKey?: (key: FocusKey) => boolean
  /** Custom Escape. Return true = handled, false = continue the chain. */
  onEscape?: () => boolean
  /** Static nav hints shown in the status bar while this zone is active. */
  hints?: readonly FocusHint[]
}

export interface LayerConfig {
  id: string
  /** Layer-level Escape (modal dismiss). Return true = handled. */
  onEscape?: () => boolean
  /** Zone to activate when it registers into this layer. */
  initialZone?: string
}

export interface ShortcutConfig {
  id: string
  /** KeyEvent.name values that trigger it, e.g. ['l', 'L']. */
  keys: string[]
  run: () => void
  /** StatusBar label ("logs", "quit"). Hidden from the bar when omitted or hidden:true. */
  label?: string
  /** StatusBar key text ("l", "↑↓"); defaults to keys[0]. */
  displayKeys?: string
  /** StatusBar ordering (ascending). */
  order?: number
  hidden?: boolean
  /** Fire even while an 'input' zone is active. */
  reserve?: boolean
}

/** Immutable view of the manager state for useSyncExternalStore. */
export interface FocusSnapshot {
  topLayerId: string
  /** Active zone of the top layer (null when the top layer has no zones). */
  activeZoneId: string | null
  /** Kind of the active zone ('input' suppresses single-char shortcut hints). */
  activeZoneKind: ZoneKind | null
  /** Nav hints of the active zone (for the status bar). */
  activeZoneHints: readonly FocusHint[]
  /** Enabled zones of the top layer in Tab-ring order. */
  zoneOrder: readonly string[]
  /** Top layer's shortcuts sorted by order. */
  shortcuts: readonly Readonly<ShortcutConfig>[]
  version: number
}
