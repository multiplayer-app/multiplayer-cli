import type { ReactElement } from 'react'
import { tuiAttrs } from '../lib/tuiAttrs.js'

import { ACCENT, BRAND_MARK_PRIMARY, FG_DIM, FG_HINT } from './shared/tuiTheme.js'
import { DemoRunInstructions } from './DemoRunInstructions.js'
import type { DemoStatus } from '../lib/demoProcess.js'

interface Props {
  hasSessions: boolean
  isDemoProject?: boolean
  demoDir?: string
  workspace?: string
  project?: string
  demoStatus?: DemoStatus
  demoUrl?: string | null
  demoError?: string | null
  apiUrl?: string
}

function EmptyDetailPaneImpl({
  hasSessions,
  isDemoProject,
  demoDir,
  workspace,
  project,
  demoStatus,
  demoUrl,
  demoError,
  apiUrl,
}: Props): ReactElement {
  const showDemo = isDemoProject && !!demoDir

  return (
    <box flexDirection='column' flexGrow={1} justifyContent='center' alignItems='center' gap={1}>
      {/* Brand */}
      <text fg={BRAND_MARK_PRIMARY} attributes={tuiAttrs({ bold: true })}>
        ◆ MULTIPLAYER
      </text>

      {/* Contextual message */}
      <box flexDirection='column' alignItems='center' gap={1}>
        {hasSessions ? (
          <>
            <text fg={FG_DIM}>Select a session from the list to view details</text>
            <box flexDirection='row' gap={2}>
              <box flexDirection='row' gap={1}>
                <text fg={ACCENT} attributes={tuiAttrs({ bold: true })}>
                  ↑↓
                </text>
                <text fg={FG_HINT}>navigate</text>
              </box>
              <box flexDirection='row' gap={1}>
                <text fg={ACCENT} attributes={tuiAttrs({ bold: true })}>
                  ↵
                </text>
                <text fg={FG_HINT}>open</text>
              </box>
              <box flexDirection='row' gap={1}>
                <text fg={ACCENT} attributes={tuiAttrs({ bold: true })}>
                  i
                </text>
                <text fg={FG_HINT}>compose</text>
              </box>
            </box>
          </>
        ) : (
          <>
            <text fg={FG_DIM}>Waiting for issues to arrive...</text>
            <text fg={FG_HINT}>Issues will appear here as they are detected</text>
            <text fg={FG_HINT}>Listening...</text>
          </>
        )}
      </box>

      {showDemo && (
        <box flexDirection='column' marginTop={2} width='80%' alignItems='stretch'>
          <DemoRunInstructions
            workspace={workspace}
            project={project}
            alignCenter={true}
            demoStatus={demoStatus ?? 'idle'}
            demoUrl={demoUrl ?? null}
            demoError={demoError ?? null}
            apiUrl={apiUrl}
          />
        </box>
      )}
    </box>
  ) as ReactElement
}

export const EmptyDetailPane = EmptyDetailPaneImpl as (props: Props) => ReactElement
