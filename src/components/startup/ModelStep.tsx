import { useState, useEffect, type ReactElement } from 'react'
import type { KeyEvent } from '@opentui/core'
import { InputSubmitPayload, stringFromInputSubmit } from '../../lib/inputSubmit.js'
import { tuiAttrs } from '../../lib/tuiAttrs.js'
import { useKeyboard } from '@opentui/react'
import * as AiService from '../../services/ai.service.js'
import type { AgentConfig } from '../../types/index.js'
import { FooterHints, InputField, SelectionList, type SelectionItem } from '../shared/index.js'

// ─── Provider types ───────────────────────────────────────────────────────────

type Provider = 'claude' | 'openai' | 'codex' | 'gemini' | 'openrouter'

interface ModelOption {
  label: string
  value: string
  provider: Provider
  description?: string
  /** Pre-filled base URL (auto-applied; not shown to user unless custom). */
  defaultBaseUrl?: string
}

// ─── Model lists per provider ─────────────────────────────────────────────────

const CLAUDE_MODELS: ModelOption[] = [
  { label: 'claude-opus-4-7', value: 'claude-opus-4-7', provider: 'claude', description: 'Most powerful' },
  { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6', provider: 'claude', description: 'Fast, capable' },
  { label: 'claude-opus-4-6', value: 'claude-opus-4-6', provider: 'claude', description: 'Fast, powerful' },
  { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5-20251001', provider: 'claude', description: 'Fastest' },
]

const CODEX_MODELS: ModelOption[] = [
  { label: 'codex-mini-latest', value: 'codex-mini-latest', provider: 'codex', description: 'Coding-optimised, fast' },
]

const OPENAI_MODELS: ModelOption[] = [
  { label: 'gpt-4o', value: 'gpt-4o', provider: 'openai' },
  { label: 'gpt-4o-mini', value: 'gpt-4o-mini', provider: 'openai', description: 'Faster, cheaper' },
]

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'

const GEMINI_MODELS: ModelOption[] = [
  { label: 'gemini-2.5-pro', value: 'gemini-2.5-pro', provider: 'gemini', description: 'Most powerful', defaultBaseUrl: GEMINI_BASE_URL },
  { label: 'gemini-2.5-flash', value: 'gemini-2.5-flash', provider: 'gemini', description: 'Fast, capable', defaultBaseUrl: GEMINI_BASE_URL },
  { label: 'gemini-2.0-flash', value: 'gemini-2.0-flash', provider: 'gemini', description: 'Fastest', defaultBaseUrl: GEMINI_BASE_URL },
]

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

const OPENROUTER_ENTRY: ModelOption = {
  label: 'Custom via OpenRouter...',
  value: '__openrouter__',
  provider: 'openrouter',
  description: '200+ models',
  defaultBaseUrl: OPENROUTER_BASE_URL,
}

// ─── Provider meta ────────────────────────────────────────────────────────────

const PROVIDER_ICON: Record<Provider, string> = {
  claude: '◆',
  openai: '◇',
  codex: '◈',
  gemini: '◉',
  openrouter: '⊕',
}

const PROVIDER_COLOR: Record<Provider, string> = {
  claude: '#22d3ee',
  openai: '#f59e0b',
  codex: '#a78bfa',
  gemini: '#34d399',
  openrouter: '#fb923c',
}

const API_KEY_PLACEHOLDER: Record<Provider, string> = {
  claude: '',
  openai: 'sk-...',
  codex: 'sk-...',
  gemini: 'AIza...',
  openrouter: 'sk-or-...',
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  config: Partial<AgentConfig>
  onComplete: (updates: Partial<AgentConfig>) => void
}

type SubStep = 'detecting' | 'select' | 'api-key' | 'custom-model' | 'api-url'

export function ModelStep({ config, onComplete }: Props): ReactElement | null {
  const [subStep, setSubStep] = useState<SubStep>('detecting')
  const [claudeAvailable, setClaudeAvailable] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [loginError, setLoginError] = useState(false)
  const [options, setOptions] = useState<ModelOption[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null)
  const [apiKey, setApiKey] = useState(config.modelKey ?? '')
  const [apiUrl, setApiUrl] = useState(config.modelUrl ?? '')
  const [customModelName, setCustomModelName] = useState('')
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const [customModelError, setCustomModelError] = useState<string | null>(null)
  const [validating, setValidating] = useState(false)

  const runDetection = () => {
    setSubStep('detecting')
    setDetectError(null)
    setLoginError(false)
    AiService.checkClaudeRequirements()
      .then(async () => {
        setClaudeAvailable(true)
        const fetchedIds = await AiService.fetchAnthropicModels(config.modelKey)
        const claudeModels: ModelOption[] =
          fetchedIds.length > 0
            ? fetchedIds.map((id) => ({
              label: id,
              value: id,
              provider: 'claude' as const,
              description: id.includes('opus')
                ? 'Most powerful'
                : id.includes('sonnet')
                  ? 'Fast, capable'
                  : id.includes('haiku')
                    ? 'Fastest'
                    : undefined,
            }))
            : CLAUDE_MODELS

        setOptions([
          ...claudeModels,
          ...CODEX_MODELS,
          ...OPENAI_MODELS,
          ...GEMINI_MODELS,
          OPENROUTER_ENTRY,
          { label: 'Custom OpenAI-compatible...', value: '__custom__', provider: 'openai' },
        ])
        setSubStep('select')
      })
      .catch((err: Error) => {
        setClaudeAvailable(false)
        setOptions([
          ...CODEX_MODELS,
          ...OPENAI_MODELS,
          ...GEMINI_MODELS,
          OPENROUTER_ENTRY,
          { label: 'Custom OpenAI-compatible...', value: '__custom__', provider: 'openai' },
        ])
        if (err.message.includes('not authenticated') || err.message.includes('not logged in')) {
          setLoginError(true)
        } else {
          setDetectError('Claude CLI not found — Claude models unavailable')
        }
        setSubStep('select')
      })
  }

  useEffect(() => {
    runDetection()
  }, [])

  /** Returns the base URL to use when validating the API key for a provider. */
  const validationBaseUrl = (opt: ModelOption): string | undefined => {
    if (opt.defaultBaseUrl) return opt.defaultBaseUrl
    return apiUrl || undefined
  }

  const selectModel = (opt: ModelOption) => {
    setSelectedModel(opt)

    if (opt.provider === 'claude') {
      onComplete({ model: opt.value, modelKey: '', modelUrl: undefined })
      return
    }

    // All non-Claude models need an API key
    if (!config.modelKey) {
      setSubStep('api-key')
      return
    }

    // Need a custom model name for OpenRouter and "Custom OpenAI-compatible"
    if (opt.value === '__openrouter__' || opt.value === '__custom__') {
      setCustomModelName(config.model && !config.model.startsWith('claude') ? config.model : '')
      setSubStep('custom-model')
      return
    }

    // Gemini and OpenRouter have pre-filled base URLs — skip the URL step
    if (opt.provider === 'gemini' || opt.provider === 'openrouter') {
      onComplete({
        model: opt.value,
        modelKey: config.modelKey,
        modelUrl: opt.defaultBaseUrl,
      })
      return
    }

    // OpenAI / Codex — offer optional custom base URL
    setSubStep('api-url')
  }

  useKeyboard((key: KeyEvent) => {
    const { name } = key

    if (subStep === 'select') {
      if (name === 'up') {
        setSelectedIndex((i) => Math.max(0, i - 1))
      } else if (name === 'down') {
        setSelectedIndex((i) => Math.min(options.length - 1, i + 1))
      } else if (name === 'return') {
        const opt = options[selectedIndex]
        if (opt) selectModel(opt)
      } else if ((name === 'r' || name === 'R') && loginError) {
        runDetection()
        key.stopPropagation()
      }
    }
  })

  const handleApiKeySubmit = (input: string) => {
    const trimmed = input.trim()
    if (!trimmed) {
      setApiKeyError('API key is required for this model')
      return
    }
    setValidating(true)
    setApiKeyError(null)
    const baseUrl = selectedModel ? validationBaseUrl(selectedModel) : undefined
    AiService.checkOpenAiRequirements(trimmed, baseUrl)
      .then(() => {
        setValidating(false)
        setApiKey(trimmed)
        const opt = selectedModel
        if (!opt) return

        if (opt.value === '__openrouter__' || opt.value === '__custom__') {
          setCustomModelName(config.model && !config.model.startsWith('claude') ? config.model : '')
          setSubStep('custom-model')
          return
        }

        // Gemini: base URL is auto-filled — done
        if (opt.provider === 'gemini') {
          onComplete({ model: opt.value, modelKey: trimmed, modelUrl: opt.defaultBaseUrl })
          return
        }

        // OpenAI / Codex: offer optional custom URL
        setSubStep('api-url')
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
    // Both OpenRouter and Custom go to the URL step (or we auto-fill for OpenRouter)
    const opt = selectedModel
    if (opt?.value === '__openrouter__') {
      onComplete({ model: trimmed, modelKey: apiKey || config.modelKey, modelUrl: OPENROUTER_BASE_URL })
    } else {
      setSubStep('api-url')
    }
  }

  const handleApiUrlSubmit = (input: string) => {
    const trimmed = input.trim()
    const modelValue =
      selectedModel?.value === '__custom__' ? customModelName : (selectedModel?.value ?? '')
    onComplete({ model: modelValue, modelKey: apiKey || config.modelKey, modelUrl: trimmed || undefined })
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (subStep === 'detecting') {
    return (
      <box flexDirection='column' gap={1}>
        <text fg='#f59e0b'>◌ Detecting available providers...</text>
      </box>
    ) as ReactElement
  }

  if (subStep === 'select') {
    const selectionItems: SelectionItem[] = options.map((opt) => ({
      key: opt.value,
      icon: PROVIDER_ICON[opt.provider] ?? '◇',
      iconColor: PROVIDER_COLOR[opt.provider] ?? '#f59e0b',
      label: opt.label,
      labelColor: PROVIDER_COLOR[opt.provider] ?? '#c9d1d9',
      description: opt.description,
    }))

    return (
      <box flexDirection='column' flexGrow={1} flexShrink={1} overflow={'hidden' as const}>
        {detectError && (
          <text fg='#f59e0b' flexShrink={0}>
            {detectError}
          </text>
        )}
        {loginError && (
          <box flexDirection='column' marginLeft={1} gap={0} flexShrink={0}>
            <text fg='#f59e0b' flexShrink={0}>
              Claude Code is not logged in — Claude models unavailable
            </text>
            <box flexDirection='row' flexWrap='wrap' flexShrink={0}>
              <text attributes={tuiAttrs({ dim: true })} flexShrink={0}>
                Open a new terminal tab, run{' '}
              </text>
              <text fg='#22d3ee' flexShrink={0}>
                claude /login
              </text>
              <text attributes={tuiAttrs({ dim: true })} flexShrink={0}>
                , then press R to retry.
              </text>
            </box>
          </box>
        )}
        {claudeAvailable && (
          <text fg='#10b981' flexShrink={0}>
            {' '}
            ✓ Claude CLI detected
          </text>
        )}
        <text attributes={tuiAttrs({ dim: true })} marginLeft={1} flexShrink={0}>
          Claude · Codex · OpenAI · Gemini · OpenRouter — or a custom endpoint.
        </text>
        <box marginTop={1} flexGrow={1} flexShrink={1} overflow={'hidden' as const}>
          <SelectionList
            items={selectionItems}
            selectedIndex={selectedIndex}
            onSelect={(i) => {
              const opt = options[i]
              if (opt) selectModel(opt)
            }}
            flexGrow={1}
          />
        </box>
        <FooterHints
          hints={
            loginError
              ? '↑↓ navigate · Enter select · R retry login · Esc back'
              : '↑↓ navigate · Enter select · Click to select · Esc back'
          }
          paddingLeft={1}
          marginTop={1}
        />
      </box>
    ) as ReactElement
  }

  if (subStep === 'api-key') {
    const provider = selectedModel?.provider ?? 'openai'
    const placeholder = API_KEY_PLACEHOLDER[provider] || 'sk-...'
    const providerLabel = selectedModel?.label ?? 'this model'
    return (
      <box flexDirection='column' gap={1}>
        <text attributes={tuiAttrs({ dim: true })}>
          Enter your API key for <span fg={PROVIDER_COLOR[provider]}>{providerLabel}</span>
        </text>
        {apiKeyError && <text fg='#ef4444'>✗ {apiKeyError}</text>}
        {validating ? (
          <text fg='#f59e0b'>◌ Validating key...</text>
        ) : (
          <InputField
            value={apiKey}
            onInput={setApiKey}
            onSubmit={(p: InputSubmitPayload) => handleApiKeySubmit(stringFromInputSubmit(p, apiKey))}
            placeholder={placeholder}
            width={50}
          />
        )}
        <FooterHints hints='Enter confirm' />
      </box>
    ) as ReactElement
  }

  if (subStep === 'custom-model') {
    const isOpenRouter = selectedModel?.value === '__openrouter__'
    return (
      <box flexDirection='column' gap={1}>
        <text attributes={tuiAttrs({ dim: true })}>
          {isOpenRouter
            ? 'Enter the OpenRouter model ID (e.g. anthropic/claude-3-5-sonnet, openai/gpt-4o).'
            : 'Enter the model identifier exposed by your provider.'}
        </text>
        {customModelError && <text fg='#ef4444'>✗ {customModelError}</text>}
        <InputField
          value={customModelName}
          onInput={setCustomModelName}
          onSubmit={(p: InputSubmitPayload) => handleCustomModelSubmit(stringFromInputSubmit(p, customModelName))}
          placeholder={isOpenRouter ? 'anthropic/claude-3-5-sonnet' : 'gpt-4.1-mini or provider-specific id'}
          width={55}
        />
        <FooterHints hints='Enter continue' />
      </box>
    ) as ReactElement
  }

  if (subStep === 'api-url') {
    const isCustom = selectedModel?.value === '__custom__'
    return (
      <box flexDirection='column' gap={1}>
        <text attributes={tuiAttrs({ bold: true })}>
          {isCustom ? 'Custom Endpoint (optional)' : 'API Base URL (optional)'}
        </text>
        <text attributes={tuiAttrs({ dim: true })}>
          {isCustom
            ? 'Enter a base URL for your OpenAI-compatible API, or leave empty to use the default endpoint.'
            : 'Leave empty to use the default OpenAI endpoint.'}
        </text>
        <InputField
          value={apiUrl}
          onInput={setApiUrl}
          onSubmit={(p: InputSubmitPayload) => handleApiUrlSubmit(stringFromInputSubmit(p, apiUrl))}
          placeholder='leave empty for default'
          width={50}
        />
        <FooterHints hints='Enter continue' />
      </box>
    ) as ReactElement
  }

  return null
}
