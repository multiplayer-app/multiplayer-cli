import type { ReactElement } from 'react'
import { tuiAttrs } from '../lib/tuiAttrs.js'
import { openUrl } from '../lib/openUrl.js'
import { clickHandler } from './shared/index.js'
import type { DemoStatus } from '../lib/demoProcess.js'

interface Props {
  workspace?: string
  project?: string
  alignCenter?: boolean
  demoStatus: DemoStatus
  demoUrl: string | null
  demoError?: string | null
}

function DemoRunInstructionsImpl({
  workspace,
  project,
  alignCenter = false,
  demoStatus,
  demoUrl,
  demoError,
}: Props): ReactElement {
  const agentsUrl =
    workspace && project ? `https://go.multiplayer.app/project/${workspace}/${project}/default/agents` : null

  const statusColor =
    demoStatus === 'running' ? '#10b981' : demoStatus === 'error' ? '#ef4444' : demoStatus === 'stopped' ? '#9ca3af' : '#f59e0b'
  const statusLabel =
    demoStatus === 'running'
      ? 'running'
      : demoStatus === 'starting'
        ? 'starting...'
        : demoStatus === 'stopped'
          ? 'stopped'
          : demoStatus === 'error'
            ? 'error'
            : 'idle'

  return (
    <box flexDirection='column' flexShrink={0} gap={1} width='100%'>
      <box flexDirection='column' alignItems={alignCenter ? 'center' : undefined} gap={0}>
        <box flexDirection='row' gap={1}>
          <text attributes={tuiAttrs({ bold: true })}>Demo App</text>
          <text fg={statusColor}>· {statusLabel}</text>
        </box>
        <text attributes={tuiAttrs({ dim: true })}>The demo client and server are managed by this CLI.</text>
      </box>

      <box flexDirection='column' alignItems='flex-start' gap={0}>
        <text attributes={tuiAttrs({ bold: true })}>Open the demo app</text>
        {demoUrl ? (
          <box marginTop={1} onMouseUp={clickHandler(() => openUrl(demoUrl))}>
            <text>
              <span fg='#22d3ee' attributes={tuiAttrs({ underline: true })}>
                {demoUrl}
              </span>
            </text>
          </box>
        ) : demoStatus === 'starting' ? (
          <text attributes={tuiAttrs({ dim: true })}>Starting dev server, waiting for URL...</text>
        ) : demoStatus === 'stopped' ? (
          <text attributes={tuiAttrs({ dim: true })}>Demo stopped. Press d to start.</text>
        ) : demoStatus === 'error' ? (
          <text fg='#ef4444'>{demoError ?? 'Demo failed to start.'}</text>
        ) : (
          <text attributes={tuiAttrs({ dim: true })}>—</text>
        )}
      </box>

      <box flexDirection='column' gap={0} alignItems='flex-start'>
        <text attributes={tuiAttrs({ bold: true })}>Open the Multiplayer dashboard</text>
        <text attributes={tuiAttrs({ dim: true })}>
          Watch agent activity for this project on the Multiplayer dashboard.
        </text>
        <box marginTop={1} onMouseUp={agentsUrl ? clickHandler(() => openUrl(agentsUrl)) : undefined}>
          <text>
            <span fg='#22d3ee' attributes={tuiAttrs({ underline: true })}>
              {agentsUrl ?? 'https://go.multiplayer.app'}
            </span>
          </text>
        </box>
      </box>
    </box>
  ) as ReactElement
}

export const DemoRunInstructions = DemoRunInstructionsImpl as (props: Props) => ReactElement
