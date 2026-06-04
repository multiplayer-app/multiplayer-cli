import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import cliPath from '@anthropic-ai/claude-agent-sdk/embed'
import { z } from 'zod'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { Issue, Release, ConversationMessage } from '../types/index.js'
import { logger } from '../logger.js'
import { logToTui } from '../lib/tuiSink.js'
import { getAuthHeaders } from '../lib/authHeaders.js'
import {
  escapePromptMarkup,
  sanitizeCapturedValue,
  wrapUntrustedObservabilityData,
} from '../lib/untrustedObservability.js'
import {
  buildChatTitlePrompt,
  ANALYSE_ISSUE_SYSTEM_PROMPT,
  buildAnalyseIssueUserMessage,
  PR_GENERATION_SYSTEM_PROMPT,
  buildPrUserMessage,
  buildIssuePromptFallback,
  buildClaudeCodeDebuggingSystemPrompt,
} from '../prompts.js'
import { createProvider, isAnthropicModel } from '../lib/llm/index.js'
import type { AgentStreamEvent, FilePatch } from '../lib/llm/index.js'

// Re-export classification helpers so callers don't need to import from two places.
export {
  isAnthropicModel,
  isGeminiModel,
  isCodexModel,
  getProviderDefaultBaseUrl,
} from '../lib/llm/index.js'

const execAsync = promisify(exec)

export interface McpConfig {
  apiKey: string
  apiUrl: string
  authType?: 'oauth' | 'api_key'
}

// ─── Provider requirement checks ─────────────────────────────────────────────

const CLAUDE_NOT_LOGGED_IN = /not logged in|please run \/login/i

const claudeAuthLog = (msg: string): void => {
  logger.debug(msg)
  logToTui('info', msg)
}

const probeClaudeLoginViaCli = (loginError: Error): Promise<void> => {
  // The Agent SDK can return result:success even when the CLI is not logged in.
  // The installed `claude` binary is the source of truth — same as `claude -p "ok"`.
  claudeAuthLog('[claude-auth] probing login via `claude -p "ok"`')

  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', 'ok'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Claude login probe timed out'))
    }, 30_000)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      const output = `${stdout}\n${stderr}`.trim()
      claudeAuthLog(`[claude-auth] CLI probe output: ${output || '(empty)'} (exit ${code ?? '?'})`)
      if (CLAUDE_NOT_LOGGED_IN.test(output)) {
        reject(loginError)
        return
      }
      if (code !== 0) {
        reject(new Error(`Claude login probe exited with code ${code ?? '?'}`))
        return
      }
      claudeAuthLog('[claude-auth] Claude Code is authenticated')
      resolve()
    })
  })
}

export const checkClaudeRequirements = async (model?: string): Promise<void> => {
  claudeAuthLog('[claude-auth] checking Claude Code requirements')

  try {
    const { stdout } = await execAsync('claude --version', { timeout: 5000 })
    claudeAuthLog(`[claude-auth] claude CLI found: ${stdout.trim()}`)
  } catch {
    claudeAuthLog('[claude-auth] claude CLI not found in PATH')
    throw new Error('Claude CLI is not installed. Install it with:\n  npm install -g @anthropic-ai/claude-code')
  }

  // An ANTHROPIC_API_KEY bypasses interactive login — no probe needed.
  if (process.env.ANTHROPIC_API_KEY) {
    claudeAuthLog('[claude-auth] ANTHROPIC_API_KEY is set — skipping interactive login probe')
  } else {
    const loginError = new Error(
      'Claude Code is not authenticated.\n' + 'Open a new terminal, run "claude" and complete login, then press Retry.',
    )
    await probeClaudeLoginViaCli(loginError)
  }

  await verifyClaudeModel(model)
}

/**
 * Verifies an explicitly-selected Claude model is actually usable by running a
 * minimal single-turn query through the Claude Code SDK. This catches an invalid
 * or unavailable model name (e.g. a non-existent version) at startup instead of
 * at the first chat turn. Skipped for the default 'claude-code' (Claude Code
 * picks its own model) and for non-Anthropic models.
 */
export const verifyClaudeModel = async (model?: string): Promise<void> => {
  if (!model || model === 'claude-code' || !isAnthropicModel(model)) return

  claudeAuthLog(`[claude-auth] verifying model ${model}`)
  let modelError: string | null = null
  try {
    for await (const message of query({
      prompt: 'hi',
      options: {
        cwd: process.cwd(),
        executable: 'node',
        pathToClaudeCodeExecutable: cliPath,
        permissionMode: 'bypassPermissions',
        settingSources: [],
        maxTurns: 1,
        model,
      },
    })) {
      const msg = message as any
      if (msg.type === 'result' && msg.subtype !== 'success') {
        const errors: string[] = msg.errors ?? []
        modelError = errors.length > 0 ? errors.join('; ') : String(msg.subtype)
        break
      }
    }
  } catch (err) {
    modelError = err instanceof Error ? err.message : String(err)
  }

  if (modelError) {
    claudeAuthLog(`[claude-auth] model ${model} verification failed: ${modelError}`)
    throw new Error(
      `Selected model "${model}" is unavailable or failed verification:\n${modelError}\n\n` +
      'Pick a different model with --model.',
    )
  }
  claudeAuthLog(`[claude-auth] model ${model} verified`)
}

