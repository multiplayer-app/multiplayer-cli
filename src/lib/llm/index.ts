/**
 * LLM abstraction layer — public API.
 *
 * Usage:
 *   import { createProvider } from '../lib/llm/index.js'
 *   const provider = createProvider({ model, apiKey, baseUrl })
 *
 *   // Simple one-shot completion
 *   const { text } = await provider.complete({ userMessage: '…' })
 *
 *   // Streaming agentic session
 *   for await (const event of provider.runAgentic({ history, projectDir, … })) {
 *     switch (event.type) {
 *       case 'text_delta': …
 *       case 'tool_call':  …
 *       case 'patch':      …
 *       case 'done':       …
 *     }
 *   }
 */

// Types
export type {
  LLMProvider,
  AgentStreamEvent,
  LLMMessage,
  FilePatch,
  CompletionRequest,
  AgenticRequest,
  ToolDefinition,
  McpServerMap,
  ConfirmToolCallFn,
} from './types.js'

// Factory
export {
  createProvider,
  isAnthropicModel,
  isGeminiModel,
  isCodexModel,
  getProviderDefaultBaseUrl,
} from './factory.js'
export type { ProviderConfig } from './factory.js'

// Concrete providers (exported for testing and edge-case instantiation)
export { AnthropicProvider } from './providers/anthropic.js'
export type { AnthropicProviderOptions } from './providers/anthropic.js'
export { OpenAICompatibleProvider } from './providers/openai.js'
export type { OpenAICompatibleProviderOptions } from './providers/openai.js'
