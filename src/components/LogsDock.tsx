import type { ReactElement } from 'react'
import { useFocusZone } from '../lib/focus/index.js'
import { clickHandler } from './shared/clickHandler.js'
import { tuiAttrs } from '../lib/tuiAttrs.js'
import { LogOutput } from './LogOutput.js'
import type { LogEntry } from '../types/index.js'
import { BORDER_MUTED, SEM_VIOLET_SOFT } from './shared/tuiTheme.js'

const LOGS_ZONE_HINTS = [{ id: 'scroll', keys: '↑↓', label: 'scroll' }] as const

interface Props {
  logs: LogEntry[]
  height: number
  /** Escape while focused (dashboard supplies narrow-aware back-to-list). */
  onEscape?: () => boolean
}

function LogsDockImpl({ logs, height, onEscape }: Props): ReactElement {
  const { isActive, focus } = useFocusZone({
    id: 'logs',
    order: 4,
    fallbackZone: 'list',
    onEscape,
    hints: LOGS_ZONE_HINTS
  })

  const handleMouseUp = clickHandler(focus)

  return (
    <box
      border={true}
      borderStyle='rounded'
      borderColor={isActive ? SEM_VIOLET_SOFT : BORDER_MUTED}
      padding={1}
      flexShrink={0}
      flexDirection='column'
      gap={1}
      height={height}
      onMouseUp={handleMouseUp}
    >
      <text flexShrink={0} attributes={tuiAttrs({ dim: true, bold: true })}>
        Logs
      </text>
      <scrollbox
        flexGrow={1}
        scrollY
        focused={isActive}
        stickyScroll
        stickyStart='bottom'
        onMouseUp={handleMouseUp}
        style={{
          wrapperOptions: { flexGrow: 1 },
          viewportOptions: { flexGrow: 1 },
          scrollbarOptions: {
            showArrows: true,
            trackOptions: {
              foregroundColor: SEM_VIOLET_SOFT,
              backgroundColor: BORDER_MUTED
            }
          }
        }}
      >
        <LogOutput logs={logs} showTitle={false} />
      </scrollbox>
    </box>
  ) as ReactElement
}

export const LogsDock = LogsDockImpl as (props: Props) => ReactElement