// Requires an Anthropic API key (modelKey or ANTHROPIC_API_KEY). Claude Code
// OAuth/subscription users have neither, so the SDK can't authenticate and this
// returns [] — callers fall back to a static model list. Empty is expected, not a bug.
export const fetchAnthropicModels = async (modelKey?: string): Promise<string[]> => {
  try {
    const client = new Anthropic(modelKey ? { apiKey: modelKey } : {})
    const page = await client.models.list({ limit: 100 })
    const ids = page.data.map((m) => m.id).filter((id) => id.startsWith('claude-'))
    const idSet = new Set(ids)

    // Filter out dated snapshots: if stripping the trailing -YYYYMMDD yields another id in
    // the set, this entry is a snapshot of that model and the canonical alias already covers it.
    // Exception: models whose canonical name happens to end in a date (e.g. claude-haiku-4-5-20251001)
    // are kept because their base (e.g. claude-haiku-4-5) doesn't appear in the list.
    return ids.filter((id) => {
      const match = id.match(/^(.+)-(\d{8})$/)
      return match ? !idSet.has(match[1]!) : true
    })
  } catch {
    return []
  }
}

// ─── Gemini auth detection ────────────────────────────────────────────────────

/**
 * Detects a GEMINI_API_KEY from the environment so the UI can pre-fill it.
 * Returns null when the env var is absent.
 */
export const detectGeminiCliAuth = (): { source: 'env'; key: string } | null => {
  const envKey = process.env.GEMINI_API_KEY?.trim()
  if (envKey) return { source: 'env', key: envKey }
  return null
}

export const checkGeminiRequirements = async (apiKey: string, model: string): Promise<void> => {
  const { GoogleAIProvider } = await import('../lib/llm/providers/google.js')
  const provider = new GoogleAIProvider({ model, apiKey })
  await provider.validateCredentials()
}

export const checkOpenAiRequirements = async (apiKey: string, baseUrl?: string, model?: string): Promise<void> => {
  if (!apiKey) {
    throw new Error('AI API key is required for OpenAI-compatible models')
  }
  const client = new OpenAI({
    apiKey,
    ...(baseUrl ? { baseURL: baseUrl } : {}),
  })
  let modelIds: string[]
  try {
    const page = await client.models.list()
    modelIds = page.data.map((m) => m.id)
  } catch (err: any) {
    const msg: string = err?.message || String(err)
    const lower = msg.toLowerCase()
    if (lower.includes('401') || lower.includes('incorrect api key') || lower.includes('invalid api key')) {
      throw new Error('Invalid AI API key — authentication failed')
    }
    throw new Error(`AI API key validation failed: ${msg}`)
  }

  // Only gate on the model when the provider actually returns a list — some
  // OpenAI-compatible endpoints return nothing, and we shouldn't false-fail there.
  if (model && modelIds.length > 0 && !modelIds.includes(model)) {
    throw new Error(
      `Selected model "${model}" is not available from this provider. Pick a different model with --model.`,
    )
  }
}

/**
 * Lists models from any OpenAI-compatible endpoint.
 * Never throws — returns an empty array when the provider doesn't support the
 * /models endpoint or when the request fails for any reason.
 */
export const fetchOpenAiCompatibleModels = async (apiKey: string, baseUrl?: string): Promise<string[]> => {
  try {
    const client = new OpenAI({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    })
    const page = await client.models.list()
    return page.data.map((m) => m.id)
  } catch {
    return []
  }
}

export const classifyAiError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()

  if (
    lower.includes('rate limit') ||
    lower.includes('ratelimit') ||
    lower.includes('429') ||
    lower.includes('too many requests') ||
    lower.includes('quota') ||
    lower.includes('overloaded')
  ) {
    return `AI rate limit exceeded — please wait before retrying.\n${message}`
  }
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('invalid api key') ||
    lower.includes('incorrect api key') ||
    lower.includes('authentication') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden')
  ) {
    return `AI authentication failed — check your API key.\n${message}`
  }
  if (
    lower.includes('context_length_exceeded') ||
    lower.includes('context length') ||
    lower.includes('maximum context') ||
    lower.includes('token limit') ||
    lower.includes('too long') ||
    lower.includes('max_tokens')
  ) {
    return `AI context length exceeded — issue is too large to process.\n${message}`
  }
  if (
    lower.includes('model_not_found') ||
    lower.includes('model not found') ||
    lower.includes('no such model') ||
    lower.includes('does not exist')
  ) {
    return `AI model not found — check the model name in config.\n${message}`
  }
  if (
    lower.includes('insufficient_quota') ||
    lower.includes('billing') ||
    lower.includes('payment required') ||
    lower.includes('upgrade your plan')
  ) {
    return `AI quota or billing issue — check your API account.\n${message}`
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('network error')
  ) {
    return `Network error connecting to AI service.\n${message}`
  }
  if (lower.includes('claude code process exited with code')) {
    const codeMatch = message.match(/code (\d+)/)
    const code = codeMatch?.[1] ?? '1'
    if (code === '1')
      return 'Claude Code exited unexpectedly (exit code 1). This usually means Claude Code is not authenticated or has a configuration error. Run `claude` in your terminal to check.'
    if (code === '127')
      return 'Claude Code binary not found (exit code 127). Make sure `claude` is installed and available in PATH.'
    return `Claude Code process exited with code ${code}.`
  }
  if (lower.includes('claude code executable not found') || lower.includes('claude code native binary not found')) {
    return 'Claude Code executable not found. Make sure `claude` is installed and available in PATH.'
  }
  if (lower.includes('claude code process aborted')) {
    return 'Claude Code process was aborted.'
  }

  return message
}

export type ProgressCallback = (data: string) => void

export type ToolCallCallback = (toolCall: { id: string; name: string; input: Record<string, unknown> }) => void

export type ToolCallResultCallback = (result: {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'succeeded' | 'failed'
  output?: Record<string, unknown>
}) => void

export type TurnStartCallback = () => void

// Called before executing a tool that requires user approval.
// Return { approved: true } to proceed, { approved: false } to reject (rejection message is fed back to the AI).
export type ConfirmToolCallFn = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>
) => Promise<{ approved: boolean; userResponse?: string }>

