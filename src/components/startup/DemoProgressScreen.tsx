import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import { useKeyboard } from '@opentui/react'
import type { AgentConfig } from '../../types/index.js'
import { API_URL, DEFAULT_MAX_CONCURRENT, DEMO_DIR, DEMO_REPO_URL } from '../../config.js'
import { OAuthManager } from '../../auth/oauth-manager.js'
import { createApiService } from '../../services/api.service.js'
import * as AiService from '../../services/ai.service.js'
import { listAccounts, readCredentials, writeCredentials, renameAccount } from '../../cli/profile.js'
import { deleteProfileTokenData } from '../../auth/token-store.js'
import { copyToClipboard } from '../../lib/clipboard.js'
import { tuiAttrs } from '../../lib/tuiAttrs.js'
import { FooterHints, InputField, StatusIcon } from '../shared/index.js'
import { clickHandler } from '../shared/clickHandler.js'
import { stringFromInputSubmit } from '../../lib/inputSubmit.js'
import type { SelectableWorkspace } from './ProjectSelectStep.js'

const execFileAsync = promisify(execFile)

const DEMO_PROJECT_NAME = 'multiplayer-demo'
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6'
const DEFAULT_OPENAI_MODEL = 'gpt-4o'

// ─── Types ────────────────────────────────────────────────────────────────────

type PhaseStatus = 'pending' | 'running' | 'waiting' | 'done' | 'error'

interface PhaseState {
  status: PhaseStatus
  detail?: string
  error?: string
}

export interface DemoProgressResult {
  dir: string
  apiKey: string
  authType: 'oauth'
  workspaces: SelectableWorkspace[]
  accountName: string
  maxConcurrentIssues: number
  // Set when single workspace resolved; absent for multi-workspace (parent handles project-select).
  workspace?: string
  project?: string
  workspaceDisplayName?: string
  projectDisplayName?: string
  // Set when Claude auto-detected or OpenAI key provided inline; absent for multi-workspace.
  model?: string
  modelKey?: string
}

// Intermediate result carried from project phase into model phase.
interface ProjectResult {
  dir: string
  apiKey: string
  workspaces: SelectableWorkspace[]
  accountName: string
  workspace: string
  project: string
  workspaceDisplayName: string
  projectDisplayName: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeGitUrl(url: string): string {
  return url.trim().replace(/^(https?|git):\/\//, '').replace(/\.git$/, '')
}

async function gitOriginUrl(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'remote', 'get-url', 'origin'])
    return stdout.trim()
  } catch {
    return null
  }
}

function listOauthAccounts(): string[] {
  return listAccounts().filter((name) => readCredentials(name).authType === 'oauth')
}

// ─── Phase row ────────────────────────────────────────────────────────────────

function PhaseRow({ label, phase }: { label: string; phase: PhaseState }): ReactElement {
  const iconStatus =
    phase.status === 'done' ? 'success'
    : phase.status === 'error' ? 'error'
    : phase.status === 'pending' ? 'idle'
    : 'loading'

  return (
    <box flexDirection='row' gap={1} alignItems='flex-start'>
      <box width={2} flexShrink={0}>
        <StatusIcon status={iconStatus} />
      </box>
      <text width={12} flexShrink={0} attributes={tuiAttrs({ dim: phase.status === 'pending' })}>
        {label}
      </text>
      {phase.detail && (
        <text attributes={tuiAttrs({ dim: phase.status === 'done' || phase.status === 'pending' })}>
          {phase.detail}
        </text>
      )}
    </box>
  ) as ReactElement
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  initialConfig: Partial<AgentConfig>
  profileName?: string
  onComplete: (result: DemoProgressResult) => void
  onBack: () => void
}

