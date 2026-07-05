import { useState, useCallback, useEffect, useMemo, type ReactElement } from 'react'
import { useTerminalDimensions } from '@opentui/react'
import {
  FocusLayer,
  useActiveZone,
  useFocusManager,
  useFocusZone,
  useListNavigation,
  useShortcut,
  useStatusHints
} from '../../lib/focus/index.js'
import type { RuntimeState, SessionDetail } from '../../runtime/types.js'
import type { AgentConfig, AgentChatStatus, LogEntry, IAgent } from '../../types/index.js'
import type { GitSettings } from '../../cli/profile.js'
import { SettingsPanel } from '../SettingsPanel.js'
import { ModelPanel } from '../ModelPanel.js'
import { DashboardHeader } from '../DashboardHeader.js'
import { SessionListPane } from '../panes/SessionListPane.js'
import { SessionDetailPane } from '../panes/SessionDetailPane.js'
import { ChatComposer, type SlashCommand } from '../ChatComposer.js'
import { ContextSidebar } from '../ContextSidebar.js'
import { LogsDock } from '../LogsDock.js'
import { StatusBar } from '../StatusBar.js'
import { demoProcess, type DemoState } from '../../lib/demoProcess.js'
import pkg from '../../../package.json' with { type: 'json' }

// ── Constants ───────────────────────────────────────────────────────────────

/** Below this width, stack sessions vs detail and hide context sidebar. */
const NARROW_BREAKPOINT = 120

/** Below this width, hide the context sidebar even in wide mode. */
const SIDEBAR_BREAKPOINT = 150

const CLI_VERSION = pkg.version

const LIST_ZONE_HINTS = [
  { id: 'nav', keys: '↑↓', label: 'select' },
  { id: 'enter', keys: '↵', label: 'open' }
] as const

const DETAIL_ZONE_HINTS = [
  { id: 'scroll', keys: '↑↓', label: 'scroll' },
  { id: 'page', keys: 'PgUp/Dn', label: 'page' }
] as const

// ── Props ───────────────────────────────────────────────────────────────────

interface Props {
  state: RuntimeState
  config: AgentConfig
  sessionDetails: Map<string, SessionDetail>
  agentLogs: LogEntry[]
  chatStatuses: Map<string, AgentChatStatus | string>
  onQuitRequest: () => void
  onRestartSetupRequest: () => void
  onLoadMessages: (chatId: string, before?: string) => void
  onSendMessage: (chatId: string, content: string) => void
  onAbortChat: (chatId: string) => void
  onSubscribeSession: (chatId: string) => void
  onUnsubscribeSession: (chatId: string) => void
  onLoadMoreSessions?: () => void
  hasMoreSessions?: boolean
  onEmitAgentSettings?: (settings: Partial<NonNullable<IAgent['settings']>>) => void
  onUpdateGitSettings?: (git: GitSettings) => void
  onUpdateModel?: (updates: Partial<AgentConfig>) => void
  onLoadRadarLists?: () => Promise<{ components: string[]; environments: string[] }>
}

// ── Component ───────────────────────────────────────────────────────────────