// Bundles all streaming/progress callbacks to avoid long parameter lists
export interface StreamCallbacks {
  onProgress?: ProgressCallback
  onToolCall?: ToolCallCallback
  onToolCallResult?: ToolCallResultCallback
  onTurnStart?: TurnStartCallback
  confirmToolCall?: ConfirmToolCallFn
}

export const generateChatTitle = async (
  issue: Issue,
  model: string,
  modelKey: string,
  modelUrl?: string,
): Promise<string> => {
  try {
    const provider = createProvider({ model, apiKey: modelKey, baseUrl: modelUrl })
    const { text } = await provider.complete({ userMessage: buildChatTitlePrompt(issue), maxTokens: 64 })
    return text.trim() || issue.title
  } catch {
    return `[${issue.service.serviceName}] ${issue.title}`
  }
}

const findSpanById = (traces: unknown[], targetSpanId: string): any => {
  for (const item of traces as any[]) {
    // Flat ITraceData format (from API)
    if (item.SpanId === targetSpanId) return item
    // OTLP nested format (from S3)
    const scopeSpans = item.scopeSpans ?? item.scope_spans ?? []
    for (const scope of scopeSpans) {
      for (const span of scope.spans ?? []) {
        const sid = span.spanId ?? span.span_id
        if (sid === targetSpanId) return span
      }
    }
  }
  return undefined
}

export interface SessionSketch {
  s3Key: string
  s3Bucket: string
  title?: string
}

/**
 * Extract browser console log entries from rrweb events.
 * Only captures type-3 IncrementalSnapshot events with source 14 (Console).
 * Navigation and input events are intentionally excluded to keep context concise.
 */
const extractRrwebConsoleLogs = (events: any[]): string => {
  const lines: string[] = []
  const startTime = events[0]?.timestamp ?? 0
  for (const event of events) {
    // type 3 = IncrementalSnapshot, source 14 = Console
    if (event.type !== 3 || event.data?.source !== 14) continue
    const relMs = event.timestamp - startTime
    const relSec = (relMs / 1000).toFixed(1)
    const payload = event.data?.payload
    const level = (payload?.level ?? 'log') as string
    const trace = Array.isArray(payload?.trace)
      ? (payload.trace as unknown[]).join(' ')
      : String(payload?.trace ?? '')
    if (trace) lines.push(`[${relSec}s] ${level.toUpperCase()}: ${trace.slice(0, 300)}`)
  }
  return lines.join('\n')
}

export const fetchIssueDebugContext = async (
  issue: Issue,
  mcpConfig: McpConfig,
): Promise<{ context: string; debugSessionId: string } | undefined> => {
  try {
    const listUrl = new URL(
      `/v0/radar/workspaces/${issue.workspace}/projects/${issue.project}/debug-sessions`,
      mcpConfig.apiUrl,
    )
    listUrl.searchParams.set('issueComponentHash', issue.componentHash)
    listUrl.searchParams.set('limit', '1')
    listUrl.searchParams.set('sortKey', 'createdAt')
    listUrl.searchParams.set('sortDirection', '-1')
    const listRes = await fetch(listUrl.toString(), {
      headers: getAuthHeaders(mcpConfig.apiKey, mcpConfig.authType),
    })
    if (!listRes.ok) return undefined
    const listData = (await listRes.json()) as any
    const debugSession = listData.data?.[0]
    if (!debugSession) return undefined

    // Find the span ID for this specific issue in the session
    const sessionIssue = (debugSession.issues as any[] | undefined)?.find(
      (i: any) => i.issueComponentHash === issue.componentHash,
    )
    const targetSpanId = sessionIssue?.spanId as string | undefined

    let traces: unknown[] = []
    let logs: unknown[] = []

    if (debugSession.finishedS3Transfer && Array.isArray(debugSession.s3Files)) {
      const tracesFile = (debugSession.s3Files as any[]).find((f: any) => f.dataType === 'OTLP_TRACES')
      const logsFile = (debugSession.s3Files as any[]).find((f: any) => f.dataType === 'OTLP_LOGS')
      const [tracesData, logsData] = await Promise.all([
        tracesFile?.url ? fetch(tracesFile.url).then((r: any) => (r.ok ? r.json() : [])) : Promise.resolve([]),
        logsFile?.url ? fetch(logsFile.url).then((r: any) => (r.ok ? r.json() : [])) : Promise.resolve([]),
      ])
      traces = Array.isArray(tracesData) ? tracesData : (tracesData?.data ?? [])
      logs = Array.isArray(logsData) ? logsData : (logsData?.data ?? [])
    } else {
      const tracesUrl = new URL(
        `/v0/radar/workspaces/${issue.workspace}/projects/${issue.project}/debug-sessions/${debugSession._id}/otel-traces`,
        mcpConfig.apiUrl,
      )
      tracesUrl.searchParams.set('skip', '0')
      tracesUrl.searchParams.set('limit', '300')
      const logsUrl = new URL(
        `/v0/radar/workspaces/${issue.workspace}/projects/${issue.project}/debug-sessions/${debugSession._id}/otel-logs`,
        mcpConfig.apiUrl,
      )
      logsUrl.searchParams.set('skip', '0')
      logsUrl.searchParams.set('limit', '300')
      const [tracesRes, logsRes] = await Promise.all([
        fetch(tracesUrl.toString(), {
          headers: getAuthHeaders(mcpConfig.apiKey, mcpConfig.authType),
        }),
        fetch(logsUrl.toString(), {
          headers: getAuthHeaders(mcpConfig.apiKey, mcpConfig.authType),
        }),
      ])
      traces = tracesRes.ok ? ((await tracesRes.json()) as any).data : []
      logs = logsRes.ok ? ((await logsRes.json()) as any).data : []
    }

    const issueSpan = targetSpanId ? findSpanById(traces, targetSpanId) : undefined

    return {
      context: JSON.stringify({ sessionId: debugSession._id, issueSpan, traces, logs }),
      debugSessionId: debugSession._id,
    }
  } catch {
    return undefined
  }
}

