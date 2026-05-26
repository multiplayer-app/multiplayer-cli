import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useKeyboard } from '@opentui/react'
import type { AgentConfig } from '../../../types/index.js'
import { API_URL } from '../../../config.js'
import { createApiService } from '../../../services/api.service.js'
import { listAccounts, readCredentials } from '../../../cli/profile.js'
import { persistSetupState } from '../../../cli/setup-persistence.js'
import { SetupShell, type SidebarEntry } from '../SetupShell.js'
import { DemoCloneStep } from '../DemoCloneStep.js'
import { AccountSelectStep } from '../AccountSelectStep.js'
import { AuthMethodStep } from '../AuthMethodStep.js'
import { ProjectSelectStep, type SelectableWorkspace } from '../ProjectSelectStep.js'
import { ModelStep } from '../ModelStep.js'
import { DemoSetupStep } from '../DemoSetupStep.js'
import { ConnectingStep } from '../ConnectingStep.js'

// ─── Step definitions ─────────────────────────────────────────────────────────

type StepId =
  | 'clone'
  | 'account-select'
  | 'auth-method'
  | 'project-select'
  | 'model'
  | 'demo-setup'
  | 'connecting'

interface StepMeta {
  title: string
  description: string
  shortLabel: string
  sidebarGroup?: string
  hideFromSidebar?: boolean
  canSkip: (c: Partial<AgentConfig>) => boolean
}

const STEP_DEFS: Record<StepId, StepMeta> = {
  clone: {
    title: 'Preparing Demo',
    description: 'Cloning (or updating) the Multiplayer demo repository.',
    shortLabel: 'Repository',
    canSkip: (c) => !!c.dir && !!c.isDemoProject,
  },
  'account-select': {
    title: 'Select Account',
    description: 'Link this demo to an existing Multiplayer account or add a new one.',
    shortLabel: 'Account',
    sidebarGroup: 'auth',
    canSkip: (c) => listOauthAccounts().length === 0 || (!!c.apiKey && !!c.workspace && !!c.project),
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
    description: 'Choose the project this demo will report into.',
    shortLabel: 'Project',
    sidebarGroup: 'auth',
    canSkip: (c) => !!(c.workspace && c.project),
  },
  model: {
    title: 'AI Model',
    description: 'Choose an AI provider and model for issue resolution.',
    shortLabel: 'Model',
    canSkip: (c) => !!(c.model && (c.model.startsWith('claude') || c.modelKey)),
  },
  'demo-setup': {
    title: 'Preparing Demo App',
    description: 'Configure the cloned demo app before starting the agent.',
    shortLabel: 'Prepare Demo',
    hideFromSidebar: true,
    canSkip: (c) => !!c.demoSetupDone,
  },
  connecting: {
    title: 'Final Checks',
    description: 'Verify git and provider requirements before starting runtime.',
    shortLabel: 'Verify',
    canSkip: () => false,
  },
}

const STEPS = Object.keys(STEP_DEFS) as StepId[]

function listOauthAccounts(): string[] {
  return listAccounts().filter((name) => readCredentials(name).authType === 'oauth')
}

// ─── Route map ────────────────────────────────────────────────────────────────

function prevStep(current: StepId): StepId | null {
  switch (current) {
    case 'clone':
      return null
    case 'account-select':
      return 'clone'
    case 'auth-method':
      return listOauthAccounts().length > 0 ? 'account-select' : 'clone'
    case 'project-select':
      return 'auth-method'
    case 'model':
      return 'project-select'
    case 'demo-setup':
      return 'model'
    case 'connecting':
      return 'demo-setup'
  }
}

function nextStep(after: StepId, config: Partial<AgentConfig>): StepId {
  const idx = STEPS.indexOf(after)
  for (let i = idx + 1; i < STEPS.length; i++) {
    if (!STEP_DEFS[STEPS[i]!].canSkip(config)) return STEPS[i]!
  }
  return 'connecting'
}

function firstRequiredStep(config: Partial<AgentConfig>): StepId {
  for (const s of STEPS) {
    if (!STEP_DEFS[s].canSkip(config)) return s
  }
  return 'connecting'
}

