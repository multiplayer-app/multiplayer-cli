import type { ReactElement } from 'react'
import { MouseButton, type MouseEvent } from '@opentui/core'
import { useTerminalDimensions } from '@opentui/react'
import { tuiAttrs } from '../lib/tuiAttrs.js'
import type { AgentConfig } from '../types/index.js'
import { ModelStep } from './startup/ModelStep.js'
import { BG_MODAL, FG_HINT, FG_TITLE, MODAL_BACKDROP_RGBA } from './shared/tuiTheme.js'

interface Props {
  config: Partial<AgentConfig>
  onApply: (updates: Partial<AgentConfig>) => void
  onClose: () => void
}

/**
 * Modal wrapper around the setup ModelStep so the running agent can switch
 * provider/model from the dashboard. ModelStep drives selection and the
 * OpenAI key/url sub-steps; we apply its result and close.
 */
export function ModelPanel({ config, onApply, onClose }: Props): ReactElement {
  const { width, height } = useTerminalDimensions()

  // Escape is handled by ModelStep's layer keys: it walks sub-steps back and
  // calls onBack (= onClose) from the provider list. The FocusLayer's
  // onDismiss covers any Escape ModelStep leaves unhandled.
  const dialogWidth = Math.min(76, width - 4)
  const modalMaxHeight = Math.max(14, height - 4)

  const backdropMouseUp = (e: MouseEvent) => {
    if (e.button !== MouseButton.LEFT) return
    e.stopPropagation()
    onClose()
  }
  const stopMouse = (e: MouseEvent) => e.stopPropagation()

  return (
    <box
      position='absolute'
      top={0}
      left={0}
      width={width}
      height={height}
      flexDirection='column'
      justifyContent='center'
      alignItems='center'
      backgroundColor={MODAL_BACKDROP_RGBA}
      onMouseUp={backdropMouseUp}
    >
      <box
        flexDirection='column'
        flexShrink={1}
        minHeight={0}
        maxHeight={modalMaxHeight}
        overflow='hidden'
        width={dialogWidth}
        maxWidth={dialogWidth}
        backgroundColor={BG_MODAL}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={0}
        onMouseUp={stopMouse}
      >
        <box flexDirection='column' flexShrink={0} gap={0}>
          <text fg={FG_TITLE} attributes={tuiAttrs({ bold: true })}>
            Select model
          </text>
          <text fg={FG_HINT} attributes={tuiAttrs({ dim: true })}>
            Applies to new and continued sessions.
          </text>
        </box>
        <box marginTop={1} flexGrow={1} flexShrink={1} minHeight={0} overflow='hidden'>
          <ModelStep
            config={config}
            onBack={onClose}
            onComplete={(updates) => {
              onApply(updates)
              onClose()
            }}
          />
        </box>
      </box>
    </box>
  ) as ReactElement
}