/**
 * Fetch all debug context for a known debug session ID. Used when a session
 * recording is manually attached to an existing chat — we already know the
 * session; no issue lookup needed.
 */
export const fetchDebugSessionContext = async (
  debugSessionId: string,
  workspaceId: string,
  projectId: string,
  mcpConfig: McpConfig,
): Promise<{ context: string; sessionSketches: SessionSketch[] } | undefined> => {
  try {
    // Fetch the session to find S3 file URLs if available
    const sessionUrl = new URL(
      `/v0/radar/workspaces/${workspaceId}/projects/${projectId}/debug-sessions/${debugSessionId}`,
      mcpConfig.apiUrl,
    )
    const sessionRes = await fetch(sessionUrl.toString(), {
      headers: getAuthHeaders(mcpConfig.apiKey, mcpConfig.authType),
    })
    if (!sessionRes.ok) return undefined
    const debugSession = (await sessionRes.json()) as any

    let traces: unknown[] = []
    let logs: unknown[] = []

    if (debugSession.finishedS3Transfer && Array.isArray(debugSession.s3Files)) {
      const tracesFile = (debugSession.s3Files as any[]).find((f: any) => f.dataType === 'OTLP_TRACES')
      const logsFile = (debugSession.s3Files as any[]).find((f: any) => f.dataType === 'OTLP_LOGS')
      const [tracesData, logsData] = await Promise.all([
        tracesFile?.url ? fetch(tracesFile.url).then((r: any) => (r.ok ? r.json() : [])) : Promise.resolve([]),
        logsFile?.url ? fetch(logsFile.url).then((r: any) => (r.ok ? r.json() : [])) : Promise.resolve([]),
      ])
      traces = Array.isArray(tracesData) ? tracesData : (tracesData?.data ?? [])
      logs = Array.isArray(logsData) ? logsData : (logsData?.data ?? [])
    } else {
      const tracesUrl = new URL(
        `/v0/radar/workspaces/${workspaceId}/projects/${projectId}/debug-sessions/${debugSessionId}/otel-traces`,
        mcpConfig.apiUrl,
      )
      tracesUrl.searchParams.set('skip', '0')
      tracesUrl.searchParams.set('limit', '300')
      const logsUrl = new URL(
        `/v0/radar/workspaces/${workspaceId}/projects/${projectId}/debug-sessions/${debugSessionId}/otel-logs`,
        mcpConfig.apiUrl,
      )
      logsUrl.searchParams.set('skip', '0')
      logsUrl.searchParams.set('limit', '300')
      const [tracesRes, logsRes] = await Promise.all([
        fetch(tracesUrl.toString(), { headers: getAuthHeaders(mcpConfig.apiKey, mcpConfig.authType) }),
        fetch(logsUrl.toString(), { headers: getAuthHeaders(mcpConfig.apiKey, mcpConfig.authType) }),
      ])
      traces = tracesRes.ok ? ((await tracesRes.json()) as any).data : []
      logs = logsRes.ok ? ((await logsRes.json()) as any).data : []
    }

    // Fetch rrweb events and session notes in parallel
    const rrwebUrl = new URL(
      `/v0/radar/workspaces/${workspaceId}/projects/${projectId}/debug-sessions/${debugSessionId}/rrweb-events`,
      mcpConfig.apiUrl,
    )
    rrwebUrl.searchParams.set('limit', '5000')
    const notesUrl = new URL(
      `/v0/radar/workspaces/${workspaceId}/projects/${projectId}/debug-sessions/${debugSessionId}/session-notes/context`,
      mcpConfig.apiUrl,
    )
    const [rrwebRes, notesRes] = await Promise.all([
      fetch(rrwebUrl.toString(), { headers: getAuthHeaders(mcpConfig.apiKey, mcpConfig.authType) }),
      fetch(notesUrl.toString(), { headers: getAuthHeaders(mcpConfig.apiKey, mcpConfig.authType) }),
    ])
    const rawRrweb = rrwebRes.ok ? ((await rrwebRes.json()) as any) : null
    const notesData: { notes: unknown[]; sketches: SessionSketch[] } | null = notesRes.ok
      ? ((await notesRes.json()) as any)
      : null

    const rrwebEvents: unknown[] = Array.isArray(rawRrweb) ? rawRrweb : (rawRrweb?.data ?? [])
    const rrwebConsoleLogs = extractRrwebConsoleLogs(rrwebEvents)
    const sessionNotes = notesData?.notes ?? []
    const sessionSketches: SessionSketch[] = (notesData?.sketches ?? []) as SessionSketch[]

    return {
      context: JSON.stringify({ sessionId: debugSessionId, traces, logs, sessionNotes, rrwebConsoleLogs }),
      sessionSketches,
    }
  } catch {
    return undefined
  }
}

/**
 * Render a session recording frame at a playback timestamp via the assets service.
 * Uses the same rrweb + puppeteer pipeline as session note sketch screenshots.
 */
export const fetchDebugSessionSnapshot = async (
  debugSessionId: string,
  timestampMs: number,
  workspaceId: string,
  projectId: string,
  mcpConfig: McpConfig,
): Promise<string | undefined> => {
  try {
    const url = new URL(
      `/v0/assets/workspaces/${workspaceId}/projects/${projectId}/debug-sessions/${debugSessionId}/notes/snapshot`,
      mcpConfig.apiUrl,
    )
    url.searchParams.set('timestamp', String(Math.floor(timestampMs)))

    const res = await fetch(url.toString(), {
      headers: getAuthHeaders(mcpConfig.apiKey, mcpConfig.authType),
    })
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '')
      logger.warn(
        `fetchDebugSessionSnapshot: HTTP ${res.status} for session ${debugSessionId} @ ${timestampMs}ms${errorBody ? `: ${errorBody.slice(0, 200)}` : ''}`,
      )
      return undefined
    }

    const buf = await res.arrayBuffer()
    const b64 = Buffer.from(buf).toString('base64')
    return `data:image/jpeg;base64,${b64}`
  } catch (err) {
    logger.warn(`fetchDebugSessionSnapshot: ${String(err)}`)
    return undefined
  }
}