export function DashboardScreen({
  state,
  config,
  sessionDetails,
  agentLogs,
  chatStatuses,
  onQuitRequest,
  onRestartSetupRequest,
  onLoadMessages,
  onSendMessage,
  onAbortChat,
  onSubscribeSession,
  onUnsubscribeSession,
  onLoadMoreSessions,
  hasMoreSessions = false,
  onEmitAgentSettings,
  onUpdateGitSettings,
  onUpdateModel,
  onLoadRadarLists
}: Props): ReactElement {
  // ── Dimensions ──────────────────────────────────────────────────────────────

  const { width: columns, height: rows } = useTerminalDimensions()
  const isNarrow = columns < NARROW_BREAKPOINT
  const showContextSidebar = columns >= SIDEBAR_BREAKPOINT

  const contentWidth = isNarrow
    ? Math.max(20, columns - 10)
    : showContextSidebar
      ? Math.max(20, columns - 71) // list(32) + sidebar(30) + border(2) + pad(2) + scrollbar(1) + innerPad(2) + gap(2)
      : Math.max(20, columns - 41)
  const listFluidTextWidth = Math.max(16, columns - 10)
  const logBlockHeight = Math.min(28, Math.max(8, rows - 10))

  // ── Focus & selection state ─────────────────────────────────────────────────

  const focusManager = useFocusManager()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [showLogs, setShowLogs] = useState(false)
  const [narrowShowsDetail, setNarrowShowsDetail] = useState(false)
  const [showSettingsPanel, setShowSettingsPanel] = useState(false)
  const [showModelPanel, setShowModelPanel] = useState(false)
  const [radarComponents, setRadarComponents] = useState<string[]>([])
  const [radarEnvironments, setRadarEnvironments] = useState<string[]>([])
  const [radarListError, setRadarListError] = useState<string | null>(null)
  /** Last agent settings applied from this UI (for repopulating the modal). */
  const [settingsSnapshot, setSettingsSnapshot] = useState<Partial<NonNullable<IAgent['settings']>>>({})
  const [gitSettings, setGitSettings] = useState<GitSettings>(() => config.git ?? {})
  const [demoState, setDemoState] = useState<DemoState>(() => demoProcess.getState())
  /** Live model selection, mirrored locally so the header updates immediately on change. */
  const [modelSettings, setModelSettings] = useState<Partial<Pick<AgentConfig, 'model' | 'modelKey' | 'modelUrl'>>>(
    () => ({ model: config.model, modelKey: config.modelKey, modelUrl: config.modelUrl })
  )

  // ── Derived values ──────────────────────────────────────────────────────────

  const clampedIndex = Math.min(selectedIndex, Math.max(0, state.sessions.length - 1))
  const selectedSession = state.sessions[clampedIndex]
  const selectedDetail = selectedSession ? (sessionDetails.get(selectedSession.chatId) ?? null) : null
  const selectedChatStatus = selectedSession ? (chatStatuses.get(selectedSession.chatId) ?? null) : null

  const showListPane = !isNarrow || !selectedDetail || !narrowShowsDetail
  const showDetailPane = !isNarrow || Boolean(selectedDetail && narrowShowsDetail)
  const showComposer = showDetailPane && selectedDetail !== null
  const showSidebar = showContextSidebar && showDetailPane
  const hasSessions = state.sessions.length > 0

  const activeCount = state.sessions.filter((s) => !['done', 'failed', 'aborted'].includes(s.status)).length

  // ── Effects ─────────────────────────────────────────────────────────────────

  // Auto-show detail in narrow mode when a session is first selected.
  // (When the session goes away, the composer zone unmounts and the focus
  // manager falls back to the detail zone automatically.)
  useEffect(() => {
    setNarrowShowsDetail(Boolean(selectedDetail))
  }, [selectedDetail?.chatId])

  // Subscribe to chat events when a session is selected; unsubscribe on change.
  useEffect(() => {
    if (!selectedSession) return
    const chatId = selectedSession.chatId
    onSubscribeSession(chatId)
    return () => onUnsubscribeSession(chatId)
  }, [selectedSession?.chatId, onSubscribeSession, onUnsubscribeSession])

  // Load messages when a new session is highlighted.
  useEffect(() => {
    if (selectedSession) onLoadMessages(selectedSession.chatId)
  }, [selectedSession?.chatId])

  // Auto-start the demo dev server for demo projects; subscribe to its state.
  // Stop it when leaving the dashboard so we don't leak a child process.
  useEffect(() => {
    const onChange = (next: DemoState) => setDemoState(next)
    demoProcess.on('change', onChange)
    if (config.isDemoProject && config.dir) demoProcess.start(config.dir)
    return () => {
      demoProcess.off('change', onChange)
      if (config.isDemoProject) demoProcess.stop()
    }
  }, [config.isDemoProject, config.dir])

  const toggleDemo = useCallback(() => {
    demoProcess.toggle()
  }, [])

  // ── Focus zones ─────────────────────────────────────────────────────────────
  // Tab ring = list → detail → composer → sidebar → logs (manager-owned).
  // The list and detail zones live here — they must stay in the ring even in
  // narrow mode where one of the two panes is unmounted. Composer, sidebar and
  // logs zones register inside their components (their mount conditions match
  // the ring's visibility rules).

  const backToList = useCallback(() => {
    if (isNarrow && selectedDetail) setNarrowShowsDetail(false)
    focusManager?.focusZone('list')
    return true
  }, [focusManager, isNarrow, selectedDetail])

  const listZone = useFocusZone({ id: 'list', order: 0, hints: LIST_ZONE_HINTS })
  const detailZone = useFocusZone({
    id: 'detail',
    order: 1,
    fallbackZone: 'list',
    onEscape: backToList,
    hints: DETAIL_ZONE_HINTS
  })

  const activeZone = useActiveZone()

  // ↑↓ select, Enter opens the detail pane — registered here (not in the list
  // pane) so selection keeps working in narrow mode while the pane is hidden.
  useListNavigation({
    zoneId: 'list',
    items: state.sessions,
    index: clampedIndex,
    onIndexChange: setSelectedIndex,
    onActivate: selectedDetail
      ? () => {
          if (isNarrow) setNarrowShowsDetail(true)
          focusManager?.focusZone('detail')
        }
      : undefined,
    activateOnEnterOnly: true
  })

  // In narrow mode only one of the list/detail panes is mounted, so the
  // visible pane must track the focused zone. Drive it off the zone's value,
  // not a transition diff: focusing list shows the list; focusing detail or
  // the composer shows the detail. Logs/sidebar don't own either pane, so they
  // leave the current view untouched (peeking at logs won't flip the view, and
  // closing them restores focus to the prior zone via the manager).
  useEffect(() => {
    if (!isNarrow || !selectedDetail) return
    if (activeZone === 'list') setNarrowShowsDetail(false)
    else if (activeZone === 'detail' || activeZone === 'composer') setNarrowShowsDetail(true)
  }, [activeZone, isNarrow, selectedDetail])

  const toggleLogs = useCallback(() => {
    setShowLogs((show) => {
      // Opening: focus lands on the dock as soon as its zone registers.
      // Closing while focused: the manager restores focus to the prior zone.
      if (!show) focusManager?.focusZone('logs')
      return !show
    })
  }, [focusManager])

  const openSettingsPanel = useCallback(() => {
    if (!onEmitAgentSettings || !onLoadRadarLists) return
    setRadarListError(null)
    setShowSettingsPanel(true)
    void onLoadRadarLists()
      .then(({ components, environments }) => {
        setRadarComponents(components)
        setRadarEnvironments(environments)
      })
      .catch((err: unknown) => {
        setRadarListError(err instanceof Error ? err.message : String(err))
        setRadarComponents([])
        setRadarEnvironments([])
      })
  }, [onEmitAgentSettings, onLoadRadarLists])

  const openModelPanel = useCallback(() => {
    if (!onUpdateModel) return
    setShowModelPanel(true)
  }, [onUpdateModel])

  const applyModel = useCallback(
    (updates: Partial<AgentConfig>) => {
      setModelSettings({ model: updates.model, modelKey: updates.modelKey, modelUrl: updates.modelUrl })
      onUpdateModel?.(updates)
    },
    [onUpdateModel]
  )

  const headerConfig = useMemo(
    () => ({ ...config, model: modelSettings.model ?? config.model }),
    [config, modelSettings.model]
  )

  // 'v' flips the narrow stacked view by moving focus between the list and
  // detail zones; the narrow-sync effect above then swaps the visible pane.
  const toggleNarrowStack = useCallback(() => {
    if (!isNarrow || !selectedDetail) return
    focusManager?.focusZone(narrowShowsDetail ? 'list' : 'detail')
  }, [isNarrow, selectedDetail, narrowShowsDetail, focusManager])

  // ── Slash commands ──────────────────────────────────────────────────────────

  const slashCommands = useMemo((): SlashCommand[] => {
    const cmds: SlashCommand[] = []
    if (onUpdateModel) cmds.push({ command: 'model', description: 'open model selector' })
    cmds.push({ command: 'logs', description: showLogs ? 'hide logs' : 'toggle logs' })
    if (onEmitAgentSettings && onLoadRadarLists) cmds.push({ command: 'settings', description: 'open settings' })
    cmds.push({ command: 'setup', description: 'restart setup' })
    cmds.push({ command: 'quit', description: 'quit' })
    return cmds
  }, [onUpdateModel, showLogs, onEmitAgentSettings, onLoadRadarLists])

  const handleCommand = useCallback(
    (command: string): boolean => {
      switch (command) {
        case 'model':
          if (onUpdateModel) { openModelPanel(); return true }
          return false
        case 'logs':
          toggleLogs()
          return true
        case 'settings':
          if (onEmitAgentSettings && onLoadRadarLists) { openSettingsPanel(); return true }
          return false
        case 'setup':
          onRestartSetupRequest()
          return true
        case 'quit':
          onQuitRequest()
          return true
        default:
          return false
      }
    },
    [onUpdateModel, openModelPanel, toggleLogs, onEmitAgentSettings, onLoadRadarLists, openSettingsPanel, onRestartSetupRequest, onQuitRequest]
  )

  // ── Shortcuts (root layer) ──────────────────────────────────────────────────
  // Suppressed automatically while the composer ('input' zone) is focused and
  // while any modal layer (settings/model/quit) is on top of the stack.

  const canOpenSettings = Boolean(onEmitAgentSettings && onLoadRadarLists)

  // The 'i' hint auto-hides while the composer is focused: it's an input zone,
  // so useStatusHints drops non-reserve single-char shortcuts there.
  useShortcut({
    id: 'compose',
    keys: ['i'],
    label: 'compose',
    displayKeys: 'i',
    order: 10,
    enabled: showComposer,
    run: () => {
      if (isNarrow) setNarrowShowsDetail(true)
      focusManager?.focusZone('composer')
    }
  })
  useShortcut({
    id: 'stack',
    keys: ['v', 'V'],
    label: narrowShowsDetail ? 'sessions' : 'detail',
    displayKeys: 'v',
    order: 20,
    enabled: isNarrow && Boolean(selectedDetail),
    run: toggleNarrowStack
  })
  useShortcut({
    id: 'demo',
    keys: ['d', 'D'],
    label: demoState.status === 'running' || demoState.status === 'starting' ? 'stop demo' : 'start demo',
    displayKeys: 'd',
    order: 30,
    enabled: Boolean(config.isDemoProject),
    run: toggleDemo
  })
  useShortcut({
    id: 'model',
    keys: ['m', 'M'],
    label: 'model',
    displayKeys: 'm',
    order: 40,
    enabled: Boolean(onUpdateModel),
    run: openModelPanel
  })
  useShortcut({
    id: 'logs',
    keys: ['l', 'L'],
    label: showLogs ? 'hide logs' : 'logs',
    displayKeys: 'l',
    order: 50,
    run: toggleLogs
  })
  useShortcut({
    id: 'settings',
    keys: ['s', 'S'],
    label: 'settings',
    displayKeys: 's',
    order: 60,
    enabled: canOpenSettings,
    run: openSettingsPanel
  })
  useShortcut({
    id: 'setup',
    keys: ['r', 'R'],
    label: 'setup',
    displayKeys: 'r',
    order: 70,
    run: onRestartSetupRequest
  })
  useShortcut({
    id: 'quit',
    keys: ['q', 'Q'],
    label: 'quit',
    displayKeys: 'q',
    order: 80,
    run: onQuitRequest
  })

  // ── Status bar hints ────────────────────────────────────────────────────────
  // Derived from the focus registry: Tab + active-zone nav hints + the
  // labelled shortcuts registered above (clicking a hint runs its shortcut).

  const hints = useStatusHints()

  // Resolve display names for sidebar
  const workspaceLabel =
    state.workspaceDisplayName?.trim() ||
    config.workspaceDisplayName?.trim() ||
    (config.workspace ? config.workspace.slice(-8) : '')
  const projectLabel =
    state.projectDisplayName?.trim() ||
    config.projectDisplayName?.trim() ||
    (config.project ? config.project.slice(-8) : '')

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <box position='relative' flexDirection='column' height={rows} width={columns} gap={0}>
      {/* Header - slim single line */}
      <DashboardHeader state={state} config={headerConfig} isNarrow={isNarrow} />

      {/* Main content: sidebar + detail + context */}
      <box flexDirection='row' flexGrow={1} gap={showListPane && showDetailPane ? 1 : 0}>
        {showListPane && (
          <SessionListPane
            sessions={state.sessions}
            selectedIndex={clampedIndex}
            isFocused={listZone.isActive}
            layout={isNarrow ? 'fluid' : 'sidebar'}
            fluidTextWidth={listFluidTextWidth}
            onSelectSession={(index) => {
              setSelectedIndex(index)
              listZone.focus()
            }}
            hasMore={hasMoreSessions}
            onLoadMore={onLoadMoreSessions}
          />
        )}

        {showDetailPane && (
          <box flexDirection='column' flexGrow={1}>
            <SessionDetailPane
              session={selectedDetail}
              contentWidth={contentWidth}
              isFocused={detailZone.isActive}
              hasSessions={hasSessions}
              isDemoProject={config.isDemoProject}
              demoDir={config.dir}
              workspace={config.workspace}
              project={config.project}
              demoStatus={demoState.status}
              demoUrl={demoState.url}
              demoError={demoState.error}
              apiUrl={config.url}
              onRequestFocus={detailZone.focus}
              onRequestLoadMore={() =>
                selectedDetail?.messages[0]?.id &&
                onLoadMessages(selectedSession?.chatId ?? '', selectedDetail.messages[0].id)
              }
            />
            {showComposer && (
              <ChatComposer
                chatId={selectedSession?.chatId ?? null}
                chatStatus={selectedChatStatus}
                width={contentWidth}
                onSend={onSendMessage}
                onAbort={onAbortChat}
                slashCommands={slashCommands}
                onCommand={handleCommand}
              />
            )}
          </box>
        )}

        {/* Context sidebar - right panel (wide screens only) */}
        {showSidebar && (
          <ContextSidebar
            session={selectedDetail}
            chatStatus={selectedChatStatus}
            workspace={workspaceLabel || undefined}
            project={projectLabel || undefined}
            workspaceId={config.workspace || undefined}
            projectId={config.project || undefined}
            apiUrl={config.url}
            rateLimitState={state.rateLimitState}
            activeCount={activeCount}
            resolvedCount={state.resolvedCount}
            gitSettings={gitSettings}
            onOpenSettings={canOpenSettings ? openSettingsPanel : undefined}
            isDemoProject={config.isDemoProject}
            demoStatus={demoState.status}
            demoUrl={demoState.url}
            demoError={demoState.error}
            onToggleDemo={config.isDemoProject ? toggleDemo : undefined}
          />
        )}
      </box>

      {/* Logs dock (toggleable) */}
      {showLogs && <LogsDock logs={agentLogs} height={logBlockHeight} onEscape={backToList} />}

      {/* Status bar - clean single line at bottom */}
      <StatusBar hints={hints} version={CLI_VERSION} />

      {showSettingsPanel && canOpenSettings && (
        <FocusLayer id='settings' onDismiss={() => setShowSettingsPanel(false)}>
          <SettingsPanel
            components={radarComponents}
            environments={radarEnvironments}
            loadError={radarListError}
            initialSettings={settingsSnapshot}
            initialGitSettings={gitSettings}
            onClose={() => setShowSettingsPanel(false)}
            onApply={(settings) => {
              setSettingsSnapshot((prev) => ({ ...prev, ...settings }))
              onEmitAgentSettings?.(settings)
            }}
            onApplyGitSettings={(git) => {
              setGitSettings((prev) => ({ ...prev, ...git }))
              onUpdateGitSettings?.(git)
            }}
          />
        </FocusLayer>
      )}

      {showModelPanel && onUpdateModel && (
        <FocusLayer id='model' onDismiss={() => setShowModelPanel(false)}>
          <ModelPanel config={headerConfig} onApply={applyModel} onClose={() => setShowModelPanel(false)} />
        </FocusLayer>
      )}
    </box>
  ) as ReactElement
}
