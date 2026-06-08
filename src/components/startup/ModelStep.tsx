/**
 * ModelStep — AI provider + model selection wizard.
 *
 * Flow:
 *   detecting → provider → (claude) fetching → model → done
 *                        → (others) api-key → fetching → model → done
 *                        → (custom)  api-key → custom-model → api-url → done
 *
 * Models are fetched live from the provider's API after the user supplies an
 * API key. Fallback static lists are used when the live fetch returns nothing.
 * A "Enter model ID manually…" entry is always available at the bottom of
 * every model list so the user can type any model that isn't listed yet.
 */

import { useState, useEffect, useCallback, type ReactElement } from 'react'
import type { KeyEvent } from '@opentui/core'
import { InputSubmitPayload, stringFromInputSubmit } from '../../lib/inputSubmit.js'
import { tuiAttrs } from '../../lib/tuiAttrs.js'
import { useKeyboard } from '@opentui/react'
import * as AiService from '../../services/ai.service.js'
import type { AgentConfig } from '../../types/index.js'
import { FooterHints, InputField, SelectionList, type SelectionItem } from '../shared/index.js'

// ─── Provider catalogue ───────────────────────────────────────────────────────

type Provider = 'claude' | 'openai' | 'codex' | 'gemini' | 'openrouter' | 'custom'

interface ProviderDef {
  id: Provider
  label: string
  description: string
  icon: string
  iconColor: string
  /** Pre-filled base URL forwarded to the OpenAI-compatible API client. */
  baseUrl?: string
  /** Hint shown inside the API key input field. */
  keyPlaceholder: string
  /**
   * Fallback model IDs used when the live /models fetch returns nothing.
   * Keeps the UI functional even when an endpoint doesn't support model listing.
   */
  fallbackModels: string[]
}

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude',
    label: 'Claude',
    description: 'Anthropic — via Claude Code CLI',
    icon: '◆',
    iconColor: '#22d3ee',
    keyPlaceholder: '',
    fallbackModels: ['claude-code', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-4o, o3, and more',
    icon: '◇',
    iconColor: '#f59e0b',
    keyPlaceholder: 'sk-...',
    fallbackModels: ['gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
  },
  {
    id: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex — code-optimised models',
    icon: '◈',
    iconColor: '#a78bfa',
    keyPlaceholder: 'sk-...',
    fallbackModels: ['codex-mini-latest'],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    description: 'Google Gemini via OpenAI-compatible gateway',
    icon: '◉',
    iconColor: '#34d399',
    baseUrl: GEMINI_BASE_URL,
    keyPlaceholder: 'AIza...',
    fallbackModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: '200+ models via one API key',
    icon: '⊕',
    iconColor: '#fb923c',
    baseUrl: OPENROUTER_BASE_URL,
    keyPlaceholder: 'sk-or-...',
    fallbackModels: [],
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    description: 'Any OpenAI-compatible endpoint',
    icon: '⚙',
    iconColor: '#6b7280',
    keyPlaceholder: 'sk-...',
    fallbackModels: [],
  },
]

// ─── Model helpers ────────────────────────────────────────────────────────────

/**
 * Filters a raw /models response down to text-generation models that are
 * actually relevant for the selected provider. Without filtering, OpenAI's
 * list would include embeddings, TTS, Whisper, DALL-E, etc.
 */
function filterModels(provider: Provider, modelIds: string[]): string[] {
  switch (provider) {
    case 'openai':
      return modelIds.filter((id) => /^(gpt-|o\d)/.test(id))
    case 'codex':
      return modelIds.filter((id) => id.includes('codex'))
    case 'gemini':
      return modelIds.filter((id) => id.startsWith('gemini'))
    case 'claude':
      return modelIds.filter((id) => id.startsWith('claude'))
    default:
      // openrouter / custom: show everything the endpoint returns
      return modelIds
  }
}

/**
 * Infers which provider a saved config belongs to, so we can avoid reusing
 * a key from one provider (e.g. Gemini) when the user switches to another (e.g. Codex).
 */