/**
 * Build a standalone context document for a manually-attached debug session
 * (no issue metadata available).
 */
export const buildAttachedSessionContextDoc = (debugSessionId: string, debugContext: string): string => {
  let parsedCtx:
    | { sessionId?: string; traces?: any[]; logs?: any[]; sessionNotes?: any[]; rrwebConsoleLogs?: string }
    | undefined
  if (debugContext) {
    try {
      parsedCtx = JSON.parse(debugContext)
    } catch {
      // non-parseable — proceed without details
    }
  }

  const lines: string[] = ['# Attached Session Recording', '', `**Session ID:** \`${debugSessionId}\``]

  const capturedLines: string[] = []

  if (parsedCtx) {
    capturedLines.push('## Debug Session')

    if (Array.isArray(parsedCtx.sessionNotes) && parsedCtx.sessionNotes.length > 0) {
      capturedLines.push('', '### Session Notes')
      for (const note of parsedCtx.sessionNotes as any[]) {
        const text = note.text ?? note.content ?? JSON.stringify(note)
        const type = note.type ? `[${note.type}] ` : ''
        capturedLines.push(`- ${type}${safeCapturedText(text)}`)
      }
    }

    if (parsedCtx.rrwebConsoleLogs) {
      capturedLines.push('', '### Browser Console Logs (from session recording)')
      capturedLines.push(parsedCtx.rrwebConsoleLogs)
    }

    if (Array.isArray(parsedCtx.logs) && parsedCtx.logs.length > 0) {
      capturedLines.push('', `### Logs (${parsedCtx.logs.length} entries)`)
      const logLines: string[] = []
      const collectLogs = (items: any[]) => {
        for (const item of items) {
          const scopeLogs = item.scopeLogs ?? item.scope_logs ?? []
          for (const scope of scopeLogs) {
            for (const record of scope.logRecords ?? scope.log_records ?? []) {
              const severity = record.severityText ?? record.severity_text ?? ''
              const body = record.body?.stringValue ?? record.body?.string_value ?? record.body ?? ''
              if (body) logLines.push(`- **[${safeCapturedText(severity)}]** ${safeCapturedText(body, 200)}`)
            }
          }
        }
      }
      collectLogs(parsedCtx.logs)
      capturedLines.push(...logLines.slice(0, 30))
      if (logLines.length > 30) capturedLines.push(`  … and ${logLines.length - 30} more log entries`)
    }

    if (Array.isArray(parsedCtx.traces) && parsedCtx.traces.length > 0) {
      capturedLines.push(
        '',
        '### Raw OTLP Spans',
        '```json',
        JSON.stringify(sanitizeCapturedValue(parsedCtx.traces), null, 2),
        '```',
      )
    }
  }

  if (capturedLines.length > 0) {
    lines.push('', '## Captured Observability Data', wrapUntrustedObservabilityData(capturedLines.join('\n')))
  }

  lines.push('', '---', '*Generated by multiplayer debugging agent*')
  return lines.join('\n')
}

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'])

/**
 * Fetches the content of user-uploaded file attachments so the LLM can see them.
 * - Images: returned as base64 data URLs for vision-capable models.
 * - Text/code files: returned as labelled text blocks appended to message content.
 *
 * `mimeType` on the attachment is used first; the response `Content-Type` header is
 * consulted as a fallback when `mimeType` is absent so images are never mis-classified.
 * Silently skips attachments that fail to fetch.
 */
export const fetchAttachmentContent = async (
  attachments: Array<{ name: string; url?: string; mimeType?: string }>,
): Promise<{ textBlocks: string[]; images: string[] }> => {
  const textBlocks: string[] = []
  const images: string[] = []

  await Promise.all(
    attachments.map(async (attachment) => {
      const { url, name, mimeType } = attachment
      if (!url) return

      try {
        const res = await fetch(url)
        if (!res.ok) {
          logger.warn(`fetchAttachmentContent: failed to fetch "${name}" — HTTP ${res.status} (URL may have expired)`)
          return
        }

        // Prefer the declared mimeType; fall back to Content-Type so images with a
        // missing or generic mimeType (e.g. "application/octet-stream") are still
        // treated as images when the server sends the correct Content-Type.
        const contentTypeHeader = res.headers.get('content-type') ?? ''
        const effectiveMimeType = mimeType || contentTypeHeader.split(';')[0]!.trim()

        if (effectiveMimeType && IMAGE_MIME_TYPES.has(effectiveMimeType)) {
          const buf = await res.arrayBuffer()
          const b64 = Buffer.from(buf).toString('base64')
          // Use the effective mimeType so the data URL is always valid
          images.push(`data:${effectiveMimeType};base64,${b64}`)
        } else {
          // Treat everything else as text (code, logs, plain text, etc.)
          const text = await res.text()
          if (text.trim()) {
            textBlocks.push(`<attachment name="${name}">\n${text.slice(0, 50_000)}\n</attachment>`)
          }
        }
      } catch (err) {
        // Non-fatal — log and continue so the text portion still reaches the agent
        logger.warn(`fetchAttachmentContent: error fetching "${name}": ${String(err)}`)
      }
    }),
  )

  return { textBlocks, images }
}

export interface IssueAnalysis {
  fixabilityScore: number
  severity: 'high' | 'medium' | 'low'
}

