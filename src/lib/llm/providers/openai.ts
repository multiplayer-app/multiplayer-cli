/**
 * OpenAI-compatible provider — wraps the `openai` npm package.
 *
 * Works with: OpenAI (gpt-*), OpenAI Codex (codex-*), Gemini via Google's
 * OpenAI-compatible gateway, and any OpenRouter-hosted model.
 *
 * Key characteristics:
 *  - This provider owns the agentic loop (unlike AnthropicProvider, which
 *    delegates the loop to the Claude Code SDK subprocess).
 *  - Built-in tools: read_file and write_patch. write_patch is always
 *    registered so the model can suggest code changes in both chat and fix
 *    flows. Patches are only applied to disk when isFixFlow=true.
 *  - Extra tools can be injected via AgenticRequest.extraTools /
 *    AgenticRequest.extraToolHandlers for caller-controlled extensions.
 *  - Images in the last user message are sent as multipart content blocks.
 */

import OpenAI from 'openai'
import path from 'path'
import fs from 'fs'
import type {
  LLMProvider,
  CompletionRequest,
  AgenticRequest,
  AgentStreamEvent,
  FilePatch,
  ToolDefinition,
} from '../types.js'
import { MAX_FILE_SIZE, MAX_FILES_TO_READ } from '../../../config.js'
import { buildDebuggingSystemPrompt } from '../../../prompts.js'

// ─── Built-in tool definitions ────────────────────────────────────────────────

const TOOL_READ_FILE: ToolDefinition = {
  name: 'read_file',
  description: 'Read the content of a file or directory in the project.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path from the project root.' },
    },
    required: ['path'],
  },
}

const TOOL_WRITE_PATCH: ToolDefinition = {
  name: 'write_patch',
  description: 'Write the final list of file patches to fix the issue.',
  parameters: {
    type: 'object',
    properties: {
      patches: {
        type: 'array',
        description: 'List of file patches.',
        items: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            newContent: { type: 'string' },
          },
          required: ['filePath', 'newContent'],
        },
      },
    },
    required: ['patches'],
  },
}

/** Tools that require user confirmation before running. */
const CONFIRM_REQUIRED_TOOLS = new Set(['write_patch'])

/** Converts our ToolDefinition to the OpenAI SDK's ChatCompletionTool format. */
function toOpenAiTool(def: ToolDefinition): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: { name: def.name, description: def.description, parameters: def.parameters },
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Parses JSON without throwing — returns {} on failure. */
function safeParseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Reads a file or lists a directory, enforcing that the resolved path stays
 * inside the project directory. Never throws — returns an error string instead
 * so the model receives feedback and can try a different approach.
 */
