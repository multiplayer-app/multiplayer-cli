/**
 * Provider factory — the single place that maps a model string to a concrete LLMProvider.
 *
 * All model-classification helpers live here so there is exactly one definition
 * of "is this a Claude model?" across the entire codebase. Import from this file;
 * never duplicate the logic.
 */

import type { LLMProvider } from './types.js'
import { AnthropicProvider } from './providers/anthropic.js'
import { OpenAICompatibleProvider } from './providers/openai.js'
import { GoogleAIProvider } from './providers/google.js'

// ─── Model classification ─────────────────────────────────────────────────────

/**
 * True for all models that run through the Claude Code SDK subprocess.
 * This includes the special `claude-code` alias (uses Claude Code's default model)
 * and any explicit claude-* model names.
 */
export const isAnthropicModel = (model: string): boolean =>
  model === 'claude-code' || model.startsWith('claude')

/** True for Gemini models routed through GoogleAIProvider. */
export const isGeminiModel = (model: string): boolean => model.startsWith('gemini')

/** True for OpenAI Codex models. */
export const isCodexModel = (model: string): boolean => model.startsWith('codex')

// ─── Default base URLs ────────────────────────────────────────────────────────

/**
 * Returns the canonical base URL for OpenAI-compatible providers that need a
 * non-standard endpoint. Gemini now uses GoogleAIProvider (native SDK) so it
 * no longer needs an OpenAI-compatible base URL.
 */
export const getProviderDefaultBaseUrl = (model: string): string | undefined => {
  void model
  return undefined
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  model: string
  /** API key for the model provider. Not used by AnthropicProvider (Claude Code handles auth). */
  apiKey: string
  /** Base URL override. Falls back to getProviderDefaultBaseUrl when absent. */
  baseUrl?: string
}

/**
 * Creates the appropriate LLMProvider for the given model string.
 *
 * Routing:
 *   - claude-code, claude-*  →  AnthropicProvider (Claude Code SDK subprocess)
 *   - gemini-*               →  GoogleAIProvider  (native @google/genai SDK, supports OAuth)
 *   - codex-*, gpt-*         →  OpenAICompatibleProvider (OpenAI endpoint)
 *   - anything else          →  OpenAICompatibleProvider (custom / OpenRouter endpoint)
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  if (isAnthropicModel(config.model)) {
    return new AnthropicProvider({
      model: config.model === 'claude-code' ? undefined : config.model,
    })
  }

  if (isGeminiModel(config.model)) {
    return new GoogleAIProvider({
      model: config.model,
      apiKey: config.apiKey,
    })
  }

  const effectiveBaseUrl = config.baseUrl ?? getProviderDefaultBaseUrl(config.model)

  return new OpenAICompatibleProvider({
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: effectiveBaseUrl,
    isOpenRouter: effectiveBaseUrl?.includes('openrouter.ai') ?? false,
  })
}