// `clone` runs its own internal lifecycle; pressing Esc inside it goes back to
// the project-type screen rather than navigating between flow steps.
const SELF_NAVIGATING_STEPS: Set<StepId> = new Set(['clone', 'project-select'])

const DEMO_PROJECT_NAME = 'multiplayer-demo'

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  initialConfig: Partial<AgentConfig>
  profileName?: string
  initialAccount?: string
  authErrorMessage?: string | null
  onComplete: (config: AgentConfig) => void
  onBackToTypeSelection: () => void
}

export function DemoSetupFlow({
  initialConfig,
  profileName,
  initialAccount,
  authErrorMessage,
  onComplete,
  onBackToTypeSelection,
}: Props): ReactElement | null {
  const [config, setConfig] = useState<Partial<AgentConfig>>({ ...initialConfig, isDemoProject: true })
  const [step, setStep] = useState<StepId>(() => firstRequiredStep({ ...initialConfig, isDemoProject: true }))
  const [account, setAccount] = useState(initialAccount ?? profileName ?? 'default')
  const [oauthWorkspaces, setOauthWorkspaces] = useState<SelectableWorkspace[]>([])
  const [fetchingWorkspaces, setFetchingWorkspaces] = useState(false)
  const [projectCreating, setProjectCreating] = useState(false)
  const [oauthApi, setOauthApi] = useState<ReturnType<typeof createApiService> | null>(null)
  const demoAutoCreationStartedRef = useRef(false)

  const advance = useCallback(
    (updates: Partial<AgentConfig>, accountOverride?: string) => {
      const effectiveAccount = accountOverride ?? account
      if (accountOverride) setAccount(accountOverride)

      const merged = { ...config, ...updates, isDemoProject: true }
      const extras = persistSetupState(merged, { account: effectiveAccount, isDemoFlow: true })
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

        const baseConfig = {
          ...config,
          apiKey: updates.apiKey,
          authType: updates.authType,
          ...(updates.url ? { url: updates.url } : {}),
        }
        const resolvedUrl = baseConfig.url || API_URL
        const api = createApiService({ url: resolvedUrl, apiKey: '', bearerToken: updates.apiKey! })
        setOauthApi(api)

        const effectiveAccount = updates._accountName ?? account

        if (workspaces.length === 1) {
          const ws = workspaces[0]!
          const existing = ws.projects.find((p) => p.name === DEMO_PROJECT_NAME)

          const applyProject = (proj: { _id: string; name: string }) => {
            const merged = {
              ...baseConfig,
              workspace: ws._id,
              project: proj._id,
              workspaceDisplayName: ws.name,
              projectDisplayName: proj.name,
            }
            const extras = persistSetupState(merged, { account: effectiveAccount, isDemoFlow: true })
            const final = { ...merged, ...extras }
            setConfig(final)
            setStep(nextStep(step, final))
          }

          if (existing) {
            applyProject(existing)
          } else {
            demoAutoCreationStartedRef.current = true
            setProjectCreating(true)
            // Persist auth state immediately so a crash during creation doesn't lose the token type.
            const authExtras = persistSetupState(baseConfig, { account: effectiveAccount, isDemoFlow: true })
            setConfig({ ...baseConfig, ...authExtras })
            void api
              .createProject(ws._id, DEMO_PROJECT_NAME)
              .then((proj) => {
                setProjectCreating(false)
                applyProject(proj)
              })
              .catch(() => {
                setProjectCreating(false)
                demoAutoCreationStartedRef.current = false
                setStep('project-select')
              })
          }
        } else {
          setConfig(baseConfig)
          setStep('project-select')
        }
      } else {
        advance(updates, updates._accountName)
      }
    },
    [config, step, account, advance],
  )

  const goBack = useCallback(() => {
    const prev = prevStep(step)
    if (prev) setStep(prev)
    else onBackToTypeSelection()
  }, [step, onBackToTypeSelection])

  useKeyboard(({ name }) => {
    if (name !== 'escape' || SELF_NAVIGATING_STEPS.has(step) || projectCreating) return
    goBack()
  })

  // OAuth path: fetch workspaces when landing on project-select with an api key
  // but no workspaces (e.g. resuming a flow with only the bearer token loaded).
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

  // Resume fallback: if we land on project-select with exactly one workspace
  // (e.g. user has a stored bearer token but no workspace/project saved),
  // select or create the "multiplayer-demo" project automatically.
  //
  // `advance` is intentionally omitted from deps: demoAutoCreationStartedRef
  // guards against double-invocation, so a stale `advance` is never re-called.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (
      step !== 'project-select' ||
      oauthWorkspaces.length !== 1 ||
      !oauthApi ||
      demoAutoCreationStartedRef.current
    ) return

    demoAutoCreationStartedRef.current = true
    const ws = oauthWorkspaces[0]!
    const existing = ws.projects.find((p) => p.name === DEMO_PROJECT_NAME)

    if (existing) {
      advance({
        workspace: ws._id,
        project: existing._id,
        workspaceDisplayName: ws.name,
        projectDisplayName: existing.name,
      })
      return
    }

    setFetchingWorkspaces(true)
    void oauthApi
      .createProject(ws._id, DEMO_PROJECT_NAME)
      .then((proj) => {
        advance({
          workspace: ws._id,
          project: proj._id,
          workspaceDisplayName: ws.name,
          projectDisplayName: proj.name,
        })
      })
      .catch(() => {
        demoAutoCreationStartedRef.current = false
        setFetchingWorkspaces(false)
      })
  }, [step, oauthWorkspaces, oauthApi])

  // Fetch human-readable workspace/project names for the summary card.
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
    if (def.hideFromSidebar) return false
    return i <= currentStepIndex || !def.canSkip(config) || s === 'connecting'
  })

  let effectiveStep: StepId = step
  if (!visibleSteps.includes(step)) {
    for (let i = currentStepIndex + 1; i < STEPS.length; i++) {
      if (visibleSteps.includes(STEPS[i]!)) {
        effectiveStep = STEPS[i]!
        break
      }
    }
  }
  const currentVisibleIndex = visibleSteps.indexOf(effectiveStep)

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
        (vs) => STEP_DEFS[vs].sidebarGroup === group && vs === effectiveStep,
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
        isCurrent: s === effectiveStep,
      })
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const meta = STEP_DEFS[step]
  const banner = authErrorMessage && step === 'auth-method'
    ? 'Session expired or unauthorized — please sign in again.'
    : null

  const shellTitle = projectCreating ? 'Setting Up Demo' : meta.title
  const shellDescription = projectCreating
    ? `Creating your "${DEMO_PROJECT_NAME}" project…`
    : meta.description

  return (
    <SetupShell
      title={shellTitle}
      description={shellDescription}
      config={config}
      account={account}
      sidebar={sidebar}
      banner={banner}
      showSummary={step !== 'clone'}
    >
      {step === 'clone' && (
        <DemoCloneStep config={config} onComplete={advance} onBack={onBackToTypeSelection} />
      )}
      {step === 'account-select' && (
        projectCreating ? (
          <box flexDirection='column' gap={1}>
            <text fg='#f59e0b'>◌ Creating your demo project…</text>
          </box>
        ) : (
          <AccountSelectStep
            url={config.url || API_URL}
            oauthOnly
            onComplete={handleAuthComplete}
            onAddNew={() => setStep('auth-method')}
            onBack={goBack}
          />
        )
      )}
      {step === 'auth-method' && (
        projectCreating ? (
          <box flexDirection='column' gap={1}>
            <text fg='#f59e0b'>◌ Creating your demo project…</text>
          </box>
        ) : (
          <AuthMethodStep
            config={config}
            url={config.url || API_URL}
            profileName={profileName}
            oauthOnly
            onComplete={handleAuthComplete}
            onBack={goBack}
          />
        )
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
      {step === 'model' && <ModelStep config={config} onComplete={advance} />}
      {step === 'demo-setup' && <DemoSetupStep config={config} onComplete={advance} onBack={goBack} />}
      {step === 'connecting' && (
        <ConnectingStep config={config as AgentConfig} onComplete={onComplete} onBack={goBack} />
      )}
    </SetupShell>
  ) as ReactElement
}