function inferCurrentProvider(config: Partial<AgentConfig>): Provider | null {
  if (!config.modelKey && !config.model) return null
  if (config.model?.startsWith('claude')) return 'claude'
  if (config.modelUrl === GEMINI_BASE_URL) return 'gemini'
  if (config.modelUrl === OPENROUTER_BASE_URL) return 'openrouter'
  if (config.model) return 'openai' // openai and codex share the same key format
  return null
}

/** Returns true if the saved config key is compatible with the target provider. */
function savedKeyFitsProvider(provider: ProviderDef, config: Partial<AgentConfig>): boolean {
  const current = inferCurrentProvider(config)
  if (!current || !config.modelKey) return false
  if (current === provider.id) return true
  // openai and codex use the same OpenAI key format — keys are interchangeable
  if ((current === 'openai' || current === 'codex') && (provider.id === 'openai' || provider.id === 'codex')) return true
  return false
}

/** Infers a short human-readable description from a model ID. */
function describeModel(id: string): string | undefined {
  if (id === 'claude-code') return 'Claude Code\'s default (recommended)'
  if (id.includes('opus')) return 'Most powerful'
  if (id.includes('sonnet')) return 'Fast, capable'
  if (id.includes('haiku')) return 'Fastest'
  if (id.includes('mini') || id.includes('flash')) return 'Fast, efficient'
  if (id.includes('pro')) return 'Powerful'
  if (/^o\d/.test(id)) return 'Reasoning model'
  return undefined
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  config: Partial<AgentConfig>
  onComplete: (updates: Partial<AgentConfig>) => void
  /** Called when the user presses ESC on the top-level provider screen. */
  onBack?: () => void
}

type SubStep =
  | 'detecting' // checking if Claude CLI is present
  | 'provider' // select a provider
  | 'api-key' // enter API key (non-Claude providers)
  | 'fetching' // spinner while fetching model list
  | 'model' // pick a model from the live-fetched list
  | 'custom-model' // type a model name manually (custom / openrouter / __custom__ choice)
  | 'api-url' // enter optional base URL (OpenAI / Codex / custom endpoint)

