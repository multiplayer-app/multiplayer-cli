/**
 * Google AI provider — wraps @google/genai.
 * Authenticates via API key only (set GEMINI_API_KEY or pass explicitly).
 * Manages the agentic loop with Gemini's native function calling, similarly to
 * OpenAICompatibleProvider. Built-in tools: read_file and write_patch.
 */

import { GoogleGenAI } from '@google/genai/node'
import type { Content, FunctionCall, Part } from '@google/genai/node'
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

// ─── History serialisation ────────────────────────────────────────────────────

function buildGeminiContents(
  history: AgenticRequest['history'],
): Content[] {
  const contents: Content[] = []

  for (let i = 0; i < history.length; i++) {
    const msg = history[i]!
    const role = msg.role === 'assistant' ? 'model' : 'user'
    const isLastUser = msg.role === 'user' && i === history.length - 1

    if (isLastUser && msg.images?.length) {
      const parts: Part[] = msg.content ? [{ text: msg.content }] : []
      for (const dataUrl of msg.images) {
        const commaIdx = dataUrl.indexOf(',')
        const meta = dataUrl.slice(0, commaIdx)
        const data = dataUrl.slice(commaIdx + 1)
        const mimeType = meta.replace('data:', '').replace(';base64', '')
        parts.push({ inlineData: { mimeType, data } })
      }
      contents.push({ role, parts })
    } else {
      let text = msg.content
      // Serialize prior-turn images as text placeholders
      if (msg.images?.length && i < history.length - 1) {
        text += '\n\n' + msg.images.map((_, n) => `[Image ${n + 1}: attached]`).join('\n')
      }
      contents.push({ role, parts: [{ text }] })
    }
  }

  return contents
}

// ─── File utilities (same as OpenAI provider) ─────────────────────────────────