export const analyseIssueContext = async (
  markdown: string,
  model: string,
  modelKey: string,
  modelUrl?: string,
): Promise<IssueAnalysis> => {
  try {
    const provider = createProvider({ model, apiKey: modelKey, baseUrl: modelUrl })
    const { text } = await provider.complete({
      systemPrompt: ANALYSE_ISSUE_SYSTEM_PROMPT,
      userMessage: buildAnalyseIssueUserMessage(markdown),
      maxTokens: 100,
    })
    return JSON.parse(text) as IssueAnalysis
  } catch {
    // Fall back to a conservative default so the agent still runs
    return { fixabilityScore: 70, severity: 'medium' }
  }
}

interface SpanData {
  operation?: string
  service?: string
  attributes: Record<string, any>
  exception?: { type?: string; message?: string; stacktrace?: string }
}

const extractSpanData = (span: any): SpanData => {
  // Flat ITraceData format (from API — uppercase field names)
  if (span.SpanId) {
    const attributes: Record<string, any> = (span.SpanAttributes as Record<string, any> | undefined) ?? {}
    let exception: SpanData['exception']
    const eventNames = (span['Events.Name'] as string[] | undefined) ?? []
    const eventAttrs = (span['Events.Attributes'] as Record<string, any>[] | undefined) ?? []
    for (let i = 0; i < eventNames.length; i++) {
      if (eventNames[i] === 'exception') {
        const ea = eventAttrs[i] ?? {}
        exception = {
          type: ea['exception.type'],
          message: ea['exception.message'],
          stacktrace: ea['exception.stacktrace'],
        }
        break
      }
    }
    return { operation: span.SpanName, service: span.ServiceName, attributes, exception }
  }

  // OTLP format (from S3 — camelCase nested)
  const attributes: Record<string, any> = {}
  for (const kv of span.attributes ?? []) {
    if (kv.key) attributes[kv.key] = kv.value?.stringValue ?? kv.value?.intValue ?? kv.value
  }
  let exception: SpanData['exception']
  for (const event of span.events ?? []) {
    if (event.name === 'exception') {
      const evAttrs: Record<string, any> = {}
      for (const kv of event.attributes ?? []) {
        if (kv.key) evAttrs[kv.key] = kv.value?.stringValue ?? kv.value?.intValue ?? kv.value
      }
      exception = {
        type: evAttrs['exception.type'],
        message: evAttrs['exception.message'],
        stacktrace: evAttrs['exception.stacktrace'],
      }
      break
    }
  }
  return { operation: span.name, attributes, exception }
}

const SPAN_ATTR_SKIP = new Set([
  'multiplayer.project._id',
  'multiplayer.workspace._id',
  'multiplayer.debug_session._id',
  'multiplayer.integration._id',
])

const safeCapturedText = (value: unknown, maxLength?: number): string => {
  const text = escapePromptMarkup(String(value))
  return maxLength === undefined ? text : text.slice(0, maxLength)
}

