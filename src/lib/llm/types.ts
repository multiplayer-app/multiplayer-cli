/**
 * Provider-agnostic types for the LLM abstraction layer.
 *
 * Rules for this file:
 *  - No imports from provider SDKs (OpenAI, Anthropic). This file must be
 *    importable by any part of the codebase without pulling in those packages.
 *  - All provider-specific details are handled inside the provider classes and
 *    never leak into these shared types.
 */

// ─── File patches ─────────────────────────────────────────────────────────────

/** A full-file replacement produced by the AI after fixing an issue. */
export interface FilePatch {
  filePath: string
  newContent: string
}

// ─── Conversation history ─────────────────────────────────────────────────────

/** A single turn in a conversation, provider-agnostic. */
export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
  /**
   * Base64 data URLs (e.g. `data:image/png;base64,...`) for the current turn.
   * Only the last user message may carry images — prior images in history are
   * serialised as `[Image N: attached]` text placeholders inside each provider.
   */
  images?: string[]
}

// ─── Streaming events ─────────────────────────────────────────────────────────

/**
 * Events emitted by `LLMProvider.runAgentic()` during a session.
 *
 * Callers `for await` over these and react only to the types they care about.
 * Unknown types should be silently ignored so new event types can be added
 * without breaking existing consumers.
 *
 * Event flow for a typical turn:
 *   turn_start → text_delta* → tool_call → tool_result → turn_start → …
 *
 * Session ends with exactly one of: done | aborted | error.
 */
