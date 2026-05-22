import {
  addProject,
  readProjectSettings,
  setProjectDemo,
  writeCredentials,
  writeProjectSettings,
  type GitSettings,
} from './profile.js'
import type { AgentConfig } from '../types/index.js'

/**
 * Git settings seeded for first-time demo projects. The demo runs locally with no
 * remote branches/PRs/pushes — disabling these prevents the agent from trying.
 */
export const DEMO_GIT_DEFAULTS: GitSettings = {
  commit: false,
  branch_create: false,
  pr_create: false,
  push: false,
  use_worktree: false,
}

interface PersistOptions {
  account: string
  /** True for demo flow — seeds DEMO_GIT_DEFAULTS the first time the project is persisted. */
  isDemoFlow?: boolean
}

/**
 * Write the auth + project-settings slice of `config` to disk.
 *
 * Returns any in-memory updates the caller should merge into its React state
 * (currently: the resolved git settings, so the dashboard's initial state matches
 * what's on disk). Returns an empty object when there's nothing to mirror.
 *
 * Both setup flows share this so they don't reimplement the credentials/project
 * split, the demo-git seeding, or the "only write defaults on first time" rule.
 */
export function persistSetupState(
  config: Partial<AgentConfig>,
  opts: PersistOptions,
): Partial<AgentConfig> {
  const creds: Parameters<typeof writeCredentials>[1] = {}
  if (config.authType !== 'oauth' && config.apiKey) creds.apiKey = config.apiKey
  if (config.authType) creds.authType = config.authType
  if (config.url) creds.url = config.url
  if (Object.keys(creds).length > 0) writeCredentials(opts.account, creds)

  if (!config.dir) return {}

  addProject(config.dir, opts.account)
  if (opts.isDemoFlow) setProjectDemo(config.dir, true)

  let resolvedGit: GitSettings | undefined
  let writeDemoGit = false
  if (opts.isDemoFlow) {
    const existing = readProjectSettings(config.dir).git
    if (existing !== undefined) {
      resolvedGit = existing
    } else {
      resolvedGit = { ...DEMO_GIT_DEFAULTS }
      writeDemoGit = true
    }
  }

  writeProjectSettings(config.dir, {
    workspace: config.workspace,
    project: config.project,
    model: config.model,
    modelKey: config.modelKey,
    modelUrl: config.modelUrl,
    maxConcurrentIssues: config.maxConcurrentIssues,
    sessionRecorderSetupDone: config.sessionRecorderSetupDone,
    sessionRecorderStacks: config.sessionRecorderStacks,
    ...(writeDemoGit && resolvedGit ? { git: resolvedGit } : {}),
  })

  return resolvedGit ? { git: resolvedGit } : {}
}
