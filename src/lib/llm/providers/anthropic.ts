/**
 * Anthropic provider — wraps @anthropic-ai/claude-agent-sdk.
 *
 * Key characteristics:
 *  - The SDK subprocess manages the entire agentic loop: tool selection,
 *    execution, multi-turn sequencing. We only translate SDK messages → events.
 *  - `extraTools` / `extraToolHandlers` / `confirmToolCall` in AgenticRequest
 *    are NOT supported. Claude Code owns its tool set.
 *  - `mcpServers` ARE supported and passed through to query().
 *  - Images in the last user message are sent as Anthropic image blocks.
 *    Images in prior history are serialised as "[Image N: attached]" text.
 */

import Anthropic from '@anthropic-ai/sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import cliPath from '@anthropic-ai/claude-agent-sdk/embed'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import { simpleGit } from 'simple-git'
import type { LLMProvider, CompletionRequest, AgenticRequest, AgentStreamEvent, FilePatch } from '../types.js'
import { buildClaudeCodeDebuggingSystemPrompt } from '../../../prompts.js'

const execAsync = promisify(exec)

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Auth probe: checks whether the `claude` CLI is installed and authenticated.
 * The SDK can silently succeed even when not logged in, so we probe the CLI
 * binary directly — same approach as `claude -p "ok"`.
 */
async function probeClaueCliAuth(loginError: Error): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', 'ok'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''

    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })

    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Claude login probe timed out after 30 s'))
    }, 30_000)

    child.on('error', (err) => { clearTimeout(timeout); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (/not logged in|please run \/login/i.test(output)) { reject(loginError); return }
      if (code !== 0) { reject(new Error(`Claude login probe exited with code ${code ?? '?'}`)); return }
      resolve()
    })
  })
}

/**
 * Rewrites patch-instruction language in a prompt so Claude Code understands
 * it should edit files directly rather than producing a write_patch output.
 */
function rewriteForDirectEdits(prompt: string): string {
  return prompt.replace(
    /please analyze this issue and produce file patches to fix it\. read relevant source files based on the stacktrace and error details above\./gi,
    'Fix the issue by directly editing the relevant source files using the Edit or Write tools. Read the relevant source files based on the stacktrace and error details above, then apply the fix.',
  )
}

/**
 * Converts a base64 data URL (e.g. `data:image/png;base64,…`) to an Anthropic
 * image block that can be sent as part of a user message.
 */
function dataUrlToImageBlock(dataUrl: string): Anthropic.ImageBlockParam {
  const commaIdx = dataUrl.indexOf(',')
  const meta = dataUrl.slice(0, commaIdx) // e.g. "data:image/jpeg;base64"
  const data = dataUrl.slice(commaIdx + 1)
  const mediaType = meta.replace('data:', '').replace(';base64', '') as
    | 'image/jpeg'
    | 'image/png'
    | 'image/gif'
    | 'image/webp'
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
}

// ─── Stream event translation ─────────────────────────────────────────────────

/** Mutable state tracked while translating a single SDK stream. */
interface StreamState {
  /** A tool_use block currently being assembled from delta events. */
  pendingTool: { id: string; name: string; inputJson: string } | null
  /**
   * Tool calls emitted to the consumer but whose result we haven't received yet.
   * Keyed by tool_use_id so we can emit tool_result events when the SDK
   * sends back a user message with tool_result blocks.
   */
  runningTools: Map<string, { name: string; input: Record<string, unknown> }>
}

function makeStreamState(): StreamState {
  return { pendingTool: null, runningTools: new Map() }
}

/**
 * Translates a single `stream_event` from the Claude SDK into zero or more
 * AgentStreamEvents. Written as a generator for clarity — no array allocations.
 */
