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

// ─── Model classification ─────────────────────────────────────────────────────

/**
 * True for all models that run through the Claude Code SDK subprocess.
 * This includes the special `claude-code` alias (uses Claude Code's default model)
 * and any explicit claude-* model names.
 */
export const isAnthropicModel = (model: string): boolean =>
  model === 'claude-code' || model.startsWith('claude')

/** True for Gemini models that use Google's OpenAI-compatible gateway. */
export const isGeminiModel = (model: string): boolean => model.startsWith('gemini')

/** True for OpenAI Codex models. */
export const isCodexModel = (model: string): boolean => model.startsWith('codex')

// ─── Default base URLs ────────────────────────────────────────────────────────

/**
 * Returns the canonical base URL for a provider that requires a non-standard endpoint,
 * when no explicit `modelUrl` has been configured.
 *
 * Currently only Gemini needs this — it uses Google's OpenAI-compatible gateway.
 * OpenAI and Codex use the standard OpenAI endpoint by default.
 * OpenRouter users configure their URL explicitly via `modelUrl`.
 */
export const getProviderDefaultBaseUrl = (model: string): string | undefined => {
  if (isGeminiModel(model)) return 'https://generativelanguage.googleapis.com/v1beta/openai/'
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
 *   - gemini-*               →  OpenAICompatibleProvider (Google's OpenAI gateway)
 *   - codex-*, gpt-*         →  OpenAICompatibleProvider (OpenAI endpoint)
 *   - anything else          →  OpenAICompatibleProvider (custom / OpenRouter endpoint)
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  if (isAnthropicModel(config.model)) {
    return new AnthropicProvider({
      // 'claude-code' means "let Claude Code pick the model" — pass undefined.
      model: config.model === 'claude-code' ? undefined : config.model,
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
