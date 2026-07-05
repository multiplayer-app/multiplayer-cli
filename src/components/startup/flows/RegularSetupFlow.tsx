import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useKeyboard } from '@opentui/react'
import type { AgentConfig } from '../../../types/index.js'
import { API_URL } from '../../../config.js'
import { createApiService } from '../../../services/api.service.js'
import { listAccounts, readProjectSettings } from '../../../cli/profile.js'
import { persistSetupState } from '../../../cli/setup-persistence.js'
import { SetupShell, type SidebarEntry } from '../SetupShell.js'
import { AccountSelectStep } from '../AccountSelectStep.js'
import { AuthMethodStep } from '../AuthMethodStep.js'
import { ProjectSelectStep, type SelectableWorkspace } from '../ProjectSelectStep.js'
import { WorkspaceStep } from '../WorkspaceStep.js'
import { DirectoryStep } from '../DirectoryStep.js'
import { ModelStep } from '../ModelStep.js'
import { RateLimitsStep } from '../RateLimitsStep.js'
import { MultiplayerSdkStep } from '../MultiplayerSdkStep.js'
import { ConnectingStep } from '../ConnectingStep.js'

// ─── Step definitions ─────────────────────────────────────────────────────────

type StepId =
  | 'account-select'
  | 'auth-method'
  | 'project-select'
  | 'workspace'
  | 'directory'
  | 'model'
  | 'rate-limits'
  | 'session-recorder'
  | 'connecting'

interface StepMeta {
  title: string
  description: string
  shortLabel: string
  sidebarGroup?: string
  applicable?: (c: Partial<AgentConfig>) => boolean
  canSkip: (c: Partial<AgentConfig>) => boolean
}

const STEP_DEFS: Record<StepId, StepMeta> = {
  'account-select': {
    title: 'Select Account',
    description: 'Link this project to an existing Multiplayer account or add a new one.',
    shortLabel: 'Account',
    sidebarGroup: 'auth',
    canSkip: (c) => listAccounts().length === 0 || (!!c.apiKey && !!c.workspace && !!c.project),
  },
  'auth-method': {
    title: 'Authentication',
    description: 'Choose how to authenticate with Multiplayer.',
    shortLabel: 'Auth',
    sidebarGroup: 'auth',
    canSkip: (c) => !!c.apiKey,
  },
  'project-select': {
    title: 'Select Project',
    description: 'Choose the project this agent will monitor.',
    shortLabel: 'Project',
    sidebarGroup: 'auth',
    canSkip: (c) => {
      if (c.authType === 'oauth' && !(c.workspace && c.project)) return false
      return !!(c.workspace && c.project)
    },
  },
  workspace: {
    title: 'Workspace Confirmation',
    description: 'Review the workspace and project that will receive agent updates.',
    shortLabel: 'Workspace',
    sidebarGroup: 'auth',
    canSkip: (c) => !!(c.workspace && c.project && c.apiKey),
  },
  directory: {
    title: 'Repository Directory',
    description: 'Select the git repository where patches, commits, and branches are created.',
    shortLabel: 'Directory',
    canSkip: (c) => !!c.dir,
  },
  model: {
    title: 'AI Model',
    description: 'Choose an AI provider and model for issue resolution.',
    shortLabel: 'Model',
    canSkip: (c) => !!(c.model && (c.model.startsWith('claude') || c.modelKey)),
  },
  'rate-limits': {
    title: 'Concurrency',
    description: 'Set how many issues can be processed in parallel.',
    shortLabel: 'Concurrency',
    canSkip: (c) => typeof c.maxConcurrentIssues === 'number',
  },
  'session-recorder': {
    title: 'Session Recorder',
    description: 'Detect your app stack and set up the Multiplayer Session Recorder SDK.',
    shortLabel: 'Multiplayer SDK',
    applicable: () => !process.env.MULTIPLAYER_SKIP_SR_SETUP,
    canSkip: (c) => !!c.sessionRecorderSetupDone || !!process.env.MULTIPLAYER_SKIP_SR_SETUP,
  },
  connecting: {
    title: 'Final Checks',
    description: 'Verify git and provider requirements before starting runtime.',
    shortLabel: 'Verify',
    canSkip: () => false,
  },
}

const STEPS = Object.keys(STEP_DEFS) as StepId[]

// ─── Route map ────────────────────────────────────────────────────────────────

function prevStep(current: StepId, config: Partial<AgentConfig>): StepId | null {
  switch (current) {
    case 'account-select':
      return null
    case 'auth-method':
      return listAccounts().length > 0 ? 'account-select' : null
    case 'project-select':
      return 'auth-method'
    case 'workspace':
      return config.authType === 'oauth' ? 'project-select' : 'auth-method'
    case 'directory':
      return config.authType === 'oauth' ? 'project-select' : 'auth-method'
    case 'model':
      return 'directory'
    case 'rate-limits':
      return 'model'
    case 'session-recorder':
      return 'rate-limits'
    case 'connecting':
      return 'session-recorder'
  }
}