export function ModelStep({ config, onComplete, onBack }: Props): ReactElement | null {
  // ── Detection state ───────────────────────────────────────────────────────
  const [subStep, setSubStep] = useState<SubStep>('detecting')
  const [claudeAvailable, setClaudeAvailable] = useState(false)
  const [loginError, setLoginError] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)

  // ── Provider selection ────────────────────────────────────────────────────
  const [providerIndex, setProviderIndex] = useState(0)
  const [selectedProvider, setSelectedProvider] = useState<ProviderDef | null>(null)

  // ── Model selection ───────────────────────────────────────────────────────
  const [modelList, setModelList] = useState<string[]>([])
  const [modelIndex, setModelIndex] = useState(0)
  // The model ID that will be written to config (set in selectModel / handleCustomModelSubmit)
  const [pendingModelId, setPendingModelId] = useState<string | null>(null)

  // ── Form fields ───────────────────────────────────────────────────────────
  const [apiKey, setApiKey] = useState(config.modelKey ?? '')
  const [apiUrl, setApiUrl] = useState(config.modelUrl ?? '')
  const [customModelName, setCustomModelName] = useState('')

  // ── Gemini auth (env var only) ────────────────────────────────────────────
  const [geminiCliAuth, setGeminiCliAuth] = useState<{ source: 'env'; key: string } | null>(null)

  // ── Feedback ──────────────────────────────────────────────────────────────
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const [customModelError, setCustomModelError] = useState<string | null>(null)
  const [validating, setValidating] = useState(false)
  const [fetchStatusMsg, setFetchStatusMsg] = useState<string | null>(null)

  // ── Detect Claude CLI on mount ────────────────────────────────────────────

  const runDetection = () => {
    setSubStep('detecting')
    setDetectError(null)
    setLoginError(false)
    AiService.checkClaudeRequirements()
      .then(() => {
        setClaudeAvailable(true)
        setSubStep('provider')
      })
      .catch((err: Error) => {
        setClaudeAvailable(false)
        if (err.message.includes('not authenticated') || err.message.includes('not logged in')) {
          setLoginError(true)
        } else {
          setDetectError('Claude CLI not found — Claude models unavailable')
        }
        setSubStep('provider')
      })
  }

  useEffect(() => {
    runDetection()
  }, [])

  // ── Fetch model list from provider ────────────────────────────────────────

  /**
   * Fetches models from the provider API, filters to relevant ones, and
   * falls back to the provider's static list when the live fetch returns nothing.
   * Always appends 'claude-code' at the top for Claude.
   */
  const fetchAndShowModels = useCallback(async (provider: ProviderDef, key: string) => {
    setSubStep('fetching')
    setFetchStatusMsg(`Fetching ${provider.label} models…`)

    let ids: string[] = []
    try {
      ids =
        provider.id === 'claude'
          ? await AiService.fetchAnthropicModels(key || undefined)
          : provider.id === 'gemini'
            ? await AiService.fetchGeminiModels(key)
            : await AiService.fetchOpenAiCompatibleModels(key, provider.baseUrl)
    } catch {
      ids = []
    }

    const filtered = filterModels(provider.id, ids)
    const resolved = filtered.length > 0 ? filtered : provider.fallbackModels

    // claude-code is the provider-agnostic alias that lets Claude Code use its
    // own configured model. Always present and always first.
    const models =
      provider.id === 'claude'
        ? ['claude-code', ...resolved.filter((m) => m !== 'claude-code')]
        : resolved

    const currentIdx = config.model ? models.indexOf(config.model) : -1
    setFetchStatusMsg(null)
    setModelList(models)
    setModelIndex(currentIdx >= 0 ? currentIdx : 0)
    setSubStep('model')
  }, [])

  // ── Provider selection ────────────────────────────────────────────────────

  const selectProvider = (provider: ProviderDef) => {
    setSelectedProvider(provider)
    setApiKeyError(null)
    setPendingModelId(null)

    if (provider.id === 'claude') {
      void fetchAndShowModels(provider, config.modelKey ?? '')
      return
    }

    if (provider.id === 'custom') {
      // Custom: key first (can't validate or fetch without a base URL)
      setSubStep('api-key')
      return
    }

    if (provider.id === 'gemini') {
      // Check GEMINI_API_KEY env var before asking the user.
      const detected = AiService.detectGeminiCliAuth()
      const compatibleKey = savedKeyFitsProvider(provider, config) ? config.modelKey : undefined
      if (detected && !compatibleKey) {
        setGeminiCliAuth(detected)
        setApiKey(detected.key)
      } else if (!compatibleKey) {
        setApiKey('')
      }

      const fetchKey = compatibleKey || detected?.key || ''
      if (fetchKey) {
        void fetchAndShowModels(provider, fetchKey)
      } else {
        setModelList(provider.fallbackModels)
        setModelIndex(0)
        setSubStep('model')
      }
      return
    }

    // For OpenAI / Codex / OpenRouter: only reuse the saved key if it came from
    // the same provider family. A Gemini key is not valid for OpenAI, etc.
    const savedKey = savedKeyFitsProvider(provider, config) ? (config.modelKey ?? '') : ''
    if (!savedKey) setApiKey('') // Clear stale key from a different provider

    if (savedKey) {
      // Have a compatible saved key — fetch live models straight away
      void fetchAndShowModels(provider, savedKey)
    } else {
      // No API key yet — show fallback models so the user can browse.
      // The key is requested when they actually pick a model.
      setModelList(provider.fallbackModels)
      setModelIndex(0)
      setSubStep('model')
    }
  }

  // ── Model selection ───────────────────────────────────────────────────────

  const selectModel = (modelId: string) => {
    if (modelId === '__custom__') {
      setCustomModelName('')
      setCustomModelError(null)
      setSubStep('custom-model')
      return
    }

    const provider = selectedProvider!
    // Don't fall back to config.modelKey if it belongs to a different provider.
    const effectiveKey = apiKey || (savedKeyFitsProvider(provider, config) ? config.modelKey ?? '' : '')
    setPendingModelId(modelId)

    if (provider.id === 'claude') {
      onComplete({ model: modelId, modelKey: '', modelUrl: undefined })
      return
    }

    // No API key yet — collect it
    if (!effectiveKey) {
      setSubStep('api-key')
      return
    }

    if (provider.id === 'gemini') {
      onComplete({ model: modelId, modelKey: effectiveKey, modelUrl: provider.baseUrl })
      return
    }
    if (provider.id === 'openrouter') {
      onComplete({ model: modelId, modelKey: effectiveKey, modelUrl: provider.baseUrl })
      return
    }

    // OpenAI / Codex: offer an optional custom base URL
    setSubStep('api-url')
  }

  // ── Form handlers ─────────────────────────────────────────────────────────

  const handleApiKeySubmit = (input: string) => {
    const trimmed = input.trim()
    if (!trimmed) {
      setApiKeyError('API key is required')
      return
    }

    const provider = selectedProvider!

    if (provider.id === 'custom') {
      // We can't validate without the base URL — just store the key and continue
      setApiKey(trimmed)
      setSubStep('custom-model')
      return
    }

    setValidating(true)
    setApiKeyError(null)
    AiService.checkOpenAiRequirements(trimmed, provider.baseUrl)
      .then(() => {
        setValidating(false)
        setApiKey(trimmed)

        if (pendingModelId) {
          // User already selected a model from the fallback list — complete now
          if (provider.id === 'gemini') {
            onComplete({ model: pendingModelId, modelKey: trimmed, modelUrl: provider.baseUrl })
          } else if (provider.id === 'openrouter') {
            onComplete({ model: pendingModelId, modelKey: trimmed, modelUrl: provider.baseUrl })
          } else {
            // OpenAI / Codex still need a URL confirmation step
            setSubStep('api-url')
          }
        } else {
          // No model selected yet — fetch live models and show the list
          void fetchAndShowModels(provider, trimmed)
        }
      })
      .catch((err: Error) => {
        setValidating(false)
        setApiKeyError(err.message)
      })
  }

  const handleCustomModelSubmit = (input: string) => {
    const trimmed = input.trim()
    if (!trimmed) {
      setCustomModelError('Model name is required')
      return
    }
    setCustomModelError(null)
    setCustomModelName(trimmed)
    setPendingModelId(trimmed)

    const provider = selectedProvider!
    const effectiveKey = apiKey || (savedKeyFitsProvider(provider, config) ? config.modelKey ?? '' : '')

    // No key yet — collect it
    if (!effectiveKey && provider.id !== 'custom') {
      setSubStep('api-key')
      return
    }

    if (provider.id === 'openrouter') {
      onComplete({ model: trimmed, modelKey: effectiveKey, modelUrl: OPENROUTER_BASE_URL })
      return
    }
    if (provider.id === 'gemini') {
      onComplete({ model: trimmed, modelKey: effectiveKey, modelUrl: GEMINI_BASE_URL })
      return
    }

    // OpenAI / Codex / Custom: ask for an optional (or required) base URL
    setSubStep('api-url')
  }

  const handleApiUrlSubmit = (input: string) => {
    const trimmed = input.trim()
    const provider = selectedProvider!
    const effectiveKey = apiKey || (savedKeyFitsProvider(provider, config) ? config.modelKey ?? '' : '')
    const modelId = pendingModelId ?? ''
    onComplete({ model: modelId, modelKey: effectiveKey, modelUrl: trimmed || provider.baseUrl })
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  useKeyboard((key: KeyEvent) => {
    const { name } = key

    if (subStep === 'provider') {
      if (name === 'up') {
        setProviderIndex((i) => Math.max(0, i - 1))
      } else if (name === 'down') {
        setProviderIndex((i) => Math.min(PROVIDERS.length - 1, i + 1))
      } else if (name === 'return') {
        const p = PROVIDERS[providerIndex]
        if (p) selectProvider(p)
      } else if (name === 'escape') {
        key.stopPropagation()
        onBack?.()
      } else if ((name === 'r' || name === 'R') && loginError) {
        runDetection()
        key.stopPropagation()
      }
      return
    }

    if (subStep === 'model') {
      // modelList contains the fetched IDs; __custom__ is appended at render time
      const total = modelList.length + 1
      if (name === 'up') {
        setModelIndex((i) => Math.max(0, i - 1))
      } else if (name === 'down') {
        setModelIndex((i) => Math.min(total - 1, i + 1))
      } else if (name === 'return') {
        const id = modelIndex < modelList.length ? modelList[modelIndex]! : '__custom__'
        selectModel(id)
      } else if (name === 'escape') {
        setSubStep('provider')
        key.stopPropagation()
      }
      return
    }

    // All other sub-steps: ESC goes back one level
    if (name === 'escape') {
      if (subStep === 'api-key') setSubStep('provider')
      else if (subStep === 'custom-model') setSubStep(modelList.length > 0 ? 'model' : 'api-key')
      else if (subStep === 'api-url') setSubStep(pendingModelId && modelList.includes(pendingModelId) ? 'model' : 'custom-model')
      setApiKeyError(null)
      setCustomModelError(null)
      key.stopPropagation()
    }
  })

  // ── Render ────────────────────────────────────────────────────────────────

  if (subStep === 'detecting') {
    return (
      <box flexDirection='column' gap={1}>
        <text fg='#f59e0b'>◌ Detecting available providers…</text>
      </box>
    ) as ReactElement
  }

  if (subStep === 'fetching') {
    return (
      <box flexDirection='column' gap={1}>
        <text fg='#f59e0b'>◌ {fetchStatusMsg ?? 'Fetching models…'}</text>
      </box>
    ) as ReactElement
  }

  if (subStep === 'provider') {
    const providerItems: SelectionItem[] = PROVIDERS.map((p) => {
      let description = p.description
      if (p.id === 'claude') {
        if (loginError) description = 'Not logged in — run "claude /login" then press R'
        else if (!claudeAvailable) description = detectError ?? 'Claude CLI not found'
      }
      return {
        key: p.id,
        icon: p.icon,
        iconColor: p.id === 'claude' && !claudeAvailable ? '#6b7280' : p.iconColor,
        label: p.label,
        description,
      }
    })

    return (
      <box flexDirection='column' flexGrow={1} flexShrink={1} overflow={'hidden' as const}>
        {claudeAvailable && (
          <text fg='#10b981' flexShrink={0}> ✓ Claude CLI detected</text>
        )}
        {loginError && (
          <box flexDirection='column' marginLeft={1} gap={0} flexShrink={0}>
            <text fg='#f59e0b' flexShrink={0}>Claude Code is not logged in</text>
            <box flexDirection='row' flexWrap='wrap' flexShrink={0}>
              <text attributes={tuiAttrs({ dim: true })} flexShrink={0}>Run </text>
              <text fg='#22d3ee' flexShrink={0}>claude /login</text>
              <text attributes={tuiAttrs({ dim: true })} flexShrink={0}> in another terminal, then press R to retry.</text>
            </box>
          </box>
        )}
        <text attributes={tuiAttrs({ dim: true })} marginLeft={1} flexShrink={0}>
          Select a provider — models are fetched live so new ones appear automatically.
        </text>
        <box marginTop={1} flexGrow={1} flexShrink={1} overflow={'hidden' as const}>
          <SelectionList
            items={providerItems}
            selectedIndex={providerIndex}
            onSelect={(i) => {
              const p = PROVIDERS[i]
              if (p) selectProvider(p)
            }}
            flexGrow={1}
          />
        </box>
        <FooterHints
          hints={loginError
            ? '↑↓ navigate · Enter select · R retry login · Esc back'
            : '↑↓ navigate · Enter select · Click to select · Esc back'}
          paddingLeft={1}
          marginTop={1}
        />
      </box>
    ) as ReactElement
  }

  if (subStep === 'api-key') {
    const provider = selectedProvider!
    return (
      <box flexDirection='column' gap={1}>
        <text attributes={tuiAttrs({ dim: true })}>
          Enter your <span fg={provider.iconColor}>{provider.label}</span> API key:
        </text>
        {provider.id === 'gemini' && (
          <text attributes={tuiAttrs({ dim: true })}>
            Get one at <span fg='#34d399'>https://aistudio.google.com/apikey</span>
          </text>
        )}
        {apiKeyError && <text fg='#ef4444'>✗ {apiKeyError}</text>}
        {validating ? (
          <text fg='#f59e0b'>◌ Validating key…</text>
        ) : (
          <InputField
            value={apiKey}
            onInput={setApiKey}
            onSubmit={(p: InputSubmitPayload) => handleApiKeySubmit(stringFromInputSubmit(p, apiKey))}
            placeholder={provider.keyPlaceholder || 'sk-...'}
            width={50}
          />
        )}
        <FooterHints hints='Enter confirm · Esc back' />
      </box>
    ) as ReactElement
  }

  if (subStep === 'model') {
    const provider = selectedProvider!
    const hasKey = !!(apiKey || (savedKeyFitsProvider(provider, config) ? config.modelKey : null))
    // __custom__ is always the last entry — lets users type any model not in the list
    const modelItems: SelectionItem[] = [
      ...modelList.map((id) => ({
        key: id,
        icon: provider.icon,
        iconColor: provider.iconColor,
        label: id,
        description: describeModel(id),
      })),
      {
        key: '__custom__',
        icon: '⚙',
        iconColor: '#6b7280',
        label: 'Enter model ID manually…',
        description: 'Type any model identifier not shown above',
      },
    ]

    return (
      <box flexDirection='column' flexGrow={1} flexShrink={1} overflow={'hidden' as const}>
        <text attributes={tuiAttrs({ dim: true })} marginLeft={1} flexShrink={0}>
          <span fg={provider.iconColor}>{provider.icon} {provider.label}</span> — select a model:
        </text>
        {provider.id === 'gemini' && geminiCliAuth?.source === 'env' && (
          <text fg='#10b981' marginLeft={1} flexShrink={0}>
            ✓ GEMINI_API_KEY detected
          </text>
        )}
        {!hasKey && !(provider.id === 'gemini' && geminiCliAuth) && (
          <text fg='#f59e0b' marginLeft={1} flexShrink={0}>
            ◌ Showing defaults — API key requested on selection
          </text>
        )}
        <box marginTop={1} flexGrow={1} flexShrink={1} overflow={'hidden' as const}>
          <SelectionList
            items={modelItems}
            selectedIndex={modelIndex}
            onSelect={(i) => {
              const id = i < modelList.length ? modelList[i]! : '__custom__'
              selectModel(id)
            }}
            flexGrow={1}
          />
        </box>
        <FooterHints hints='↑↓ navigate · Enter select · Click to select · Esc back' paddingLeft={1} marginTop={1} />
      </box>
    ) as ReactElement
  }

  if (subStep === 'custom-model') {
    const provider = selectedProvider!
    const isOpenRouter = provider.id === 'openrouter'
    return (
      <box flexDirection='column' gap={1}>
        <text attributes={tuiAttrs({ dim: true })}>
          {isOpenRouter
            ? 'Enter the OpenRouter model ID (e.g. anthropic/claude-opus-4, openai/gpt-4o):'
            : 'Enter the model identifier exposed by your provider:'}
        </text>
        {customModelError && <text fg='#ef4444'>✗ {customModelError}</text>}
        <InputField
          value={customModelName}
          onInput={setCustomModelName}
          onSubmit={(p: InputSubmitPayload) => handleCustomModelSubmit(stringFromInputSubmit(p, customModelName))}
          placeholder={isOpenRouter ? 'anthropic/claude-opus-4' : 'model-id'}
          width={55}
        />
        <FooterHints hints='Enter continue · Esc back' />
      </box>
    ) as ReactElement
  }

  if (subStep === 'api-url') {
    const provider = selectedProvider!
    const isCustom = provider.id === 'custom'
    return (
      <box flexDirection='column' gap={1}>
        <text attributes={tuiAttrs({ bold: true })}>
          {isCustom ? 'API Base URL' : 'API Base URL (optional)'}
        </text>
        <text attributes={tuiAttrs({ dim: true })}>
          {isCustom
            ? 'Base URL of your OpenAI-compatible API (e.g. https://api.example.com/v1).'
            : 'Leave empty to use the default OpenAI endpoint.'}
        </text>
        <InputField
          value={apiUrl}
          onInput={setApiUrl}
          onSubmit={(p: InputSubmitPayload) => handleApiUrlSubmit(stringFromInputSubmit(p, apiUrl))}
          placeholder={isCustom ? 'https://api.example.com/v1' : 'leave empty for default'}
          width={55}
        />
        <FooterHints hints='Enter continue · Esc back' />
      </box>
    ) as ReactElement
  }

  return null
}