function readFileSafe(projectDir: string, filePath: string): string {
  try {
    const resolved = path.resolve(projectDir, filePath)
    if (!resolved.startsWith(path.resolve(projectDir))) {
      return 'Error: Access denied — path is outside the project directory.'
    }
    if (!fs.existsSync(resolved)) {
      return `Error: File not found: ${filePath}`
    }
    const stat = fs.statSync(resolved)
    if (stat.isDirectory()) {
      return `Directory contents:\n${fs.readdirSync(resolved).slice(0, 50).join('\n')}`
    }
    const content = fs.readFileSync(resolved, 'utf-8')
    return content.length > MAX_FILE_SIZE
      ? content.slice(0, MAX_FILE_SIZE) + `\n\n[… truncated at ${MAX_FILE_SIZE} chars]`
      : content
  } catch (err) {
    return `Error reading file: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Writes file patches to disk. Throws if a path escapes the project directory. */
function applyPatches(projectDir: string, patches: FilePatch[]): void {
  for (const patch of patches) {
    const resolved = path.resolve(projectDir, patch.filePath)
    if (!resolved.startsWith(path.resolve(projectDir))) {
      throw new Error(`Security: patch path "${patch.filePath}" is outside the project directory.`)
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.writeFileSync(resolved, patch.newContent, 'utf-8')
  }
}

// ─── History serialisation ────────────────────────────────────────────────────

/**
 * Converts our provider-agnostic LLMMessage list into OpenAI chat messages.
 * The last user message may carry images as multipart content blocks.
 * Prior image turns are represented as plain text (already serialised by the caller).
 */
function buildOpenAiMessages(
  history: AgenticRequest['history'],
  systemPrompt: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ]

  for (let i = 0; i < history.length; i++) {
    const m = history[i]!
    const isLastUserTurn = m.role === 'user' && i === history.length - 1

    if (isLastUserTurn && m.images?.length) {
      const textBlock = m.content ? [{ type: 'text' as const, text: m.content }] : []
      messages.push({
        role: 'user',
        content: [
          ...textBlock,
          ...m.images.map((dataUrl) => ({
            type: 'image_url' as const,
            image_url: { url: dataUrl },
          })),
        ],
      })
    } else {
      messages.push({ role: m.role, content: m.content })
    }
  }

  return messages
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export interface OpenAICompatibleProviderOptions {
  model: string
  apiKey: string
  baseUrl?: string
  /** When true, injects OpenRouter attribution headers on every request. */
  isOpenRouter?: boolean
}

export class OpenAICompatibleProvider implements LLMProvider {
  private readonly client: OpenAI
  private readonly model: string
  private readonly opts: OpenAICompatibleProviderOptions

  constructor(opts: OpenAICompatibleProviderOptions) {
    this.opts = opts
    this.model = opts.model
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      ...(opts.isOpenRouter
        ? { defaultHeaders: { 'HTTP-Referer': 'https://multiplayer.app', 'X-Title': 'Multiplayer' } }
        : {}),
    })
  }

  // ── complete() ─────────────────────────────────────────────────────────────

  async complete(request: CompletionRequest): Promise<{ text: string }> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }
    messages.push({ role: 'user', content: request.userMessage })

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: request.maxTokens,
      messages,
    })

    return { text: response.choices[0]?.message?.content ?? '' }
  }

  // ── runAgentic() ───────────────────────────────────────────────────────────

  async *runAgentic(request: AgenticRequest): AsyncIterable<AgentStreamEvent> {
    const {
      history,
      projectDir,
      systemPrompt,
      extraTools = [],
      extraToolHandlers = {},
      confirmToolCall,
      abortSignal,
      isFixFlow,
      isDemoProject,
    } = request

    const effectiveSystemPrompt = systemPrompt ?? buildDebuggingSystemPrompt(undefined, isDemoProject)
    const allTools = [TOOL_READ_FILE, TOOL_WRITE_PATCH, ...extraTools].map(toOpenAiTool)
    const messages = buildOpenAiMessages(history, effectiveSystemPrompt)

    // Mutable session state
    let filesRead = 0
    const collectedPatches: FilePatch[] = []
    let finalText = ''

    try {
      // Agentic loop: up to 20 model turns
      for (let turn = 0; turn < 20; turn++) {
        if (abortSignal?.aborted) {
          yield { type: 'aborted' }
          return
        }

        yield { type: 'turn_start' }
        yield { type: 'progress', message: `Thinking (turn ${turn + 1})…` }

        const response = await this.client.chat.completions.create({
          model: this.model,
          messages,
          tools: allTools,
          tool_choice: 'auto',
        })

        const choice = response.choices[0]
        if (!choice) break

        if (choice.message.content) {
          finalText += choice.message.content
          yield { type: 'text_delta', text: choice.message.content }
        }

        // Push assistant message so subsequent turns have context
        messages.push(choice.message as OpenAI.Chat.ChatCompletionMessageParam)

        if (choice.finish_reason === 'stop') break
        if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls) break

        // Execute each tool the model requested
        for (const toolCall of choice.message.tool_calls) {
          if (toolCall.type !== 'function') continue

          const name = toolCall.function.name
          const input = safeParseJson(toolCall.function.arguments)

          yield { type: 'tool_call', id: toolCall.id, name, input }

          // Ask the user before running sensitive tools
          let approved = true
          let rejectionMessage: string | undefined
          if (confirmToolCall && CONFIRM_REQUIRED_TOOLS.has(name)) {
            yield { type: 'tool_confirm', id: toolCall.id, name, input }
            const confirmation = await confirmToolCall(toolCall.id, name, input)
            approved = confirmation.approved
            rejectionMessage = confirmation.userResponse
          }

          const { result, status } = approved
            ? await this.executeTool(name, input, projectDir, extraToolHandlers, filesRead, collectedPatches)
            : { result: rejectionMessage ?? 'Rejected by user.', status: 'failed' as const }

          if (approved && name === 'read_file') filesRead++

          yield { type: 'tool_result', id: toolCall.id, name, input, status, output: { content: result } }

          // Feed the result back into the conversation
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
        }

        // write_patch signals the end of the fix — no need to continue
        if (collectedPatches.length > 0) break
      }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
      return
    }

    // Apply and report patches in fix-flow mode. In chat mode patches are
    // collected but not applied (the model's suggestion is communicated via
    // tool_call / tool_result events the UI already shows to the user).
    if (isFixFlow && collectedPatches.length > 0) {
      applyPatches(projectDir, collectedPatches)
      yield { type: 'patch', patches: collectedPatches }
    }

    yield { type: 'done', finalText }
  }

  // ── validateCredentials() ──────────────────────────────────────────────────

  async validateCredentials(): Promise<void> {
    if (!this.opts.apiKey) {
      throw new Error('AI API key is required for OpenAI-compatible models.')
    }

    let modelIds: string[]
    try {
      const page = await this.client.models.list()
      modelIds = page.data.map((m) => m.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const lower = msg.toLowerCase()
      if (lower.includes('401') || lower.includes('incorrect api key') || lower.includes('invalid api key')) {
        throw new Error('Invalid AI API key — authentication failed.')
      }
      throw new Error(`AI API key validation failed: ${msg}`)
    }

    // Only gate on the model when the provider actually returns a list —
    // some OpenAI-compatible endpoints (e.g. Gemini, some OpenRouter configs)
    // return an empty list, and we shouldn't false-fail there.
    if (modelIds.length > 0 && !modelIds.includes(this.model)) {
      throw new Error(
        `Selected model "${this.model}" is not available from this provider. Pick a different model with --model.`,
      )
    }
  }

  // ── listModels() ───────────────────────────────────────────────────────────

  async listModels(): Promise<string[]> {
    try {
      const page = await this.client.models.list()
      return page.data.map((m) => m.id)
    } catch {
      return []
    }
  }

  // ── Private: tool execution ────────────────────────────────────────────────

  /**
   * Executes a single tool and returns its string result.
   *
   * Separating execution from event-emitting keeps each concern in one place:
   * the generator (runAgentic) owns all yield statements, this method owns
   * all tool-dispatch logic.
   */
  private async executeTool(
    name: string,
    input: Record<string, unknown>,
    projectDir: string,
    extraToolHandlers: Record<string, (input: Record<string, unknown>) => Promise<string>>,
    filesRead: number,
    collectedPatches: FilePatch[],
  ): Promise<{ result: string; status: 'succeeded' | 'failed' }> {
    if (name === 'read_file') {
      if (filesRead >= MAX_FILES_TO_READ) {
        return { result: 'Error: Maximum file reads reached.', status: 'failed' }
      }
      const content = readFileSafe(projectDir, (input as { path: string }).path)
      return { result: content, status: content.startsWith('Error:') ? 'failed' : 'succeeded' }
    }

    if (name === 'write_patch') {
      const patches = (input as { patches: FilePatch[] }).patches
      collectedPatches.push(...patches)
      return { result: `Patches recorded: ${patches.length} file(s).`, status: 'succeeded' }
    }

    const handler = extraToolHandlers[name]
    if (handler) {
      try {
        return { result: await handler(input), status: 'succeeded' }
      } catch (err) {
        return {
          result: `Error: ${err instanceof Error ? err.message : String(err)}`,
          status: 'failed',
        }
      }
    }

    return { result: `Unknown tool: ${name}`, status: 'failed' }
  }
}