function* translateStreamEvent(
  event: Record<string, unknown>,
  state: StreamState,
  accumulateText: (text: string) => void,
): Generator<AgentStreamEvent> {
  switch (event.type) {
    case 'message_start': {
      // Flush any tool calls whose tool_result message never arrived.
      for (const [id, data] of state.runningTools) {
        yield { type: 'tool_result', id, ...data, status: 'succeeded', output: {} }
      }
      state.runningTools.clear()
      yield { type: 'turn_start' }
      break
    }

    case 'content_block_start': {
      const block = event.content_block as Record<string, unknown> | undefined
      if (block?.type === 'tool_use') {
        state.pendingTool = {
          id: block.id as string,
          name: block.name as string,
          inputJson: '',
        }
      }
      break
    }

    case 'content_block_delta': {
      const delta = event.delta as Record<string, unknown> | undefined
      if (delta?.type === 'text_delta') {
        const text = delta.text as string
        accumulateText(text)
        yield { type: 'text_delta', text }
      } else if (delta?.type === 'input_json_delta' && state.pendingTool) {
        state.pendingTool.inputJson += (delta.partial_json as string) ?? ''
      }
      break
    }

    case 'content_block_stop': {
      if (!state.pendingTool) break
      let input: Record<string, unknown>
      try {
        input = state.pendingTool.inputJson ? JSON.parse(state.pendingTool.inputJson) : {}
      } catch {
        input = {}
      }
      yield { type: 'tool_call', id: state.pendingTool.id, name: state.pendingTool.name, input }
      state.runningTools.set(state.pendingTool.id, { name: state.pendingTool.name, input })
      state.pendingTool = null
      break
    }
  }
}

/**
 * Processes a `user` message from the SDK that contains tool_result blocks.
 * Emits a tool_result event for each completed tool call we were tracking.
 */
function* translateToolResults(
  msg: Record<string, unknown>,
  state: StreamState,
): Generator<AgentStreamEvent> {
  if (msg.type !== 'user') return
  const content = (msg.message as Record<string, unknown> | undefined)?.content
  if (!Array.isArray(content)) return

  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type !== 'tool_result') continue
    const id = block.tool_use_id as string
    const data = state.runningTools.get(id)
    if (!data) continue

    const rawContent = block.content
    const outputText = Array.isArray(rawContent)
      ? (rawContent as Array<Record<string, unknown>>).map((c) => c.text ?? '').join('')
      : typeof rawContent === 'string'
        ? rawContent
        : ''

    yield {
      type: 'tool_result',
      id,
      ...data,
      status: block.is_error ? 'failed' : 'succeeded',
      output: { content: outputText },
    }
    state.runningTools.delete(id)
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export interface AnthropicProviderOptions {
  /**
   * Claude model to use. `undefined` means let Claude Code pick (default behaviour
   * when the user selected "claude-code" in the setup wizard).
   */
  model: string | undefined
}

