import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { LayerContext, useFocusManager } from './FocusProvider.js'

interface Props {
  id: string
  /** Called on Escape when no zone inside the layer claims it (modal dismiss). */
  onDismiss?: () => void
  /** Zone to activate when it registers into this layer. */
  initialZone?: string
  children: ReactNode
}

/**
 * Pushes a focus layer on mount and pops it on unmount. While mounted, it is
 * the top layer: zones/shortcuts of layers below stop receiving keys, and
 * everything registered by descendants (via LayerContext) lands on this
 * layer. Wrap modal overlays in this.
 */
export function FocusLayer({ id, onDismiss, initialZone, children }: Props): ReactElement {
  const manager = useFocusManager()
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  useLayoutEffect(() => {
    if (!manager) return
    manager.pushLayer({
      id,
      initialZone,
      onEscape: () => {
        if (!onDismissRef.current) return false
        onDismissRef.current()
        return true
      }
    })
    return () => manager.popLayer(id)
    // initialZone is a mount-time hint; changing it later must not re-push the layer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, id])

  return <LayerContext.Provider value={id}>{children}</LayerContext.Provider> as ReactElement
}
