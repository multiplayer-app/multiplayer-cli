import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useKeyboard } from '@opentui/react'
import type { AgentConfig } from '../../../types/index.js'
import { API_URL, DEFAULT_MAX_CONCURRENT } from '../../../config.js'
import { createApiService } from '../../../services/api.service.js'
import { persistSetupState } from '../../../cli/setup-persistence.js'
import { SetupShell, type SidebarEntry } from '../SetupShell.js'
import { DemoProgressScreen, type DemoProgressResult } from '../DemoProgressScreen.js'
import { ProjectSelectStep, type SelectableWorkspace } from '../ProjectSelectStep.js'
import { ModelStep } from '../ModelStep.js'
import { DemoSetupStep } from '../DemoSetupStep.js'
import { ConnectingStep } from '../ConnectingStep.js'

// ─── Step definitions ─────────────────────────────────────────────────────────

type StepId = 'progress' | 'project-select' | 'model' | 'demo-setup' | 'connecting'

interface StepMeta {
  title: string
  description: string
  shortLabel: string
  hideFromSidebar?: boolean
  canSkip: (c: Partial<AgentConfig>) => boolean
}

const STEP_DEFS: Record<StepId, StepMeta> = {
  progress: {
    title: 'Setting Up Demo',
    description: 'Cloning repository, connecting account, and preparing project.',
    shortLabel: 'Setup',
    canSkip: (c) => !!c.dir && !!c.isDemoProject && !!c.apiKey && !!(c.workspace && c.project),
  },
  'project-select': {
    title: 'Select Project',
    description: 'Choose the Multiplayer project this demo will report into.',
    shortLabel: 'Project',
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

// ─── Route helpers ────────────────────────────────────────────────────────────

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

function prevStep(current: StepId): StepId | null {
  switch (current) {
    case 'progress': return null
    case 'project-select': return null
    case 'model': return 'project-select'
    case 'demo-setup': return 'model'
    case 'connecting': return 'demo-setup'
  }
}

// project-select navigates itself internally (keyboard captured inside the component).
const SELF_NAVIGATING_STEPS: Set<StepId> = new Set(['project-select'])

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
  onComplete,
  onBackToTypeSelection,
}: Props): ReactElement | null {
  const [config, setConfig] = useState<Partial<AgentConfig>>({ ...initialConfig, isDemoProject: true })
  const [step, setStep] = useState<StepId>(() => firstRequiredStep({ ...initialConfig, isDemoProject: true }))
  const [account, setAccount] = useState(initialAccount ?? profileName ?? 'default')

  // Kept for the project-select fallback (multi-workspace users).
  const [oauthWorkspaces, setOauthWorkspaces] = useState<SelectableWorkspace[]>([])
  const [fetchingWorkspaces, setFetchingWorkspaces] = useState(false)
  const [oauthApi, setOauthApi] = useState<ReturnType<typeof createApiService> | null>(null)
  const demoAutoCreationStartedRef = useRef(false)

  // ── Advance helper ──────────────────────────────────────────────────────────

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

  // ── Progress screen completion ───────────────────────────────────────────────

  const handleProgressComplete = useCallback(
    (result: DemoProgressResult) => {
      setAccount(result.accountName)
      setOauthWorkspaces(result.workspaces)

      const resolvedUrl = config.url || API_URL
      setOauthApi(createApiService({ url: resolvedUrl, apiKey: '', bearerToken: result.apiKey }))

      advance(
        {
          dir: result.dir,
          apiKey: result.apiKey,
          authType: result.authType,
          isDemoProject: true,
          maxConcurrentIssues: result.maxConcurrentIssues ?? DEFAULT_MAX_CONCURRENT,
          sessionRecorderSetupDone: true,
          ...(result.workspace
            ? {
                workspace: result.workspace,
                project: result.project,
                workspaceDisplayName: result.workspaceDisplayName,
                projectDisplayName: result.projectDisplayName,
              }
            : {}),
          ...(result.model ? { model: result.model, modelKey: result.modelKey } : {}),
        },
        result.accountName,
      )
    },
    [config.url, advance],
  )

  // ── Back navigation ─────────────────────────────────────────────────────────

  const goBack = useCallback(() => {
    const prev = prevStep(step)
    if (prev) setStep(prev)
    else onBackToTypeSelection()
  }, [step, onBackToTypeSelection])

  useKeyboard(({ name }) => {
    if (name !== 'escape' || SELF_NAVIGATING_STEPS.has(step)) return
    goBack()
  })

  // ── Resume fallback: project-select with one workspace ──────────────────────
  // Fetches workspaces when landing on project-select with a bearer token but
  // no workspace/project saved (e.g. partial resume after a crash).

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
      .catch(() => { /* empty list handled by ProjectSelectStep */ })
      .finally(() => setFetchingWorkspaces(false))
  }, [step])

  // Auto-select or create "multiplayer-demo" when exactly one workspace is
  // available on the project-select screen (resume path for single-workspace
  // users). Normal path is handled inside DemoProgressScreen.
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

  // Fetch display names for the summary card when workspace/project are known.
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
      } catch { /* non-fatal */ }
    })()
    return () => { cancelled = true }
  }, [config.apiKey, config.workspace, config.project, config.url])

  // ── Sidebar ─────────────────────────────────────────────────────────────────

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

  const sidebar: SidebarEntry[] = visibleSteps.map((s, i) => ({
    id: s,
    label: STEP_DEFS[s].shortLabel,
    isDone: i < currentVisibleIndex,
    isCurrent: s === effectiveStep,
  }))

  // ── Render ───────────────────────────────────────────────────────────────────

  const meta = STEP_DEFS[step]

  return (
    <SetupShell
      title={meta.title}
      description={meta.description}
      config={config}
      account={account}
      sidebar={sidebar}
      showSummary={step !== 'progress'}
    >
      {step === 'progress' && (
        <DemoProgressScreen
          initialConfig={config}
          profileName={profileName}
          onComplete={handleProgressComplete}
          onBack={onBackToTypeSelection}
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
      {step === 'model' && <ModelStep config={config} onComplete={advance} />}
      {step === 'demo-setup' && <DemoSetupStep config={config} onComplete={advance} onBack={goBack} />}
      {step === 'connecting' && (
        <ConnectingStep config={config as AgentConfig} onComplete={onComplete} onBack={goBack} onChangeModel={() => setStep('model')} />
      )}
    </SetupShell>
  ) as ReactElement
}