export const buildIssueContextDoc = (
  issue: Issue,
  release: Release | undefined,
  debugContext: string | undefined,
): string => {
  // Extract span data upfront so we can use it throughout the document
  let parsedCtx: { sessionId?: string; issueSpan?: any; traces?: any[]; logs?: any[] } | undefined
  let spanData: SpanData | undefined
  if (debugContext) {
    try {
      parsedCtx = JSON.parse(debugContext)
      if (parsedCtx?.issueSpan) spanData = extractSpanData(parsedCtx.issueSpan)
    } catch {
      // non-parseable — proceed without span data
    }
  }

  // Prefer span exception data over normalized issue metadata
  const effectiveType = spanData?.exception?.type ?? issue.metadata.type
  const effectiveMessage = spanData?.exception?.message ?? issue.metadata.message
  const effectiveStacktrace = spanData?.exception?.stacktrace ?? issue.metadata.stacktrace

  const lines: string[] = [
    `# Issue: ${issue.title}`,
    '',
    `**Component Hash:** \`${issue.componentHash}\``,
    `**Category:** ${issue.category}`,
    `**Service:** ${issue.service.serviceName}`,
  ]

  if (issue.service.environment) {
    lines.push(`**Environment:** ${issue.service.environment}`)
  }
  if (issue.service.release) {
    lines.push(`**Release Version:** ${issue.service.release}`)
  }

  if (release) {
    lines.push('', '## Release')
    lines.push(`**Version:** ${release.version}`)
    if (release.commitHash) lines.push(`**Commit:** \`${release.commitHash}\``)
    if (release.repositoryUrl) lines.push(`**Repository:** ${release.repositoryUrl}`)
    if (release.releaseNotes) lines.push('', '**Release Notes:**', release.releaseNotes)
  }

  const capturedLines: string[] = []

  if (
    effectiveMessage ||
    effectiveType ||
    issue.metadata.filename ||
    issue.metadata.function ||
    issue.metadata.httpMethod
  ) {
    capturedLines.push('## Error Details')
    if (effectiveMessage) capturedLines.push(`**Message:** ${safeCapturedText(effectiveMessage)}`)
    if (effectiveType) capturedLines.push(`**Type:** ${safeCapturedText(effectiveType)}`)
    if (issue.metadata.filename) capturedLines.push(`**File:** ${safeCapturedText(issue.metadata.filename)}`)
    if (issue.metadata.function) capturedLines.push(`**Function:** ${safeCapturedText(issue.metadata.function)}`)
    if (issue.metadata.httpMethod && issue.metadata.httpRoute) {
      capturedLines.push(
        `**HTTP:** ${safeCapturedText(issue.metadata.httpMethod)} ${safeCapturedText(issue.metadata.httpRoute)}`,
      )
    }
    if (issue.metadata.value) capturedLines.push(`**Value:** ${safeCapturedText(issue.metadata.value)}`)
  }

  if (effectiveStacktrace) {
    const label = spanData?.exception?.stacktrace ? '## Stacktrace (from span)' : '## Stacktrace'
    if (capturedLines.length > 0) capturedLines.push('')
    capturedLines.push(label, '```', safeCapturedText(effectiveStacktrace), '```')
  }

  if (parsedCtx) {
    if (capturedLines.length > 0) capturedLines.push('')
    capturedLines.push('## Debug Session')
    if (parsedCtx.sessionId) capturedLines.push(`**Session ID:** \`${safeCapturedText(parsedCtx.sessionId)}\``)

    if (spanData) {
      capturedLines.push('', '### Issue Span')
      if (spanData.operation) capturedLines.push(`**Operation:** ${safeCapturedText(spanData.operation)}`)
      if (spanData.service) capturedLines.push(`**Service:** ${safeCapturedText(spanData.service)}`)

      // Span attributes — skip internal multiplayer fields and already-shown exception fields
      const attrEntries = Object.entries(spanData.attributes).filter(
        ([k, v]) => v != null && v !== '' && !SPAN_ATTR_SKIP.has(k) && !k.startsWith('exception.'),
      )
      if (attrEntries.length > 0) {
        capturedLines.push('', '**Span Attributes:**')
        for (const [k, v] of attrEntries) {
          capturedLines.push(`- \`${safeCapturedText(k)}\`: ${safeCapturedText(v, 500)}`)
        }
      }

      if (spanData.exception) {
        if (spanData.exception.type)
          capturedLines.push(`**Exception Type:** ${safeCapturedText(spanData.exception.type)}`)
        if (spanData.exception.message) {
          capturedLines.push(`**Exception Message:** ${safeCapturedText(spanData.exception.message)}`)
        }
      }
    }

    if (Array.isArray(parsedCtx.logs) && parsedCtx.logs.length > 0) {
      capturedLines.push('', `### Logs (${parsedCtx.logs.length} entries)`)
      const logLines: string[] = []
      const collectLogs = (items: any[]) => {
        for (const item of items) {
          const scopeLogs = item.scopeLogs ?? item.scope_logs ?? []
          for (const scope of scopeLogs) {
            for (const record of scope.logRecords ?? scope.log_records ?? []) {
              const severity = record.severityText ?? record.severity_text ?? ''
              const body = record.body?.stringValue ?? record.body?.string_value ?? record.body ?? ''
              if (body) logLines.push(`- **[${safeCapturedText(severity)}]** ${safeCapturedText(body, 200)}`)
            }
          }
        }
      }
      collectLogs(parsedCtx.logs)
      capturedLines.push(...logLines.slice(0, 30))
      if (logLines.length > 30) capturedLines.push(`  … and ${logLines.length - 30} more log entries`)
    }

    if (Array.isArray(parsedCtx.traces) && parsedCtx.traces.length > 0) {
      capturedLines.push(
        '',
        '### Raw OTLP Spans',
        '```json',
        JSON.stringify(sanitizeCapturedValue(parsedCtx.traces), null, 2),
        '```',
      )
    }

    if (Array.isArray(parsedCtx.logs) && parsedCtx.logs.length > 0) {
      capturedLines.push(
        '',
        '### Raw OTLP Logs',
        '```json',
        JSON.stringify(sanitizeCapturedValue(parsedCtx.logs), null, 2),
        '```',
      )
    }
  }

  if (capturedLines.length > 0) {
    lines.push('', '## Captured Observability Data', wrapUntrustedObservabilityData(capturedLines.join('\n')))
  }

  lines.push('', '---', '*Generated by multiplayer debugging agent*')

  const markdown = lines.join('\n')

  return markdown
}

export { buildIssuePromptFallback }

const makeDebugSessionApiCall = async (
  url: URL,
  mcpConfig: McpConfig,
): Promise<CallToolResult> => {
  try {
    const res = await fetch(url.toString(), {
      headers: getAuthHeaders(mcpConfig.apiKey, mcpConfig.authType),
    })
    if (!res.ok) {
      return { content: [{ type: 'text', text: `API error ${res.status}: ${res.statusText}` }], isError: true }
    }
    const data = await res.json()
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }
  }
}

/**
 * Builds an in-process MCP server exposing 4 granular debug-session tools.
 * The LLM calls whichever tools it needs on demand instead of loading everything upfront.
 */
export const buildDebugSessionMcpServer = (
  mcpConfig: McpConfig,
  workspaceId: string,
  projectId: string,
): McpServerConfig => {
  const base = `${mcpConfig.apiUrl}/v0/radar/workspaces/${workspaceId}/projects/${projectId}`
  const debugSessionId = z.string().describe('The debug session ID')

  const tracesTool = tool(
    'get_debug_session_traces',
    'Fetch OTLP traces for a Multiplayer debug session.',
    { debugSessionId },
    async ({ debugSessionId: id }): Promise<CallToolResult> => {
      const url = new URL(`${base}/debug-sessions/${id}/otel-traces`)
      url.searchParams.set('skip', '0')
      url.searchParams.set('limit', '300')
      return makeDebugSessionApiCall(url, mcpConfig)
    },
  )

  const logsTool = tool(
    'get_debug_session_logs',
    'Fetch OTLP logs for a Multiplayer debug session.',
    { debugSessionId },
    async ({ debugSessionId: id }): Promise<CallToolResult> => {
      const url = new URL(`${base}/debug-sessions/${id}/otel-logs`)
      url.searchParams.set('skip', '0')
      url.searchParams.set('limit', '300')
      return makeDebugSessionApiCall(url, mcpConfig)
    },
  )

  const notesTool = tool(
    'get_debug_session_notes',
    'Fetch session notes and sketches for a Multiplayer debug session.',
    { debugSessionId },
    async ({ debugSessionId: id }): Promise<CallToolResult> => {
      const url = new URL(`${base}/debug-sessions/${id}/session-notes/context`)
      return makeDebugSessionApiCall(url, mcpConfig)
    },
  )

  const rrwebTool = tool(
    'get_debug_session_rrweb_timeline',
    'Fetch the rrweb UI recording timeline for a Multiplayer debug session.',
    { debugSessionId },
    async ({ debugSessionId: id }): Promise<CallToolResult> => {
      const url = new URL(`${base}/debug-sessions/${id}/rrweb-events`)
      url.searchParams.set('limit', '5000')
      return makeDebugSessionApiCall(url, mcpConfig)
    },
  )

  return createSdkMcpServer({
    name: 'multiplayer-debug-sessions',
    version: '1.0.0',
    tools: [tracesTool, logsTool, notesTool, rrwebTool],
  })
}