export class AnthropicProvider implements LLMProvider {
  private readonly model: string | undefined

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model
  }

  // ── complete() ─────────────────────────────────────────────────────────────

  async complete(request: CompletionRequest): Promise<{ text: string }> {
    const prompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n${request.userMessage}`
      : request.userMessage

    let text = ''
    for await (const message of query({
      prompt,
      options: {
        cwd: process.cwd(),
        executable: 'node',
        pathToClaudeCodeExecutable: cliPath,
        permissionMode: 'acceptEdits',
        settingSources: [],
        maxTurns: 1,
        ...(this.model ? { model: this.model } : {}),
      },
    })) {
      const msg = message as Record<string, unknown>
      if (msg.type === 'result' && msg.subtype === 'success') {
        text = (msg.result as string | undefined) ?? ''
      }
    }

    return { text }
  }

  // ── runAgentic() ───────────────────────────────────────────────────────────

  async *runAgentic(request: AgenticRequest): AsyncIterable<AgentStreamEvent> {
    const absProjectDir = path.resolve(request.projectDir)
    const { history, systemPrompt, mcpServers, abortSignal, isFixFlow, isDemoProject } = request

    if (!history.length) throw new Error('EMPTY_HISTORY')

    const prompt = this.buildPrompt(history, isFixFlow)
    const state = makeStreamState()
    let finalText = ''

    // The SDK calls stderr as a callback, but generators can't yield from
    // callbacks. We buffer lines and flush them after each SDK message.
    const stderrLines: string[] = []

    try {
      for await (const message of query({
        prompt,
        options: {
          cwd: absProjectDir,
          executable: 'node',
          pathToClaudeCodeExecutable: cliPath,
          ...this.buildQueryOptions(absProjectDir, systemPrompt, mcpServers, isFixFlow, isDemoProject),
          stderr: (data: string) => {
            const line = data.trim()
            if (line) stderrLines.push(line)
          },
        },
      })) {
        // Flush any stderr lines that arrived since the last iteration
        while (stderrLines.length > 0) {
          yield { type: 'progress', message: `[claude] ${stderrLines.shift()!}` }
        }
        if (abortSignal?.aborted) {
          yield { type: 'aborted' }
          return
        }

        const msg = message as Record<string, unknown>

        // Tool results arrive as user messages with tool_result content blocks
        yield* translateToolResults(msg, state)

        if (msg.type === 'stream_event') {
          yield* translateStreamEvent(
            msg.event as Record<string, unknown>,
            state,
            (text) => { finalText += text },
          )
        } else if (isFixFlow && msg.type === 'system' && msg.subtype === 'task_progress') {
          yield { type: 'progress', message: msg.description as string }
        } else if (msg.type === 'result' && msg.subtype !== 'success') {
          const errors = (msg.errors as string[] | undefined) ?? []
          const detail = errors.length > 0 ? `\n${errors.join('\n')}` : ''
          const labels: Record<string, string> = {
            error_during_execution: 'Error during execution',
            error_max_turns: 'Max turns reached',
            error_max_budget_usd: 'Budget limit exceeded',
            error_max_structured_output_retries: 'Structured output retries exceeded',
          }
          const label = labels[msg.subtype as string] ?? (msg.subtype as string)
          throw new Error(`Claude Code process exited: ${label}${detail}`)
        }
      }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
      return
    }

    // Fix flow: read git status to discover which files Claude edited directly
    if (isFixFlow && !abortSignal?.aborted) {
      const patches = await this.collectGitPatches(absProjectDir)
      if (patches.length > 0) {
        yield { type: 'patch', patches }
      }
    }

    yield { type: 'done', finalText }
  }

  // ── validateCredentials() ──────────────────────────────────────────────────

  async validateCredentials(): Promise<void> {
    // Check that the claude binary is in PATH
    try {
      const { stdout } = await execAsync('claude --version', { timeout: 5000 })
      void stdout // version string, not needed
    } catch {
      throw new Error(
        'Claude CLI is not installed. Install it with:\n  npm install -g @anthropic-ai/claude-code',
      )
    }

    // An ANTHROPIC_API_KEY bypasses interactive login — skip the probe
    if (!process.env.ANTHROPIC_API_KEY) {
      const loginError = new Error(
        'Claude Code is not authenticated.\n' +
          'Open a new terminal, run "claude" and complete login, then press Retry.',
      )
      await probeClaueCliAuth(loginError)
    }

    // Verify the explicitly-selected model is usable (skip for the default 'claude-code')
    if (this.model) {
      await this.verifyModel(this.model)
    }
  }

  // ── listModels() ───────────────────────────────────────────────────────────

  async listModels(): Promise<string[]> {
    // Requires an ANTHROPIC_API_KEY. Claude Code OAuth users have none, so
    // this returns [] and the caller falls back to a static model list.
    try {
      const client = new Anthropic()
      const page = await client.models.list({ limit: 100 })
      const ids = page.data.map((m) => m.id).filter((id) => id.startsWith('claude-'))
      const idSet = new Set(ids)

      // Remove dated snapshots: if stripping -YYYYMMDD yields another known id,
      // this entry is a snapshot already covered by the canonical alias.
      // Exception: models whose canonical name ends in a date (e.g. claude-haiku-4-5-20251001)
      // are kept because their base (claude-haiku-4-5) doesn't appear in the list.
      return ids.filter((id) => {
        const match = id.match(/^(.+)-(\d{8})$/)
        return match ? !idSet.has(match[1]!) : true
      })
    } catch {
      return []
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Builds the `prompt` argument for query().
   *
   * When the last message has images, we build a multimodal SDKUserMessage
   * generator so Claude receives proper image blocks. Earlier turns are
   * serialised as XML-tagged text (Claude Code doesn't support re-sending
   * images from prior turns in its conversation-history format).
   */
  private buildPrompt(
    history: Array<{ role: string; content: string; images?: string[] }>,
    isFixFlow?: boolean,
  ): Parameters<typeof query>[0]['prompt'] {
    const lastMessage = history[history.length - 1]!

    // Serialise prior turns as XML conversation history
    const contextLines = history.slice(0, -1).map((m) => {
      let text = m.content
      if (m.images?.length) {
        text += '\n\n' + m.images.map((_, i) => `[Image ${i + 1}: attached]`).join('\n')
      }
      return `<${m.role}>\n${text}\n</${m.role}>`
    })

    let userText = contextLines.length > 0
      ? `<conversation_history>\n${contextLines.join('\n\n')}\n</conversation_history>\n\n${lastMessage.content}`
      : lastMessage.content

    if (isFixFlow) {
      userText = rewriteForDirectEdits(userText)
    }

    // Plain text prompt — no images in current turn
    if (!lastMessage.images?.length) return userText

    // Multimodal prompt — current turn has images
    const imageBlocks = lastMessage.images.map(dataUrlToImageBlock)
    const content: Anthropic.ContentBlockParam[] = [
      { type: 'text', text: userText },
      ...imageBlocks,
    ]

    // The SDK accepts an async generator yielding SDKUserMessage
    return (async function* () {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content } as Anthropic.MessageParam,
        parent_tool_use_id: null,
      }
    })() as Parameters<typeof query>[0]['prompt']
  }

  /** Builds the `options` object for query(), switching between chat and fix modes. */
  private buildQueryOptions(
    absProjectDir: string,
    systemPrompt: string | undefined,
    mcpServers: Record<string, unknown> | undefined,
    isFixFlow: boolean | undefined,
    isDemoProject: boolean | undefined,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      settingSources: [],
      maxTurns: isFixFlow ? 1000 : 250,
      includePartialMessages: true,
      ...(this.model ? { model: this.model } : {}),
    }

    if (isFixFlow) {
      return {
        ...base,
        permissionMode: 'acceptEdits',
        settings: {
          claudeMdExcludes: ['**'],
          permissions: { allow: ['Bash(*)'] },
        },
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: buildClaudeCodeDebuggingSystemPrompt(absProjectDir, isDemoProject),
        },
      }
    }

    return {
      ...base,
      permissionMode: 'bypassPermissions',
      systemPrompt: systemPrompt ?? buildClaudeCodeDebuggingSystemPrompt(absProjectDir),
      ...(mcpServers ? { mcpServers: mcpServers as Record<string, McpServerConfig> } : {}),
    }
  }

  /**
   * After a fix-flow session, reads git status to discover files Claude edited
   * directly and returns them as FilePatch objects for the caller to commit/push.
   */
  private async collectGitPatches(absProjectDir: string): Promise<FilePatch[]> {
    try {
      const git = simpleGit(absProjectDir)
      const status = await git.status()
      const changedFiles = [...status.modified, ...status.created, ...status.not_added]
      return changedFiles.map((filePath) => ({
        filePath,
        newContent: fs.readFileSync(path.resolve(absProjectDir, filePath), 'utf-8'),
      }))
    } catch {
      return []
    }
  }

  /** Verifies an explicit model name is usable by running a minimal single-turn query. */
  private async verifyModel(model: string): Promise<void> {
    let errorMessage: string | null = null
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
        const msg = message as Record<string, unknown>
        if (msg.type === 'result' && msg.subtype !== 'success') {
          const errors = (msg.errors as string[] | undefined) ?? []
          errorMessage = errors.length > 0 ? errors.join('; ') : String(msg.subtype)
          break
        }
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    if (errorMessage) {
      throw new Error(
        `Selected model "${model}" is unavailable or failed verification:\n${errorMessage}\n\n` +
          'Pick a different model with --model.',
      )
    }
  }
}