function readFileSafe(projectDir: string, filePath: string): string {
  try {
    const resolved = path.resolve(projectDir, filePath)
    if (!resolved.startsWith(path.resolve(projectDir))) {
      return 'Error: Access denied — path is outside the project directory.'
    }
    if (!fs.existsSync(resolved)) return `Error: File not found: ${filePath}`
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

// ─── Provider ─────────────────────────────────────────────────────────────────

export interface GoogleAIProviderOptions {
  model: string
  apiKey: string
}

export class GoogleAIProvider implements LLMProvider {
  private readonly model: string
  private readonly genai: GoogleGenAI

  constructor(opts: GoogleAIProviderOptions) {
    this.model = opts.model
    const apiKey = opts.apiKey || process.env.GEMINI_API_KEY || ''
    if (!apiKey) {
      throw new Error(
        'No Gemini API key found. Set GEMINI_API_KEY — get one at https://aistudio.google.com/apikey',
      )
    }
    this.genai = new GoogleGenAI({ apiKey })
  }

  // ── complete() ─────────────────────────────────────────────────────────────

  async complete(request: CompletionRequest): Promise<{ text: string }> {
    const response = await this.genai.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: request.userMessage }] }],
      config: {
        ...(request.systemPrompt ? { systemInstruction: request.systemPrompt } : {}),
        ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
      },
    })
    return { text: response.text ?? '' }
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
    const allTools = [TOOL_READ_FILE, TOOL_WRITE_PATCH, ...extraTools]
    const toolDeclarations = allTools.map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.parameters,
    }))

    const contents = buildGeminiContents(history)
    const collectedPatches: FilePatch[] = []
    let filesRead = 0
    let finalText = ''

    try {
      for (let turn = 0; turn < 20; turn++) {
        if (abortSignal?.aborted) {
          yield { type: 'aborted' }
          return
        }

        yield { type: 'turn_start' }

        const stream = await this.genai.models.generateContentStream({
          model: this.model,
          contents,
          config: {
            systemInstruction: effectiveSystemPrompt,
            tools: [{ functionDeclarations: toolDeclarations }],
          },
        })

        // Collect streamed text and function calls
        const functionCalls: FunctionCall[] = []
        let turnText = ''

        for await (const chunk of stream) {
          if (abortSignal?.aborted) {
            yield { type: 'aborted' }
            return
          }

          const text = chunk.text ?? ''
          if (text) {
            finalText += text
            turnText += text
            yield { type: 'text_delta', text }
          }

          for (const fc of chunk.functionCalls ?? []) {
            functionCalls.push(fc)
          }
        }

        // Append model turn to history
        const modelParts: Part[] = []
        if (turnText) modelParts.push({ text: turnText })
        for (const fc of functionCalls) {
          modelParts.push({ functionCall: fc })
        }
        if (modelParts.length > 0) {
          contents.push({ role: 'model', parts: modelParts })
        }

        if (functionCalls.length === 0) break

        // Execute each tool call
        const responseParts: Part[] = []

        for (const fc of functionCalls) {
          const toolId = fc.id ?? fc.name ?? 'unknown'
          const name = fc.name ?? 'unknown'
          const input = (fc.args ?? {}) as Record<string, unknown>

          // Confirmation for write_patch
          let approved = true
          let rejectionMessage: string | undefined
          if (confirmToolCall && name === 'write_patch') {
            yield { type: 'tool_confirm', id: toolId, name, input }
            const result = await confirmToolCall(toolId, name, input)
            approved = result.approved
            rejectionMessage = result.userResponse
          }

          yield { type: 'tool_call', id: toolId, name, input }

          let output: string
          let status: 'succeeded' | 'failed'

          if (!approved) {
            output = rejectionMessage ?? 'Rejected by user.'
            status = 'failed'
          } else if (name === 'read_file') {
            if (filesRead >= MAX_FILES_TO_READ) {
              output = 'Error: Maximum file reads reached.'
              status = 'failed'
            } else {
              output = readFileSafe(projectDir, (input as { path: string }).path)
              status = output.startsWith('Error:') ? 'failed' : 'succeeded'
              if (status === 'succeeded') filesRead++
            }
          } else if (name === 'write_patch') {
            const patches = (input as { patches: FilePatch[] }).patches
            collectedPatches.push(...patches)
            output = `Patches recorded: ${patches.length} file(s).`
            status = 'succeeded'
          } else {
            const handler = extraToolHandlers[name]
            if (handler) {
              try {
                output = await handler(input)
                status = 'succeeded'
              } catch (err) {
                output = `Error: ${err instanceof Error ? err.message : String(err)}`
                status = 'failed'
              }
            } else {
              output = `Unknown tool: ${name}`
              status = 'failed'
            }
          }

          yield { type: 'tool_result', id: toolId, name, input, status, output: { content: output } }

          responseParts.push({
            functionResponse: {
              id: fc.id,
              name,
              response: { output },
            },
          })
        }

        // Feed tool results back as a user turn
        contents.push({ role: 'user', parts: responseParts })

        if (collectedPatches.length > 0) break
      }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
      return
    }

    if (isFixFlow && collectedPatches.length > 0) {
      applyPatches(projectDir, collectedPatches)
      yield { type: 'patch', patches: collectedPatches }
    }

    yield { type: 'done', finalText }
  }

  // ── validateCredentials() ──────────────────────────────────────────────────

  async validateCredentials(): Promise<void> {
    try {
      await this.genai.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: { maxOutputTokens: 1 },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const lower = msg.toLowerCase()
      if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
        // Rate-limited means the key is valid — authentication succeeded.
        return
      }
      if (lower.includes('access_token_scope_insufficient') || lower.includes('scope_insufficient')) {
        throw new Error(
          `Gemini CLI OAuth credentials are missing the required scope for the Gemini API.\n` +
          `Set a GEMINI_API_KEY instead: https://aistudio.google.com/apikey`,
        )
      }
      if (lower.includes('api_key_invalid') || lower.includes('401') || lower.includes('permission denied') || lower.includes('403')) {
        throw new Error(`Gemini authentication failed — check your GEMINI_API_KEY or set one at https://aistudio.google.com/apikey\n${msg}`)
      }
      if (lower.includes('not found') || lower.includes('404')) {
        throw new Error(`Gemini model "${this.model}" not found. Pick a different model.\n${msg}`)
      }
      throw new Error(`Gemini validation failed: ${msg}`)
    }
  }

  // ── listModels() ───────────────────────────────────────────────────────────

  async listModels(): Promise<string[]> {
    try {
      const ids: string[] = []
      for await (const m of await this.genai.models.list()) {
        const name = (m as { name?: string }).name
        if (name) ids.push(name.replace(/^models\//, ''))
      }
      return ids.filter((id) => id.startsWith('gemini'))
    } catch {
      return []
    }
  }
}