export function DemoProgressScreen({ initialConfig, profileName, onComplete, onBack }: Props): ReactElement {
  const url = initialConfig.url || API_URL
  const cloneAlreadyDone = !!(initialConfig.dir && initialConfig.isDemoProject)

  // ── Phase UI state ───────────────────────────────────────────────────────────

  const [clonePhase, setClonePhase] = useState<PhaseState>({
    status: cloneAlreadyDone ? 'done' : 'running',
    detail: cloneAlreadyDone ? `Ready at ${initialConfig.dir}` : 'Checking…',
  })
  const [authPhase, setAuthPhase] = useState<PhaseState>({ status: 'pending' })
  const [projectPhase, setProjectPhase] = useState<PhaseState>({ status: 'pending' })
  const [modelPhase, setModelPhase] = useState<PhaseState>({ status: 'pending' })

  // ── Phase transition signals ─────────────────────────────────────────────────

  const [clonedDir, setClonedDir] = useState<string | null>(
    cloneAlreadyDone ? (initialConfig.dir ?? null) : null,
  )
  const [authData, setAuthData] = useState<{
    token: string
    workspaces: SelectableWorkspace[]
    accountName: string
  } | null>(null)
  // Only set for single-workspace path; multi-workspace calls onComplete early.
  const [projectResult, setProjectResult] = useState<ProjectResult | null>(null)

  // ── OAuth UI state ───────────────────────────────────────────────────────────

  const [oauthFallbackUrl, setOauthFallbackUrl] = useState<string | null>(null)
  const [urlCopied, setUrlCopied] = useState(false)
  const [manualToken, setManualToken] = useState('')

  // ── Account picker state (null = not picking) ────────────────────────────────

  const [accountOptions, setAccountOptions] = useState<string[] | null>(null)
  const [pickerIndex, setPickerIndex] = useState(0)

  // ── Model phase UI state (when Claude unavailable) ───────────────────────────

  const [openAiKey, setOpenAiKey] = useState('')
  const [openAiKeyError, setOpenAiKeyError] = useState<string | null>(null)
  const [validatingOpenAiKey, setValidatingOpenAiKey] = useState(false)

  // ── Refs ─────────────────────────────────────────────────────────────────────

  const oauthManagerRef = useRef<OAuthManager | null>(null)
  const urlCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cloneStartedRef = useRef(cloneAlreadyDone)
  const authStartedRef = useRef(false)
  const projectStartedRef = useRef(false)
  const modelStartedRef = useRef(false)
  const authDirRef = useRef<string>(initialConfig.dir ?? DEMO_DIR)

  useEffect(() => {
    return () => {
      if (urlCopiedTimerRef.current) clearTimeout(urlCopiedTimerRef.current)
    }
  }, [])

  // ── Phase 1: Clone ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (cloneStartedRef.current) return
    cloneStartedRef.current = true

    const targetDir = initialConfig.dir || DEMO_DIR
    let cancelled = false

    void (async () => {
      try {
        if (fs.existsSync(targetDir)) {
          const hasGit = fs.existsSync(path.join(targetDir, '.git'))
          if (!hasGit) {
            const entries = fs.readdirSync(targetDir)
            if (entries.length > 0) {
              throw new Error(
                `${targetDir} exists but is not the Multiplayer demo. Remove or rename it, then retry.`,
              )
            }
            if (cancelled) return
            setClonePhase({ status: 'running', detail: 'Cloning…' })
            fs.rmdirSync(targetDir)
            await execFileAsync('git', ['clone', '--depth=1', DEMO_REPO_URL, targetDir])
          } else {
            const origin = await gitOriginUrl(targetDir)
            if (!origin || normalizeGitUrl(origin) !== normalizeGitUrl(DEMO_REPO_URL)) {
              throw new Error(
                `${targetDir} is a git repo but its origin doesn't match the Multiplayer demo. Remove or rename it, then retry.`,
              )
            }
            if (cancelled) return
            setClonePhase({ status: 'running', detail: 'Pulling latest…' })
            await execFileAsync('git', ['-C', targetDir, 'pull', '--ff-only'])
          }
        } else {
          if (cancelled) return
          setClonePhase({ status: 'running', detail: 'Cloning…' })
          await execFileAsync('git', ['clone', '--depth=1', DEMO_REPO_URL, targetDir])
        }

        if (cancelled) return
        setClonePhase({ status: 'done', detail: `Ready at ${targetDir}` })
        setClonedDir(targetDir)
      } catch (err: unknown) {
        if (cancelled) return
        const message = (err as { stderr?: string }).stderr?.trim() || (err as Error).message
        setClonePhase({ status: 'error', error: message })
      }
    })()

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Phase 2: Auth — starts when clone signals completion ─────────────────────

  const runFreshOAuth = useCallback(
    (dir: string, profile: string) => {
      setOauthFallbackUrl(null)
      setManualToken('')
      setAuthPhase({ status: 'running', detail: 'Connecting…' })

      let cancelled = false

      void (async () => {
        try {
          const baseUrl = url.replace(/\/v\d+\/?$/, '')
          const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)
          if (!response.ok) throw new Error(`Failed to fetch OAuth config: ${response.status}`)
          const data = (await response.json()) as Record<string, string>

          if (cancelled) return
          const oauthManager = new OAuthManager(profile)
          oauthManagerRef.current = oauthManager
          await oauthManager.init({
            authorizationServerUrl: data.issuer!,
            authorizationEndpoint: data.authorization_endpoint!,
            tokenEndpoint: data.token_endpoint!,
            registrationEndpoint: data.registration_endpoint!,
          })

          setAuthPhase({ status: 'waiting', detail: 'Waiting for browser login…' })
          const fallbackRedirectUri = `${new URL(data.authorization_endpoint!).origin}/auth/authorize/oauth/callback`
          await oauthManager.authenticate((_browserUrl, fallbackUrl) => {
            if (!cancelled) setOauthFallbackUrl(fallbackUrl)
          }, fallbackRedirectUri)

          if (cancelled) return
          const token = await oauthManager.getAccessToken()
          if (!token) throw new Error('Authentication failed. Please try again.')

          const api = createApiService({ url, apiKey: '', bearerToken: token })
          const session = await api.fetchUserSession()
          if (!session.workspaces.length) throw new Error('No workspace found for this account.')

          const workspaces: SelectableWorkspace[] = await Promise.all(
            session.workspaces.map(async (ws) => ({
              _id: ws._id,
              name: ws.name,
              projects: (await api.fetchProjects(ws._id)).filter((p) => !!p._id && !!p.name),
            })),
          )

          writeCredentials(profile, { authType: 'oauth', ...(session.email ? { email: session.email } : {}) })
          let accountName = profile
          if (session.email && session.email !== profile) {
            renameAccount(profile, session.email)
            accountName = session.email
          }

          if (cancelled) return
          setAuthPhase({ status: 'done', detail: accountName })
          setAuthData({ token, workspaces, accountName })
        } catch (err: unknown) {
          if (cancelled) return
          setAuthPhase({ status: 'error', error: (err as Error).message })
        }
      })()

      return () => { cancelled = true }
    },
    [url],
  )

  const tryExistingAccount = useCallback(
    async (accountName: string, dir: string, profile: string) => {
      const creds = readCredentials(accountName)
      const oauthManager = new OAuthManager(accountName)

      try {
        const token = await oauthManager.getAccessToken()
        if (!token) {
          deleteProfileTokenData(accountName)
          runFreshOAuth(dir, profile)
          return
        }

        const resolvedUrl = creds.url ?? url
        const api = createApiService({ url: resolvedUrl, apiKey: '', bearerToken: token })
        const session = await api.fetchUserSession()

        const workspaces: SelectableWorkspace[] = await Promise.all(
          session.workspaces.map(async (ws) => ({
            _id: ws._id,
            name: ws.name,
            projects: (await api.fetchProjects(ws._id)).filter((p) => !!p._id && !!p.name),
          })),
        )

        let resolvedAccount = accountName
        if (session.email) {
          if (session.email !== accountName) {
            writeCredentials(accountName, { email: session.email })
            renameAccount(accountName, session.email)
            resolvedAccount = session.email
          } else {
            resolvedAccount = session.email
          }
        }

        setAuthPhase({ status: 'done', detail: resolvedAccount })
        setAuthData({ token, workspaces, accountName: resolvedAccount })
      } catch {
        runFreshOAuth(dir, profile)
      }
    },
    [url, runFreshOAuth],
  )

  useEffect(() => {
    if (!clonedDir || authStartedRef.current) return
    authStartedRef.current = true
    authDirRef.current = clonedDir

    const profile = profileName || 'default'
    const oauthAccounts = listOauthAccounts()

    if (oauthAccounts.length === 0) {
      runFreshOAuth(clonedDir, profile)
    } else if (oauthAccounts.length === 1) {
      setAuthPhase({ status: 'running', detail: 'Connecting…' })
      void tryExistingAccount(oauthAccounts[0]!, clonedDir, profile)
    } else {
      setAccountOptions([...oauthAccounts, '__new__'])
      setAuthPhase({ status: 'waiting', detail: 'Select account' })
    }
  }, [clonedDir, runFreshOAuth, tryExistingAccount, profileName])

  // ── Phase 3: Project — starts when auth signals completion ───────────────────

  useEffect(() => {
    if (!authData || projectStartedRef.current) return
    projectStartedRef.current = true

    const { token, workspaces, accountName } = authData
    const dir = authDirRef.current

    // Multi-workspace: parent shows project-select, then its own model step.
    if (workspaces.length !== 1) {
      setProjectPhase({ status: 'done', detail: 'Select workspace below' })
      onComplete({
        dir,
        apiKey: token,
        authType: 'oauth',
        workspaces,
        accountName,
        maxConcurrentIssues: initialConfig.maxConcurrentIssues ?? DEFAULT_MAX_CONCURRENT,
      })
      return
    }

    const ws = workspaces[0]!
    const existing = ws.projects.find((p) => p.name === DEMO_PROJECT_NAME)
    let cancelled = false

    void (async () => {
      try {
        let proj: { _id: string; name: string }

        if (existing) {
          proj = existing
          setProjectPhase({ status: 'done', detail: `"${DEMO_PROJECT_NAME}" ready` })
        } else {
          setProjectPhase({ status: 'running', detail: `Creating "${DEMO_PROJECT_NAME}"…` })
          const api = createApiService({ url, apiKey: '', bearerToken: token })
          proj = await api.createProject(ws._id, DEMO_PROJECT_NAME)
          if (cancelled) return
          setProjectPhase({ status: 'done', detail: `"${DEMO_PROJECT_NAME}" created` })
        }

        if (cancelled) return
        // Signal model phase with the resolved project data.
        setProjectResult({
          dir,
          apiKey: token,
          workspaces,
          accountName,
          workspace: ws._id,
          project: proj._id,
          workspaceDisplayName: ws.name,
          projectDisplayName: proj.name,
        })
      } catch (err: unknown) {
        if (cancelled) return
        setProjectPhase({ status: 'error', error: (err as Error).message })
      }
    })()

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authData])

  // ── Phase 4: Model — starts when project signals completion ──────────────────

  useEffect(() => {
    if (!projectResult || modelStartedRef.current) return
    modelStartedRef.current = true

    setModelPhase({ status: 'running', detail: 'Detecting AI provider…' })

    void AiService.checkClaudeRequirements()
      .then(() => {
        setModelPhase({ status: 'done', detail: DEFAULT_CLAUDE_MODEL })
        onComplete({
          ...projectResult,
          authType: 'oauth',
          maxConcurrentIssues: initialConfig.maxConcurrentIssues ?? DEFAULT_MAX_CONCURRENT,
          model: DEFAULT_CLAUDE_MODEL,
        })
      })
      .catch(() => {
        // Claude not available or not logged in — ask for an OpenAI key inline.
        setModelPhase({ status: 'waiting', detail: 'Claude not available — enter OpenAI API key:' })
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectResult])

  const handleOpenAiKeySubmit = useCallback(
    (rawKey: string) => {
      const key = rawKey.trim()
      if (!key || !projectResult) {
        setOpenAiKeyError('API key is required.')
        return
      }
      setValidatingOpenAiKey(true)
      setOpenAiKeyError(null)

      void AiService.checkOpenAiRequirements(key)
        .then(() => {
          setValidatingOpenAiKey(false)
          setModelPhase({ status: 'done', detail: `${DEFAULT_OPENAI_MODEL} (OpenAI)` })
          onComplete({
            ...projectResult,
            authType: 'oauth',
            maxConcurrentIssues: initialConfig.maxConcurrentIssues ?? DEFAULT_MAX_CONCURRENT,
            model: DEFAULT_OPENAI_MODEL,
            modelKey: key,
          })
        })
        .catch((err: Error) => {
          setValidatingOpenAiKey(false)
          setOpenAiKeyError(err.message)
        })
    },
    [projectResult, initialConfig.maxConcurrentIssues, onComplete],
  )

  // ── Keyboard ─────────────────────────────────────────────────────────────────

  const isPicking = accountOptions !== null
  const isWaitingBrowser = authPhase.status === 'waiting' && !isPicking
  const isWaitingOpenAiKey = modelPhase.status === 'waiting'
  const hasError =
    clonePhase.status === 'error' ||
    authPhase.status === 'error' ||
    projectPhase.status === 'error' ||
    modelPhase.status === 'error'

  useKeyboard((key) => {
    const { name } = key

    if (isPicking) {
      if (name === 'up' || name === 'k') setPickerIndex((i) => Math.max(0, i - 1))
      else if (name === 'down' || name === 'j')
        setPickerIndex((i) => Math.min((accountOptions?.length ?? 1) - 1, i + 1))
      else if (name === 'return') {
        confirmAccountPick(pickerIndex)
        key.stopPropagation()
      } else if (name === 'escape') {
        key.stopPropagation()
        onBack()
      }
      return
    }

    // Esc is blocked during browser waiting and OpenAI key entry (user is mid-flow).
    if (name === 'escape' && !isWaitingBrowser && !isWaitingOpenAiKey) {
      key.stopPropagation()
      onBack()
    }
  })

  const confirmAccountPick = useCallback(
    (idx: number) => {
      if (!accountOptions) return
      const chosen = accountOptions[idx]
      if (!chosen) return
      setAccountOptions(null)
      const dir = authDirRef.current
      const profile = profileName || 'default'
      setAuthPhase({ status: 'running', detail: 'Connecting…' })
      if (chosen === '__new__') {
        runFreshOAuth(dir, profile)
      } else {
        void tryExistingAccount(chosen, dir, profile)
      }
    },
    [accountOptions, profileName, runFreshOAuth, tryExistingAccount],
  )

  const handleCopyUrl = useCallback(() => {
    if (!oauthFallbackUrl) return
    copyToClipboard(oauthFallbackUrl)
    setUrlCopied(true)
    if (urlCopiedTimerRef.current) clearTimeout(urlCopiedTimerRef.current)
    urlCopiedTimerRef.current = setTimeout(() => setUrlCopied(false), 3000)
  }, [oauthFallbackUrl])

  const handleManualTokenSubmit = useCallback((token: string) => {
    const trimmed = token.trim()
    if (!trimmed || !oauthManagerRef.current) return
    oauthManagerRef.current.completeManualAuth(trimmed)
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <box flexDirection='column' gap={1}>
      {/* Clone */}
      <PhaseRow label='Repository' phase={clonePhase} />
      {clonePhase.error && <text fg='#ef4444' paddingLeft={4}>{clonePhase.error}</text>}

      {/* Auth */}
      <PhaseRow label='Account' phase={isPicking ? { ...authPhase, detail: undefined } : authPhase} />
      {authPhase.error && <text fg='#ef4444' paddingLeft={4}>{authPhase.error}</text>}

      {isPicking && accountOptions && (
        <box flexDirection='column' paddingLeft={4}>
          {accountOptions.map((name, i) => {
            const isNew = name === '__new__'
            const isSelected = i === pickerIndex
            return (
              <text
                key={name}
                fg={isSelected ? (isNew ? '#f59e0b' : '#22d3ee') : '#6b7280'}
                onMouseUp={clickHandler(() => confirmAccountPick(i))}
              >
                {isSelected ? '❯' : ' '} {isNew ? 'Login with new account' : name}
              </text>
            )
          })}
        </box>
      )}

      {isWaitingBrowser && (
        <box flexDirection='column' gap={1} paddingLeft={4}>
          <text fg='#10b981'>✓ Browser opened — complete login in your browser.</text>
          {oauthFallbackUrl && (
            <box flexDirection='column' gap={1}>
              <text attributes={tuiAttrs({ dim: true })}>If browser didn't open, visit:</text>
              <text fg='#22d3ee' attributes={tuiAttrs({ underline: true })}>{oauthFallbackUrl}</text>
              <box>
                {urlCopied ? (
                  <text fg='#10b981'>✓ Copied</text>
                ) : (
                  <text fg='#22d3ee' onMouseUp={clickHandler(handleCopyUrl)}>Copy URL</text>
                )}
              </box>
              <text attributes={tuiAttrs({ dim: true })}>Or paste the code here:</text>
              <InputField
                value={manualToken}
                onInput={setManualToken}
                onSubmit={(p) => handleManualTokenSubmit(stringFromInputSubmit(p, manualToken))}
                placeholder='Paste code here…'
              />
            </box>
          )}
        </box>
      )}

      {/* Project */}
      <PhaseRow label='Project' phase={projectPhase} />
      {projectPhase.error && <text fg='#ef4444' paddingLeft={4}>{projectPhase.error}</text>}

      {/* Model */}
      <PhaseRow label='Model' phase={isWaitingOpenAiKey ? { ...modelPhase, detail: undefined } : modelPhase} />
      {modelPhase.error && <text fg='#ef4444' paddingLeft={4}>{modelPhase.error}</text>}

      {isWaitingOpenAiKey && (
        <box flexDirection='column' gap={1} paddingLeft={4}>
          <text attributes={tuiAttrs({ dim: true })}>Claude not available — enter an OpenAI API key:</text>
          {openAiKeyError && <text fg='#ef4444'>✗ {openAiKeyError}</text>}
          {validatingOpenAiKey ? (
            <text fg='#f59e0b'>◌ Validating key…</text>
          ) : (
            <InputField
              value={openAiKey}
              onInput={setOpenAiKey}
              onSubmit={(p) => handleOpenAiKeySubmit(stringFromInputSubmit(p, openAiKey))}
              placeholder='sk-…'
            />
          )}
          <text attributes={tuiAttrs({ dim: true })}>Model will default to {DEFAULT_OPENAI_MODEL}.</text>
        </box>
      )}

      {/* Footer */}
      <box marginTop={1}>
        {isPicking ? (
          <FooterHints hints='↑↓ navigate · Enter select · Click to select · Esc back' />
        ) : isWaitingBrowser || isWaitingOpenAiKey ? (
          <FooterHints hints='Enter confirm · Esc cancel' />
        ) : hasError ? (
          <FooterHints hints='Esc back' />
        ) : (
          <FooterHints hints='Esc cancel' />
        )}
      </box>
    </box>
  ) as ReactElement
}