/**
 * Starts a Claude session seeded with a debug session analysis prompt.
 * The agent uses MCP tools to fetch traces/logs/notes/rrweb on demand.
 */
export const startDebugSessionChat = async (
  debugSessionId: string,
  projectDir: string,
  mcpConfig: McpConfig,
  workspaceId: string,
  projectId: string,
  model: string,
  modelKey: string,
  modelUrl: string | undefined,
  abortSignal: AbortSignal | undefined,
  callbacks: StreamCallbacks,
): Promise<string> => {
  const seedPrompt = `Debug session \`${debugSessionId}\` has been opened. Use the available tools (\`get_debug_session_traces\`, \`get_debug_session_logs\`, \`get_debug_session_notes\`, \`get_debug_session_rrweb_timeline\`) to investigate this session and provide a comprehensive summary: what happened, any errors or anomalies, and notable user interactions.`
  const history: ConversationMessage[] = [{ role: 'user', content: seedPrompt }]
  const mcpServers = {
    'multiplayer-debug-sessions': buildDebugSessionMcpServer(mcpConfig, workspaceId, projectId),
  }
  return continueChat(history, projectDir, model, modelKey, modelUrl, abortSignal, callbacks, mcpServers)
}

// ─── Event → callback adapter ─────────────────────────────────────────────────

/**
 * Iterates over provider events and dispatches them to the StreamCallbacks that
 * the rest of the application uses. This is the only place that knows about
 * both the library's event model and the application's callback model.
 *
 * Returns the final text and any patches collected during the session.
 */
async function dispatchAgentEvents(
  events: AsyncIterable<AgentStreamEvent>,
  callbacks: StreamCallbacks,
): Promise<{ finalText: string; patches: FilePatch[] }> {
  let finalText = ''
  const patches: FilePatch[] = []

  for await (const event of events) {
    switch (event.type) {
      case 'turn_start':
        callbacks.onTurnStart?.()
        break
      case 'text_delta':
        callbacks.onProgress?.(event.text)
        break
      case 'tool_call':
        callbacks.onToolCall?.(event)
        break
      case 'tool_result':
        callbacks.onToolCallResult?.(event)
        break
      case 'progress':
        callbacks.onProgress?.(event.message)
        break
      case 'patch':
        patches.push(...event.patches)
        break
      case 'done':
        finalText = event.finalText
        break
      case 'aborted':
        callbacks.onProgress?.('[aborted]')
        break
      case 'error':
        throw event.error
      // 'tool_confirm' is emitted before the provider calls confirmToolCall —
      // the UI reacts to the tool_call event instead, so no action needed here.
    }
  }

  return { finalText, patches }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const resolveIssue = async (
  _issue: Issue,
  projectDir: string,
  prompt: string,
  model: string,
  modelKey: string,
  modelUrl: string | undefined,
  abortSignal: AbortSignal | undefined,
  callbacks: StreamCallbacks,
  isDemoProject?: boolean,
): Promise<FilePatch[]> => {
  const provider = createProvider({ model, apiKey: modelKey, baseUrl: modelUrl })
  const { patches } = await dispatchAgentEvents(
    provider.runAgentic({
      history: [{ role: 'user', content: prompt }],
      projectDir,
      confirmToolCall: callbacks.confirmToolCall,
      abortSignal,
      isFixFlow: true,
      isDemoProject,
    }),
    callbacks,
  )
  return patches
}

export const generatePrContent = async (
  issue: Issue,
  history: ConversationMessage[],
  diffStats: { additions: number; deletions: number },
  model: string,
  modelKey?: string,
  modelUrl?: string,
): Promise<{ title: string; body: string }> => {
  const conversationContext = history
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n\n')
    .slice(0, 4000)

  try {
    const provider = createProvider({ model, apiKey: modelKey ?? '', baseUrl: modelUrl })
    const { text } = await provider.complete({
      systemPrompt: PR_GENERATION_SYSTEM_PROMPT,
      userMessage: buildPrUserMessage(issue, conversationContext, diffStats),
      maxTokens: 1024,
    })
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0]) as { title?: string; body?: string }
      if (parsed.title && parsed.body) return { title: parsed.title, body: parsed.body }
    }
  } catch {
    // Fall through to default
  }

  return {
    title: `fix: ${issue.title}`,
    body: `Fixes issue \`${issue.componentHash}\`.\n\nChanges: +${diffStats.additions}/-${diffStats.deletions} lines.\n[issue](${issue.url})`,
  }
}

export const continueChat = async (
  history: ConversationMessage[],
  projectDir: string,
  model: string,
  modelKey: string,
  modelUrl: string | undefined,
  abortSignal: AbortSignal | undefined,
  callbacks: StreamCallbacks,
  mcpServers?: Record<string, McpServerConfig>,
): Promise<string> => {
  const provider = createProvider({ model, apiKey: modelKey, baseUrl: modelUrl })
  const llmHistory = history.map((m) => ({ role: m.role, content: m.content, images: m.images }))
  const { finalText } = await dispatchAgentEvents(
    provider.runAgentic({
      history: llmHistory,
      projectDir,
      mcpServers,
      confirmToolCall: callbacks.confirmToolCall,
      abortSignal,
    }),
    callbacks,
  )
  return finalText
}
