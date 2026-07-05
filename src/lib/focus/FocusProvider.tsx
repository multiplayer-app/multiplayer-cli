import { createContext, useCallback, useContext, useRef, type ReactElement, type ReactNode } from 'react'
import type { KeyEvent } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { FocusManager } from './FocusManager.js'

export const FocusContext = createContext<FocusManager | null>(null)
/** Layer id zones/shortcuts register into; FocusLayer overrides it for modals. */
export const LayerContext = createContext<string>('root')

export function useFocusManager(): FocusManager | null {
  return useContext(FocusContext)
}

/**
 * Owns THE single useKeyboard subscription: every key goes through
 * FocusManager.handleKey, which stops propagation only for keys some
 * binding claimed — everything else falls through to legacy useKeyboard
 * handlers (registered later, e.g. wizard steps) and the natively focused
 * renderable (textarea/scrollbox).
 */
export function FocusProvider({ children }: { children: ReactNode }): ReactElement {
  const managerRef = useRef<FocusManager | null>(null)
  managerRef.current ??= new FocusManager('root')
  const manager = managerRef.current

  useKeyboard(useCallback((key: KeyEvent) => manager.handleKey(key), [manager]))

  return (
    <FocusContext.Provider value={manager}>
      <LayerContext.Provider value='root'>{children}</LayerContext.Provider>
    </FocusContext.Provider>
  ) as ReactElement
}
