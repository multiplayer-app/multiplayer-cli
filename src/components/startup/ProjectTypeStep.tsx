import { useMemo, useState, type ReactElement } from 'react'
import { useKeyboard } from '@opentui/react'
import path from 'path'
import { tuiAttrs } from '../../lib/tuiAttrs.js'
import type { AgentConfig } from '../../types/index.js'
import { FooterHints, SelectionList, type SelectionItem } from '../shared/index.js'
import { listProjects, loadProfile, touchProject, type ProjectEntry } from '../../cli/profile.js'
import { OAuthManager } from '../../auth/oauth-manager.js'

export type FlowChoice =
  | { kind: 'demo'; updates: Partial<AgentConfig>; accountName?: string }
  | { kind: 'regular'; updates: Partial<AgentConfig>; accountName?: string }

interface Props {
  onComplete: (choice: FlowChoice) => void
}

type PrimaryNavItem = { kind: 'existing' } | { kind: 'example' }
type ProjectNavItem = { kind: 'project'; entry: ProjectEntry }
type NavItem = ProjectNavItem | PrimaryNavItem

const PRIMARY_NAV_ITEMS: PrimaryNavItem[] = [{ kind: 'example' }, { kind: 'existing' }]
const PRIMARY_SELECTION_ITEMS: SelectionItem[] = [
  {
    key: 'example',
    icon: '◇',
    iconColor: '#f59e0b',
    label: 'Try a demo',
    description: 'Clone and explore the Multiplayer demo app',
  },
  {
    key: 'existing',
    icon: '◆',
    iconColor: '#22d3ee',
    label: 'Setup existing project',
    description: 'Link an existing repository to Multiplayer',
  },
]

/**
 * Resolves a registered project entry (recent project) into the config updates
 * and account name to seed the flow with. Returns null if OAuth refresh failed
 * — caller falls back to a fresh auth flow for the same dir.
 */
async function loadRecentProjectUpdates(
  entry: ProjectEntry,
): Promise<{ updates: Partial<AgentConfig>; accountName: string }> {
  touchProject(entry.path)
  const profile = loadProfile(entry.account, entry.path)
  let apiKey = profile.apiKey

  if (profile.authType === 'oauth') {
    const token = await new OAuthManager(entry.account).getAccessToken()
    if (!token) {
      // No token available — flow will start at auth-method to re-authenticate.
      return {
        updates: { dir: entry.path, isDemoProject: entry.demo ?? false },
        accountName: entry.account,
      }
    }
    apiKey = token
  }

  return {
    updates: {
      url: profile.url,
      dir: profile.dir ?? entry.path,
      apiKey,
      authType: profile.authType,
      workspace: profile.workspace,
      project: profile.project,
      model: profile.model,
      modelKey: profile.modelKey,
      modelUrl: profile.modelUrl,
      maxConcurrentIssues: profile.maxConcurrentIssues,
      sessionRecorderSetupDone: profile.sessionRecorderSetupDone,
      sessionRecorderStacks: profile.sessionRecorderStacks,
      isDemoProject: entry.demo ?? false,
      demoSetupDone: entry.demo ? true : undefined,
      git: profile.git,
    },
    accountName: entry.account,
  }
}

export function ProjectTypeStep({ onComplete }: Props): ReactElement {
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const registeredProjects = useMemo(() => listProjects(), [])
  const projectNavItems = useMemo<ProjectNavItem[]>(
    () => registeredProjects.map((entry) => ({ kind: 'project', entry })),
    [registeredProjects],
  )
  const navItems = useMemo<NavItem[]>(() => [...PRIMARY_NAV_ITEMS, ...projectNavItems], [projectNavItems])

  const projectSelectionItems = useMemo<SelectionItem[]>(
    () =>
      projectNavItems.map((item) => {
        const entry = item.entry
        return {
          key: `project:${entry.account}:${entry.path}`,
          icon: '◆',
          iconColor: '#22d3ee',
          label: path.basename(entry.path),
          description: `${entry.path} · ${entry.account}`,
        }
      }),
    [projectNavItems],
  )

  const handleSelect = (idx: number) => {
    const item = navItems[idx]
    if (!item) return

    if (item.kind === 'existing') {
      onComplete({ kind: 'regular', updates: {} })
      return
    }
    // Resolve which project entry to load: an explicitly selected recent
    // project, or — when re-selecting "Try a demo" — the most recent existing
    // demo so we reuse it instead of cloning/setting up again.
    const entry =
      item.kind === 'project'
        ? item.entry
        : registeredProjects.find((p) => p.demo)

    if (item.kind === 'example' && !entry) {
      onComplete({ kind: 'demo', updates: {} })
      return
    }
    if (!entry) return

    setLoading(true)
    void (async () => {
      try {
        const { updates, accountName } = await loadRecentProjectUpdates(entry)
        onComplete({
          kind: entry.demo ? 'demo' : 'regular',
          updates,
          accountName,
        })
      } catch (err) {
        setError((err as Error).message)
        setLoading(false)
      }
    })()
  }

  useKeyboard((key) => {
    const { name } = key
    if (error && name === 'escape') {
      setError(null)
      key.stopPropagation()
      return
    }
    if (loading) return
    if (name === 'up' || name === 'k') setSelected((s) => Math.max(0, s - 1))
    else if (name === 'down' || name === 'j') setSelected((s) => Math.min(navItems.length - 1, s + 1))
    else if (name === 'return') handleSelect(selected)
  })

  if (error) {
    return (
      <box flexDirection='column' gap={1}>
        <text fg='#ef4444'>✗ {error}</text>
        <FooterHints hints='Esc back' />
      </box>
    ) as ReactElement
  }

  if (loading) {
    return (
      <box flexDirection='column' gap={1}>
        <text fg='#f59e0b'>◌ Loading project...</text>
      </box>
    ) as ReactElement
  }

  return (
    <box flexDirection='column' flexGrow={1} flexShrink={1} gap={1} overflow={'hidden' as const}>
      <SelectionList
        items={PRIMARY_SELECTION_ITEMS}
        selectedIndex={selected < PRIMARY_NAV_ITEMS.length ? selected : -1}
        onSelect={handleSelect}
        flexGrow={0}
        scrollable={false}
      />
      {projectSelectionItems.length > 0 && (
        <>
          <box flexShrink={0}>
            <text attributes={tuiAttrs({ bold: true })}>Recent projects</text>
          </box>
          <SelectionList
            items={projectSelectionItems}
            selectedIndex={selected >= PRIMARY_NAV_ITEMS.length ? selected - PRIMARY_NAV_ITEMS.length : -1}
            onSelect={(idx) => handleSelect(idx + PRIMARY_NAV_ITEMS.length)}
            flexGrow={1}
          />
        </>
      )}
      <FooterHints hints='↑↓ navigate · Enter select · Click to select' />
    </box>
  ) as ReactElement
}
