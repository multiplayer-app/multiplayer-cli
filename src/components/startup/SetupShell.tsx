import { useEffect, useLayoutEffect, useState, type ReactElement, type ReactNode } from 'react'
import { useTerminalDimensions } from '@opentui/react'
import { tuiAttrs } from '../../lib/tuiAttrs.js'
import type { AgentConfig } from '../../types/index.js'
import { Logo } from '../Logo.js'

const STEP_PANEL_WIDTH = 24

function compactContextLabel(name: string | undefined, id: string | undefined): string {
  const raw = (name?.trim() || id || '—').trim()
  if (raw === '—') return raw
  return raw.length > 26 ? `${raw.slice(0, 12)}…${raw.slice(-11)}` : raw
}

export interface SidebarEntry {
  id: string
  label: string
  isDone: boolean
  isCurrent: boolean
}

interface Props {
  title: string
  description: string
  config: Partial<AgentConfig>
  account: string
  /** Sidebar step entries; pass an empty array to hide the sidebar (e.g. on the project-type screen). */
  sidebar: SidebarEntry[]
  /** Banner text shown above the description (e.g. session-expired warning). */
  banner?: string | null
  /** Whether the API-key / workspace / model summary card is shown. Hidden on entry screens. */
  showSummary?: boolean
  children: ReactNode
}

/**
 * Shared chrome for setup flows. Owns the Logo, sidebar (with progress bar), the
 * title/description header, and the optional API-key / workspace / model summary
 * card. Flows render their step content as children.
 *
 * Has no awareness of which flow is mounted — it just renders what's passed in.
 */
export function SetupShell({
  title,
  description,
  config,
  account,
  sidebar,
  banner,
  showSummary = true,
  children,
}: Props): ReactElement | null {
  const { width: termWidth, height: termHeight } = useTerminalDimensions()
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    // eslint-disable-next-line no-console
    console.clear()
    setReady(true)
  }, [])

  useLayoutEffect(() => {
    if (!ready) return
    // eslint-disable-next-line no-console
    console.clear()
  }, [ready, title])

  useEffect(() => {
    const onResize = () => {
      // eslint-disable-next-line no-console
      console.clear()
    }
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off('resize', onResize)
    }
  }, [])

  if (!ready) return null

  const currentSidebarIndex = sidebar.findIndex((e) => e.isCurrent)
  const total = Math.max(1, sidebar.length)
  const done = Math.max(0, currentSidebarIndex)
  const progressPrefix = `${currentSidebarIndex + 1}/${sidebar.length}`
  const progressWidth = Math.max(8, STEP_PANEL_WIDTH - 6 - progressPrefix.length)
  const filled = Math.round((done / (total - 1 || 1)) * progressWidth)

  const maskedApiKey = config.apiKey ? `${config.apiKey.slice(0, 4)}••••${config.apiKey.slice(-3)}` : '—'
  const provider = config.model?.startsWith('claude') ? 'Claude' : config.model ? 'OpenAI-compatible' : '—'
  const compactDir = config.dir
    ? config.dir.length > 30
      ? `${config.dir.slice(0, 14)}…${config.dir.slice(-14)}`
      : config.dir
    : '—'
  const workspaceLabel = compactContextLabel(config.workspaceDisplayName, config.workspace)
  const projectLabel = compactContextLabel(config.projectDisplayName, config.project)

  return (
    <box flexDirection='column' width={termWidth} height={termHeight} padding={1} overflow={'hidden' as const}>
      <Logo />
      <box flexDirection='row' gap={1} alignItems='stretch' flexGrow={1} flexShrink={1} overflow={'hidden' as const}>
        {sidebar.length > 0 && (
          <box width={STEP_PANEL_WIDTH} flexShrink={0} flexDirection='column' overflow={'hidden' as const}>
            <text attributes={tuiAttrs({ bold: true })}>Setup Steps</text>
            {sidebar.map((entry) => {
              const marker = entry.isDone ? '✓' : entry.isCurrent ? '❯' : '·'
              const color = entry.isDone ? '#10b981' : entry.isCurrent ? '#22d3ee' : '#6b7280'
              return (
                <text key={entry.id} fg={color} attributes={tuiAttrs({ bold: entry.isCurrent })}>
                  {marker} {entry.label}
                </text>
              )
            })}
            <box marginTop={1} flexDirection='row'>
              <text attributes={tuiAttrs({ dim: true })}>{progressPrefix} </text>
              <text fg='#22d3ee'>{'█'.repeat(filled)}</text>
              <text attributes={tuiAttrs({ dim: true })}>{'░'.repeat(progressWidth - filled)}</text>
            </box>
          </box>
        )}

        <box flexDirection='column' flexGrow={1} flexShrink={1} overflow={'hidden' as const}>
          <box flexDirection='column' flexShrink={0} marginBottom={1}>
            <text attributes={tuiAttrs({ bold: true })}>{title}</text>
            <text attributes={tuiAttrs({ dim: true })}>{description}</text>
            {banner && <text fg='#f87171'>{banner}</text>}
          </box>

          {showSummary && (
            <box
              border={true}
              borderStyle='rounded'
              borderColor='#30363d'
              paddingLeft={1}
              paddingRight={1}
              paddingTop={0}
              paddingBottom={0}
              marginBottom={1}
              flexDirection='column'
              flexShrink={0}
              gap={1}
            >
              <box flexDirection='row' flexWrap='wrap'>
                <text attributes={tuiAttrs({ dim: true })}>API key </text>
                <text attributes={tuiAttrs({ bold: true })}>{maskedApiKey}</text>
                <text attributes={tuiAttrs({ dim: true })}> · Workspace </text>
                <text attributes={tuiAttrs({ bold: true })}>{workspaceLabel}</text>
                <text attributes={tuiAttrs({ dim: true })}> / </text>
                <text attributes={tuiAttrs({ bold: true })}>{projectLabel}</text>
              </box>
              <box flexDirection='row' flexWrap='wrap'>
                <text attributes={tuiAttrs({ dim: true })}>Dir </text>
                <text>{compactDir}</text>
                <text attributes={tuiAttrs({ dim: true })}> · Model </text>
                <text attributes={tuiAttrs({ bold: true })}>{config.model ?? '—'}</text>
                <text attributes={tuiAttrs({ dim: true })}> ({provider}) · Concurrency </text>
                <text attributes={tuiAttrs({ bold: true })}>{config.maxConcurrentIssues ?? '—'}</text>
              </box>
              <text attributes={tuiAttrs({ dim: true })}>
                Account {account} · Enter confirm · Esc back · Ctrl+C quit
              </text>
            </box>
          )}

          <box flexDirection='column' flexGrow={1} flexShrink={1} overflow={'hidden' as const}>
            {children}
          </box>
        </box>
      </box>
    </box>
  ) as ReactElement
}
