import { useEffect, useState, type ReactElement } from 'react'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import { useKeyboard } from '@opentui/react'
import type { AgentConfig } from '../../types/index.js'
import { DEFAULT_MAX_CONCURRENT, DEMO_DIR, DEMO_REPO_URL } from '../../config.js'
import { AnimatedLoading, FooterHints, StatusIcon } from '../shared/index.js'
import { tuiAttrs } from '../../lib/tuiAttrs.js'

const execFileAsync = promisify(execFile)

type Status = 'checking' | 'cloning' | 'pulling' | 'done' | 'error'

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

interface Props {
  config: Partial<AgentConfig>
  onComplete: (updates: Partial<AgentConfig>) => void
  onBack: () => void
}

/**
 * Ensures the demo repo is present and up to date at a known location.
 *
 * First run: clones DEMO_REPO_URL into ~/multiplayer-demo (or the dir already
 * recorded on the project entry when resuming a previously-registered demo).
 *
 * Subsequent runs: runs `git pull --ff-only` to fetch updates and reuses the
 * existing checkout — the user never has to pick a folder again.
 *
 * If the target path exists but is not the demo repo (no .git, wrong origin),
 * surfaces an actionable error rather than overwriting the user's files.
 */
export function DemoCloneStep({ config, onComplete, onBack }: Props): ReactElement {
  const [status, setStatus] = useState<Status>('checking')
  const [error, setError] = useState<string | null>(null)
  const [runId, setRunId] = useState(0)

  const targetDir = config.dir || DEMO_DIR

  useKeyboard(({ name }) => {
    if (status !== 'error') return
    if (name === 'return') {
      setError(null)
      setStatus('checking')
      setRunId((v) => v + 1)
    } else if (name === 'escape') {
      onBack()
    }
  })

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        if (fs.existsSync(targetDir)) {
          const hasGit = fs.existsSync(path.join(targetDir, '.git'))
          if (!hasGit) {
            // Allow empty pre-existing folders (e.g. user pre-created the dir).
            const entries = fs.readdirSync(targetDir)
            if (entries.length > 0) {
              throw new Error(
                `${targetDir} exists but is not the Multiplayer demo. Remove or rename it, then retry.`,
              )
            }
            if (cancelled) return
            setStatus('cloning')
            // git clone into a non-empty path fails; rmdir the empty folder first so
            // the clone can write into the same path.
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
            setStatus('pulling')
            const stashResult = await execFileAsync('git', ['-C', targetDir, 'stash', '--include-untracked'])
            const stashed = !stashResult.stdout.includes('No local changes to save')
            try {
              await execFileAsync('git', ['-C', targetDir, 'pull', '--ff-only'])
            } finally {
              if (stashed) {
                await execFileAsync('git', ['-C', targetDir, 'stash', 'pop'])
              }
            }
          }
        } else {
          if (cancelled) return
          setStatus('cloning')
          await execFileAsync('git', ['clone', '--depth=1', DEMO_REPO_URL, targetDir])
        }

        if (cancelled) return
        setStatus('done')
        onComplete({
          dir: targetDir,
          isDemoProject: true,
          // Demo doesn't expose a concurrency picker — seed the default so the
          // dashboard has something concrete to show.
          maxConcurrentIssues: config.maxConcurrentIssues ?? DEFAULT_MAX_CONCURRENT,
          // Session-recorder is wired automatically by DemoSetupStep, so the
          // dedicated SDK setup step is not part of the demo flow.
          sessionRecorderSetupDone: true,
        })
      } catch (err: unknown) {
        if (cancelled) return
        const message = (err as { stderr?: string }).stderr?.trim() || (err as Error).message
        setError(message)
        setStatus('error')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [runId])

  if (status === 'error') {
    return (
      <box flexDirection='column' gap={1}>
        <text fg='#ef4444'>✗ {error}</text>
        <FooterHints hints='Enter retry · Esc back' />
      </box>
    ) as ReactElement
  }

  if (status === 'done') {
    return (
      <box flexDirection='row' gap={2} marginTop={1}>
        <StatusIcon status='success' />
        <text>Demo repository is ready at {targetDir}.</text>
      </box>
    ) as ReactElement
  }

  const title =
    status === 'pulling'
      ? 'Updating demo project'
      : status === 'cloning'
        ? 'Cloning demo project'
        : 'Checking demo project'

  return (
    <box flexDirection='column' gap={1}>
      <text attributes={tuiAttrs({ bold: true })}>{title}</text>
      <AnimatedLoading title={title} subtitle={targetDir} color='#22d3ee' />
    </box>
  ) as ReactElement
}