function nextStep(after: StepId, config: Partial<AgentConfig>): StepId {
  const idx = STEPS.indexOf(after)
  for (let i = idx + 1; i < STEPS.length; i++) {
    const def = STEP_DEFS[STEPS[i]!]!
    if (def.applicable && !def.applicable(config)) continue
    if (!def.canSkip(config)) return STEPS[i]!
  }
  return 'connecting'
}

function firstRequiredStep(config: Partial<AgentConfig>): StepId {
  for (const s of STEPS) {
    const def = STEP_DEFS[s]
    if (def.applicable && !def.applicable(config)) continue
    if (!def.canSkip(config)) return s
  }
  return 'connecting'
}

const SELF_NAVIGATING_STEPS: Set<StepId> = new Set(['project-select', 'model'])

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  initialConfig: Partial<AgentConfig>
  profileName?: string
  initialAccount?: string
  authErrorMessage?: string | null
  onComplete: (config: AgentConfig) => void
  onBackToTypeSelection: () => void
}

export function RegularSetupFlow({
  initialConfig,
  profileName,
  initialAccount,
  authErrorMessage,
  onComplete,
  onBackToTypeSelection,
}: Props): ReactElement | null {
  const [config, setConfig] = useState<Partial<AgentConfig>>(initialConfig)
  const [step, setStep] = useState<StepId>(() => firstRequiredStep(initialConfig))
  const [account, setAccount] = useState(initialAccount ?? profileName ?? 'default')
  const [oauthWorkspaces, setOauthWorkspaces] = useState<SelectableWorkspace[]>([])
  const [fetchingWorkspaces, setFetchingWorkspaces] = useState(false)
  const [oauthApi, setOauthApi] = useState<ReturnType<typeof createApiService> | null>(null)

  const advance = useCallback(
    (updates: Partial<AgentConfig>, accountOverride?: string) => {
      const effectiveAccount = accountOverride ?? account
      if (accountOverride) setAccount(accountOverride)

      // When the directory is first set, merge any existing project settings so
      // that fields like model/modelKey saved from a previous session are pre-filled.
      const dirJustSet = updates.dir && updates.dir !== config.dir
      const existingProjectSettings = dirJustSet ? readProjectSettings(updates.dir!) : {}

      const merged = { ...existingProjectSettings, ...config, ...updates }
      const extras = persistSetupState(merged, { account: effectiveAccount, isDemoFlow: false })
      const next = { ...merged, ...extras }
      setConfig(next)
      setStep(nextStep(step, next))
    },
    [config, step, account],
  )

  const handleAuthComplete = useCallback(
    (updates: Partial<AgentConfig> & { _oauthWorkspaces?: SelectableWorkspace[]; _accountName?: string }) => {
      if (updates._accountName) setAccount(updates._accountName)

      if (updates._oauthWorkspaces) {
        const workspaces = updates._oauthWorkspaces
        setOauthWorkspaces(workspaces)
        const next = {
          ...config,
          apiKey: updates.apiKey,
          authType: updates.authType,
          ...(updates.url ? { url: updates.url } : {}),
        }
        setConfig(next)
        const resolvedUrl = next.url || API_URL
        setOauthApi(createApiService({ url: resolvedUrl, apiKey: '', bearerToken: updates.apiKey! }))
        setStep('project-select')
      } else {
        advance(updates, updates._accountName)
      }
    },
    [config, advance],
  )

  const goBack = useCallback(() => {
    const prev = prevStep(step, config)
    if (prev) setStep(prev)
    else onBackToTypeSelection()
  }, [step, config, onBackToTypeSelection])

  useKeyboard(({ name }) => {
    if (name !== 'escape' || SELF_NAVIGATING_STEPS.has(step)) return
    goBack()
  })

  useEffect(() => {
    if (step !== 'project-select' || oauthWorkspaces.length > 0 || fetchingWorkspaces) return
    const apiKey = config.apiKey?.trim()
    if (!apiKey) return

    setFetchingWorkspaces(true)
    const url = config.url || API_URL
    const api = createApiService({ url, apiKey: '', bearerToken: apiKey })
    setOauthApi(api)
    void api
      .fetchUserSession()
      .then(async (session) => {
        const workspaces: SelectableWorkspace[] = await Promise.all(
          session.workspaces.map(async (ws) => ({
            _id: ws._id,
            name: ws.name,
            projects: (await api.fetchProjects(ws._id)).filter((p) => !!p._id && !!p.name),
          })),
        )
        setConfig((c) => ({ ...c, authType: 'oauth' }))
        setOauthWorkspaces(workspaces)
      })
      .catch(() => {
        /* empty list handled by ProjectSelectStep */
      })
      .finally(() => setFetchingWorkspaces(false))
  }, [step])

  useEffect(() => {
    const url = config.url || API_URL
    const apiKey = config.apiKey?.trim()
    const { workspace, project } = config
    if (!apiKey || !workspace || !project) return

    let cancelled = false
    void (async () => {
      try {
        const api = createApiService({ url, apiKey })
        const [ws, proj] = await Promise.all([
          api.fetchWorkspace(workspace),
          api.fetchProject(workspace, project),
        ])
        if (cancelled) return
        const workspaceDisplayName = ws?.name?.trim()
        const projectDisplayName = proj?.name?.trim()
        if (!workspaceDisplayName && !projectDisplayName) return
        setConfig((c) => {
          if (c.apiKey?.trim() !== apiKey || c.workspace !== workspace || c.project !== project) return c
          return {
            ...c,
            ...(workspaceDisplayName ? { workspaceDisplayName } : {}),
            ...(projectDisplayName ? { projectDisplayName } : {}),
          }
        })
      } catch {
        /* non-fatal */
      }
    })()

    return () => {
      cancelled = true
    }
  }, [config.apiKey, config.workspace, config.project, config.url])

  // ── Sidebar ───────────────────────────────────────────────────────────────

  const currentStepIndex = STEPS.indexOf(step)
  const visibleSteps = STEPS.filter((s, i) => {
    const def = STEP_DEFS[s]
    if (def.applicable && !def.applicable(config)) return false
    return i <= currentStepIndex || !def.canSkip(config) || s === 'connecting'
  })
  const currentVisibleIndex = visibleSteps.indexOf(step)

  const sidebar: SidebarEntry[] = []
  const groupsSeen = new Set<string>()

  for (const s of visibleSteps) {
    const def = STEP_DEFS[s]
    const group = def.sidebarGroup
    if (group) {
      if (groupsSeen.has(group)) continue
      groupsSeen.add(group)
      const lastGroupIdx = visibleSteps.reduce((acc, vs, i) => (STEP_DEFS[vs].sidebarGroup === group ? i : acc), -1)
      const anyGroupCurrent = visibleSteps.some(
        (vs) => STEP_DEFS[vs].sidebarGroup === group && vs === step,
      )
      sidebar.push({
        id: `group-${group}`,
        label: 'Auth',
        isDone: lastGroupIdx < currentVisibleIndex,
        isCurrent: anyGroupCurrent,
      })
    } else {
      const i = visibleSteps.indexOf(s)
      sidebar.push({
        id: s,
        label: def.shortLabel,
        isDone: i < currentVisibleIndex,
        isCurrent: s === step,
      })
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const meta = STEP_DEFS[step]
  const banner = authErrorMessage && step === 'auth-method'
    ? 'Session expired or unauthorized — please sign in again.'
    : null

  return (
    <SetupShell
      title={meta.title}
      description={meta.description}
      config={config}
      account={account}
      sidebar={sidebar}
      banner={banner}
    >
      {step === 'account-select' && (
        <AccountSelectStep
          url={config.url || API_URL}
          onComplete={handleAuthComplete}
          onAddNew={() => setStep('auth-method')}
          onBack={goBack}
        />
      )}
      {step === 'auth-method' && (
        <AuthMethodStep
          config={config}
          url={config.url || API_URL}
          profileName={profileName}
          onComplete={handleAuthComplete}
          onBack={goBack}
        />
      )}
      {step === 'project-select' && (
        <ProjectSelectStep
          workspaces={oauthWorkspaces}
          profileName={profileName}
          loading={fetchingWorkspaces}
          onComplete={advance}
          onBack={goBack}
          onCreateWorkspace={
            oauthApi
              ? async (name, handle) => {
                const ws = await oauthApi.createWorkspace(name, handle)
                return { _id: ws._id!, name: ws.name!, projects: [] }
              }
              : undefined
          }
          onCreateProject={
            oauthApi ? async (workspaceId, name) => oauthApi.createProject(workspaceId, name) : undefined
          }
        />
      )}
      {step === 'workspace' && <WorkspaceStep config={config} onComplete={advance} />}
      {step === 'directory' && <DirectoryStep config={config} onComplete={advance} />}
      {step === 'model' && <ModelStep config={config} onComplete={advance} onBack={goBack} />}
      {step === 'rate-limits' && <RateLimitsStep config={config} onComplete={advance} />}
      {step === 'session-recorder' && (
        <MultiplayerSdkStep config={config} onComplete={advance} onBack={goBack} />
      )}
      {step === 'connecting' && (
        <ConnectingStep config={config as AgentConfig} onComplete={onComplete} onBack={goBack} onChangeModel={() => setStep('model')} />
      )}
    </SetupShell>
  ) as ReactElement
}