export type AgentStreamEvent =
  | {
      /** The model has started a new inference turn. */
      type: 'turn_start'
    }
  | {
      /** A chunk of assistant text (may be called many times per turn). */
      type: 'text_delta'
      text: string
    }
  | {
      /** The model has decided to call a tool. Emitted before execution. */
      type: 'tool_call'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | {
      /**
       * A tool call that requires user approval before running.
       * The provider pauses execution until the `confirmToolCall` callback resolves.
       */
      type: 'tool_confirm'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | {
      /** The tool has finished. Emitted after the result is fed back to the model. */
      type: 'tool_result'
      id: string
      name: string
      input: Record<string, unknown>
      status: 'succeeded' | 'failed'
      output: Record<string, unknown>
    }
  | {
      /**
       * File patches collected during the session (issue-fix flow only).
       * Emitted once, just before `done`, when the provider has determined the
       * final set of file changes. May be omitted if no patches were produced.
       */
      type: 'patch'
      patches: FilePatch[]
    }
  | {
      /** A human-readable progress message (e.g. "[read] src/foo.ts"). */
      type: 'progress'
      message: string
    }
  | {
      /** The session completed successfully. */
      type: 'done'
      /** Full assistant response text accumulated across all turns. */
      finalText: string
    }
  | {
      /** The session was cancelled via AbortSignal. */
      type: 'aborted'
    }
  | {
      /** An unrecoverable error occurred. The generator terminates after this. */
      type: 'error'
      error: Error
    }

// ─── Tool definitions ─────────────────────────────────────────────────────────

/** A tool the model may call, in a provider-agnostic format. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<
      string,
      {
        type: string
        description?: string
        items?: {
          type: string
          properties?: Record<string, unknown>
          required?: string[]
        }
      }
    >
    required?: string[]
  }
}

// ─── Tool confirmation ────────────────────────────────────────────────────────

/**
 * Called by the provider before executing a tool that requires user approval.
 *
 * Return `{ approved: true }` to proceed.
 * Return `{ approved: false, userResponse }` to reject — the rejection message
 * is fed back to the model so it can adjust its approach.
 */
export type ConfirmToolCallFn = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ approved: boolean; userResponse?: string }>

// ─── MCP servers ─────────────────────────────────────────────────────────────

/**
 * MCP server configuration map passed to the Anthropic provider.
 * Typed as `Record<string, unknown>` here to avoid importing the Anthropic SDK
 * into shared types. The Anthropic provider casts to `McpServerConfig` internally.
 *
 * Ignored by the OpenAI-compatible provider.
 */
export type McpServerMap = Record<string, unknown>

// ─── Request shapes ───────────────────────────────────────────────────────────

/** Request for a one-shot completion with no tool use and no streaming. */
export interface CompletionRequest {
  systemPrompt?: string
  userMessage: string
  maxTokens?: number
}

/** Request for a multi-turn agentic session. */
export interface AgenticRequest {
  /** Full conversation history. The last entry is the current user turn. */
  history: LLMMessage[]

  /** Absolute path to the project directory (used for file reads and git). */
  projectDir: string

  /**
   * System prompt appended to the provider's own default.
   * For the Anthropic provider: merged into `systemPrompt.append`.
   * For the OpenAI provider: sent as a `system` message.
   */
  systemPrompt?: string

  /**
   * Additional tool definitions beyond the provider's built-in tools.
   * Ignored by AnthropicProvider (Claude Code owns its tool set).
   * Used by OpenAICompatibleProvider alongside its built-in read_file / write_patch.
   */
  extraTools?: ToolDefinition[]

  /**
   * Handlers for `extraTools`, keyed by tool name.
   * Called by OpenAICompatibleProvider when the model invokes an extra tool.
   * Should throw on failure — the error message is fed back to the model.
   */
  extraToolHandlers?: Record<string, (input: Record<string, unknown>) => Promise<string>>

  /**
   * Called before executing a tool that requires user approval (write_patch).
   * When absent, write_patch runs without confirmation.
   */
  confirmToolCall?: ConfirmToolCallFn

  /**
   * MCP servers to expose to the Anthropic provider.
   * Ignored by OpenAICompatibleProvider.
   */
  mcpServers?: McpServerMap

  /** Cancellation signal. The provider checks this between loop iterations. */
  abortSignal?: AbortSignal

  /**
   * When true, the session is a fix/resolve flow (not a chat):
   *
   * AnthropicProvider:
   *   - Uses `permissionMode: 'acceptEdits'` so Claude can edit files directly.
   *   - Enables `claudeMdExcludes` and `permissions.allow: ['Bash(*)']`.
   *   - Rewrites patch-instruction language in the prompt to direct-edit language.
   *   - After the session, reads git status to collect changed files as patches.
   *
   * OpenAICompatibleProvider:
   *   - Enables `write_patch` tool and collects patches via tool results.
   *   - Applies patches to disk before emitting the `patch` event.
   */
  isFixFlow?: boolean

  /** Passed to system-prompt builders that vary by demo vs. real project. */
  isDemoProject?: boolean
}

// ─── Provider interface ───────────────────────────────────────────────────────

/**
 * Common interface implemented by all LLM providers.
 *
 * Two implementations exist:
 *  - AnthropicProvider  — wraps @anthropic-ai/claude-agent-sdk
 *  - OpenAICompatibleProvider — wraps the openai package (OpenAI, Codex, Gemini, OpenRouter)
 *
 * Consumers in ai.service.ts call these methods; they never reference a
 * concrete provider class directly.
 */
export interface LLMProvider {
  /**
   * Single-turn completion with no tool use and no streaming.
   * Used for: generateChatTitle, analyseIssueContext, generatePrContent.
   */
  complete(request: CompletionRequest): Promise<{ text: string }>

  /**
   * Multi-turn agentic session with tool use and streaming.
   *
   * Returns an async iterable of AgentStreamEvent. The session ends when the
   * generator returns (after emitting `done`, `aborted`, or `error`).
   *
   * Callers should be structured as:
   *   for await (const event of provider.runAgentic(request)) {
   *     switch (event.type) { … }
   *   }
   */
  runAgentic(request: AgenticRequest): AsyncIterable<AgentStreamEvent>

  /**
   * Validates that the provider's credentials are accepted and the model exists.
   * Throws a user-friendly Error on failure (same format as classifyAiError output).
   */
  validateCredentials(): Promise<void>

  /**
   * Lists models available from this provider.
   * Returns [] when the endpoint does not support model listing.
   */
  listModels(): Promise<string[]>
}
