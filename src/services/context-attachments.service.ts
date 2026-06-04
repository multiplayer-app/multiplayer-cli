import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { AgentAttachment, ConversationMessage } from '../types/index.js'
import { isAnthropicModel } from '../lib/llm/factory.js'
import { sanitizeCapturedValue, wrapUntrustedObservabilityData } from '../lib/untrustedObservability.js'
import {
  buildAttachedSessionContextDoc,
  buildDebugSessionMcpServer,
  fetchAttachmentContent,
  fetchDebugSessionContext,
  fetchDebugSessionSnapshot,
  type McpConfig
} from './ai.service.js'

/** Matches web-app AgentChat attachment kinds (see kinds.ts). */
export const CONTEXT_ATTACHMENT_KIND = {
  /** Full session recording — register MCP tools; model fetches traces/logs/notes/rrweb on demand. */
  DEBUG_SESSION: 'debugSession',
  /** Selected span(s) — inline metadata.data only; no session fetch. */
  DEBUG_SESSION_SPAN: 'debugSessionSpan',
  /** Playback snapshot — render frame via assets snapshot endpoint. */
  DEBUG_SESSION_SNAPSHOT: 'debugSessionSnapshot',
  /** DOM element picked in recording inspector — inline metadata.data only. */
  DEBUG_SESSION_ELEMENT: 'debugSessionElement'
} as const

export type ContextAttachmentKind = (typeof CONTEXT_ATTACHMENT_KIND)[keyof typeof CONTEXT_ATTACHMENT_KIND]

const MAX_SPAN_JSON_CHARS = 100_000

export interface DebugSessionSpanAttachmentData {
  debugSessionId?: string
  debugSessionName?: string
  debugSessionUrl?: string
  spans?: Array<{
    nodeId?: string
    spanId?: string
    traceId?: string
    span?: unknown
  }>
  /** @deprecated Prefer `spans`. */
  nodeId?: string
  spanId?: string
  traceId?: string
  span?: unknown
}

export interface DebugSessionSnapshotAttachmentData {
  debugSessionId: string
  debugSessionName?: string
  debugSessionUrl?: string
  timestampMs: number
  relativeTime?: string
}

export interface ElementPathItem {
  tagName: string
  className?: string
  id?: string
  nthChild?: number
  attributes?: Record<string, string>
}

export interface DebugSessionElementAttachmentData {
  debugSessionId: string
  debugSessionName?: string
  debugSessionUrl?: string
  timestampMs: number
  relativeTime?: string
  selector: string
  tagName: string
  id?: string
  className?: string
  textContent?: string
  attributes?: Array<{ name: string; value: string }>
  computedStyles?: Record<string, string>
  rect?: { width: number; height: number; left: number; top: number }
  path?: ElementPathItem[]
  message?: string
}

type LogFn = (level: 'info' | 'error', message: string) => void

export interface ContextAttachmentResolutionOptions {
  workspaceId?: string
  projectId?: string
  mcpConfig?: McpConfig
  onLog?: LogFn
}

const isContextAttachment = (attachment: AgentAttachment): boolean => attachment.type === 'context'

const getContextKind = (attachment: AgentAttachment): string | undefined => {
  const kind = attachment.metadata?.kind
  return typeof kind === 'string' ? kind : undefined
}

export const getContextAttachmentsByKind = (
  attachments: AgentAttachment[] | undefined,
  kind: ContextAttachmentKind
): AgentAttachment[] => (attachments ?? []).filter((a) => isContextAttachment(a) && getContextKind(a) === kind)

export const extractDebugSessionIds = (attachments: AgentAttachment[] | undefined): string[] =>
  getContextAttachmentsByKind(attachments, CONTEXT_ATTACHMENT_KIND.DEBUG_SESSION)
    .map((a) => (a.metadata?.data as Record<string, unknown> | undefined)?.debugSessionId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)

const clipJson = (value: unknown, maxChars: number): string => {
  const json = JSON.stringify(value, null, 2)
  if (json.length <= maxChars) return json
  return `${json.slice(0, maxChars)}\n… (truncated)`
}

const getElementData = (attachment: AgentAttachment): DebugSessionElementAttachmentData | undefined => {
  const data = attachment.metadata?.data as Record<string, unknown> | undefined
  const debugSessionId = data?.debugSessionId
  const timestampMs = data?.timestampMs
  const selector = data?.selector
  const tagName = data?.tagName

  if (typeof debugSessionId !== 'string' || !debugSessionId) return undefined
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs) || timestampMs < 0) return undefined
  if (typeof selector !== 'string' || !selector) return undefined
  if (typeof tagName !== 'string' || !tagName) return undefined

  return {
    debugSessionId,
    debugSessionName: typeof data?.debugSessionName === 'string' ? data.debugSessionName : undefined,
    debugSessionUrl: typeof data?.debugSessionUrl === 'string' ? data.debugSessionUrl : undefined,
    timestampMs: Math.floor(timestampMs),
    relativeTime: typeof data?.relativeTime === 'string' ? data.relativeTime : undefined,
    selector,
    tagName,
    id: typeof data?.id === 'string' ? data.id : undefined,
    className: typeof data?.className === 'string' ? data.className : undefined,
    textContent: typeof data?.textContent === 'string' ? data.textContent : undefined,
    attributes: Array.isArray(data?.attributes)
      ? (data.attributes as Array<{ name?: string; value?: string }>)
          .filter((a) => typeof a?.name === 'string')
          .map((a) => ({ name: a.name as string, value: String(a.value ?? '') }))
      : undefined,
    computedStyles:
      data?.computedStyles && typeof data.computedStyles === 'object' && !Array.isArray(data.computedStyles)
        ? (data.computedStyles as Record<string, string>)
        : undefined,
    rect:
      data?.rect && typeof data.rect === 'object' && !Array.isArray(data.rect)
        ? (data.rect as DebugSessionElementAttachmentData['rect'])
        : undefined,
    path: Array.isArray(data?.path) ? (data.path as ElementPathItem[]) : undefined,
    message: typeof data?.message === 'string' ? data.message : undefined
  }
}

const getSnapshotData = (attachment: AgentAttachment): DebugSessionSnapshotAttachmentData | undefined => {
  const data = attachment.metadata?.data as Record<string, unknown> | undefined
  const debugSessionId = data?.debugSessionId
  const timestampMs = data?.timestampMs

  if (typeof debugSessionId !== 'string' || !debugSessionId) return undefined
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs) || timestampMs < 0) return undefined

  return {
    debugSessionId,
    debugSessionName: typeof data?.debugSessionName === 'string' ? data.debugSessionName : undefined,
    debugSessionUrl: typeof data?.debugSessionUrl === 'string' ? data.debugSessionUrl : undefined,
    timestampMs: Math.floor(timestampMs),
    relativeTime: typeof data?.relativeTime === 'string' ? data.relativeTime : undefined
  }
}

const getSpanEntries = (
  data: DebugSessionSpanAttachmentData | undefined
): NonNullable<DebugSessionSpanAttachmentData['spans']> => {
  if (!data) return []

  if (Array.isArray(data.spans) && data.spans.length > 0) {
    return data.spans.filter((entry) => entry?.span)
  }

  if (data.span) {
    return [
      {
        nodeId: data.nodeId,
        spanId: data.spanId,
        traceId: data.traceId,
        span: data.span
      }
    ]
  }

  return []
}

export { getSpanEntries }

/**
 * Formats an inline debug-session span attachment for the model prompt.
 */
export const buildSpanAttachmentPromptSection = (attachment: AgentAttachment): string | undefined => {
  const data = attachment.metadata?.data as DebugSessionSpanAttachmentData | undefined
  const spanEntries = getSpanEntries(data)
  if (!spanEntries.length) return undefined

  const summary = typeof attachment.metadata?.summary === 'string' ? attachment.metadata.summary : undefined
  const isMulti = spanEntries.length > 1
  const headerLines = [
    isMulti
      ? `# Attached Debug Session Spans (${spanEntries.length}): ${attachment.name}`
      : `# Attached Debug Session Span: ${attachment.name}`,
    ''
  ]

  if (data?.debugSessionId) headerLines.push(`**Session ID:** \`${data.debugSessionId}\``)
  if (data?.debugSessionName) headerLines.push(`**Session:** ${data.debugSessionName}`)
  if (data?.debugSessionUrl) headerLines.push(`**URL:** ${data.debugSessionUrl}`)

  if (!isMulti) {
    const entry = spanEntries[0]
    if (entry?.nodeId) headerLines.push(`**Node ID:** \`${entry.nodeId}\``)
    if (entry?.spanId) headerLines.push(`**Span ID:** \`${entry.spanId}\``)
    if (entry?.traceId) headerLines.push(`**Trace ID:** \`${entry.traceId}\``)
  }

  if (summary) headerLines.push('', `_${summary}_`)

  const payload = {
    debugSessionId: data?.debugSessionId,
    debugSessionName: data?.debugSessionName,
    debugSessionUrl: data?.debugSessionUrl,
    spans: spanEntries.map(({ nodeId, spanId, traceId, span }) => ({
      nodeId,
      spanId,
      traceId,
      span
    }))
  }

  const body = [
    ...headerLines,
    '',
    '_Analyze only the span data attached below. Do not fetch or summarize the full debug session unless the user explicitly asks._',
    '',
    isMulti ? '## Spans Data' : '## Span Data',
    '```json',
    clipJson(sanitizeCapturedValue(payload), MAX_SPAN_JSON_CHARS),
    '```'
  ].join('\n')

  return ['## Context Attachment: debug session span', wrapUntrustedObservabilityData(body)].join('\n\n')
}

/**
 * Formats an inline debug-session DOM element attachment for the model prompt.
 */
export const buildElementAttachmentPromptSection = (attachment: AgentAttachment): string | undefined => {
  const data = getElementData(attachment)
  if (!data) return undefined

  const summary = typeof attachment.metadata?.summary === 'string' ? attachment.metadata.summary : undefined
  const headerLines = [`# Attached DOM Element: ${attachment.name}`, '']

  if (data.debugSessionId) headerLines.push(`**Session ID:** \`${data.debugSessionId}\``)
  if (data.debugSessionName) headerLines.push(`**Session:** ${data.debugSessionName}`)
  if (data.debugSessionUrl) headerLines.push(`**URL:** ${data.debugSessionUrl}`)
  if (data.relativeTime) {
    headerLines.push(`**Playback time:** ${data.relativeTime} (${data.timestampMs}ms)`)
  } else {
    headerLines.push(`**Playback offset:** ${data.timestampMs}ms`)
  }

  headerLines.push(`**Selector:** \`${data.selector}\``)
  headerLines.push(`**Tag:** \`${data.tagName}\``)
  if (data.id) headerLines.push(`**ID:** \`${data.id}\``)
  if (data.className) headerLines.push(`**Classes:** \`${data.className}\``)
  if (data.textContent) headerLines.push(`**Text:** ${data.textContent}`)
  if (data.message) headerLines.push('', `**User note:** ${data.message}`)
  if (summary) headerLines.push('', `_${summary}_`)

  const body = [
    ...headerLines,
    '',
    '_Analyze only the DOM element data attached below. Do not fetch the full debug session unless the user explicitly asks._',
    '',
    '## Element Data',
    '```json',
    clipJson(sanitizeCapturedValue(data), MAX_SPAN_JSON_CHARS),
    '```'
  ].join('\n')

  return ['## Context Attachment: debug session element', wrapUntrustedObservabilityData(body)].join('\n\n')
}

const appendElementContextToMessage = (
  content: string,
  attachments: AgentAttachment[] | undefined,
  onLog?: LogFn
): string => {
  const elementAttachments = getContextAttachmentsByKind(attachments, CONTEXT_ATTACHMENT_KIND.DEBUG_SESSION_ELEMENT)
  if (!elementAttachments.length) return content

  let messageContent = content
  for (const attachment of elementAttachments) {
    onLog?.('info', `Inlining debug session element attachment "${attachment.name}"`)
    const section = buildElementAttachmentPromptSection(attachment)
    if (section) messageContent = `${messageContent}\n\n${section}`
  }
  return messageContent
}

const appendSpanContextToMessage = (
  content: string,
  attachments: AgentAttachment[] | undefined,
  onLog?: LogFn
): string => {
  // kind: debugSessionSpan → read span payload from metadata.data only
  const spanAttachments = getContextAttachmentsByKind(attachments, CONTEXT_ATTACHMENT_KIND.DEBUG_SESSION_SPAN)
  if (!spanAttachments.length) return content

  let messageContent = content
  for (const attachment of spanAttachments) {
    const spanCount = getSpanEntries(attachment.metadata?.data as DebugSessionSpanAttachmentData | undefined).length
    onLog?.(
      'info',
      `Inlining debug session span attachment "${attachment.name}" (${spanCount} span${spanCount === 1 ? '' : 's'})`
    )
    const section = buildSpanAttachmentPromptSection(attachment)
    if (section) messageContent = `${messageContent}\n\n${section}`
  }
  return messageContent
}

const buildSnapshotPromptLine = (attachment: AgentAttachment, data: DebugSessionSnapshotAttachmentData): string => {
  const label = data.relativeTime ?? attachment.name
  return `> Session snapshot attached: **${attachment.name}** (${label}, ${data.timestampMs}ms playback offset).`
}

/**
 * kind: debugSessionSnapshot → fetch screenshot from assets service.
 */
export const resolveSnapshotAttachments = async (
  messageContent: string,
  attachments: AgentAttachment[] | undefined,
  options: ContextAttachmentResolutionOptions
): Promise<{ messageContent: string; images: string[] }> => {
  const snapshotAttachments = getContextAttachmentsByKind(attachments, CONTEXT_ATTACHMENT_KIND.DEBUG_SESSION_SNAPSHOT)
  if (!snapshotAttachments.length) {
    return { messageContent, images: [] }
  }

  const { workspaceId, projectId, mcpConfig, onLog } = options
  if (!workspaceId || !projectId || !mcpConfig) {
    onLog?.('info', 'Skipping snapshot attachments — workspace/project credentials unavailable')
    return { messageContent, images: [] }
  }

  let nextContent = messageContent
  const images: string[] = []

  for (const attachment of snapshotAttachments) {
    const data = getSnapshotData(attachment)
    if (!data) {
      onLog?.('info', `Skipping invalid snapshot attachment "${attachment.name}"`)
      continue
    }

    onLog?.(
      'info',
      `Rendering session snapshot for ${data.debugSessionId} @ ${data.timestampMs}ms (${attachment.name})`
    )

    nextContent = `${nextContent}\n\n${buildSnapshotPromptLine(attachment, data)}`

    try {
      const image = await fetchDebugSessionSnapshot(
        data.debugSessionId,
        data.timestampMs,
        workspaceId,
        projectId,
        mcpConfig
      )

      if (image) {
        images.push(image)
      } else {
        onLog?.('error', `Failed to render snapshot for ${data.debugSessionId} @ ${data.timestampMs}ms`)
        nextContent = `${nextContent}\n_(Snapshot image could not be generated.)_`
      }
    } catch (err) {
      onLog?.(
        'error',
        `Failed to render snapshot for ${data.debugSessionId} @ ${data.timestampMs}ms: ${err instanceof Error ? err.message : String(err)}`
      )
      nextContent = `${nextContent}\n_(Snapshot image could not be generated.)_`
    }
  }

  return { messageContent: nextContent, images }
}

export interface EnrichUserMessageParams {
  content: string
  attachments: AgentAttachment[] | undefined
  workspaceId?: string
  projectId?: string
  model: string
  mcpConfig: McpConfig
  onLog?: LogFn
}

export interface EnrichUserMessageResult {
  messageContent: string
  mcpServers?: Record<string, McpServerConfig>
  images?: string[]
}

const isClaudeModel = (model: string): boolean => isAnthropicModel(model)

/**
 * kind: debugSession → Claude: register in-process MCP server (traces/logs/notes/rrweb tools).
 * Non-Claude: MCP is unavailable; pre-fetch session context into the prompt as fallback.
 */
const resolveDebugSessionAttachments = async (params: {
  messageContent: string
  attachments: AgentAttachment[] | undefined
  workspaceId: string
  projectId: string
  model: string
  mcpConfig: McpConfig
  onLog?: LogFn
}): Promise<EnrichUserMessageResult> => {
  const { attachments, workspaceId, projectId, model, mcpConfig, onLog } = params
  let messageContent = params.messageContent

  const debugSessionIds = extractDebugSessionIds(attachments)
  if (!debugSessionIds.length) {
    return { messageContent }
  }

  if (isClaudeModel(model)) {
    const idList = debugSessionIds.map((id) => `\`${id}\``).join(', ')
    messageContent = `${messageContent}\n\n> Debug session${debugSessionIds.length > 1 ? 's' : ''} attached: ${idList}. Use the \`get_debug_session_traces\`, \`get_debug_session_logs\`, \`get_debug_session_notes\`, and \`get_debug_session_rrweb_timeline\` tools to investigate ${debugSessionIds.length > 1 ? 'each session' : 'this session'}.`
    onLog?.('info', `Debug session MCP server registered for session(s): ${debugSessionIds.join(', ')}`)

    return {
      messageContent,
      mcpServers: {
        'multiplayer-debug-sessions': buildDebugSessionMcpServer(mcpConfig, workspaceId, projectId)
      }
    }
  }

  for (const debugSessionId of debugSessionIds) {
    onLog?.('info', `Pre-fetching debug session context for non-Claude model: ${debugSessionId}`)
    try {
      const result = await fetchDebugSessionContext(debugSessionId, workspaceId, projectId, mcpConfig)
      if (!result) {
        onLog?.('info', `No debug context returned for session ${debugSessionId}`)
        continue
      }

      messageContent = `${messageContent}\n\n${buildAttachedSessionContextDoc(debugSessionId, result.context)}`

      if (result.sessionSketches.length > 0) {
        const sketchList = result.sessionSketches
          .map((s) => `- ${s.title ?? 'Sketch'} (s3://${s.s3Bucket}/${s.s3Key})`)
          .join('\n')
        messageContent = `${messageContent}\n\n**Session Sketches:**\n${sketchList}`
      }
    } catch (err) {
      onLog?.(
        'error',
        `Failed to pre-fetch debug session context for ${debugSessionId}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return { messageContent }
}

export const enrichUserMessageWithContextAttachments = async (
  params: EnrichUserMessageParams
): Promise<EnrichUserMessageResult> => {
  // Strict routing by metadata.kind — each kind uses a different data source.
  let messageContent = appendSpanContextToMessage(params.content, params.attachments, params.onLog)
  messageContent = appendElementContextToMessage(messageContent, params.attachments, params.onLog)

  const snapshotResult = await resolveSnapshotAttachments(messageContent, params.attachments, {
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    mcpConfig: params.mcpConfig,
    onLog: params.onLog
  })
  messageContent = snapshotResult.messageContent

  if (!params.workspaceId || !params.projectId) {
    return {
      messageContent,
      images: snapshotResult.images.length ? snapshotResult.images : undefined
    }
  }

  const debugSessionResult = await resolveDebugSessionAttachments({
    messageContent,
    attachments: params.attachments,
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    model: params.model,
    mcpConfig: params.mcpConfig,
    onLog: params.onLog
  })

  return {
    messageContent: debugSessionResult.messageContent,
    mcpServers: debugSessionResult.mcpServers,
    images: snapshotResult.images.length ? snapshotResult.images : undefined
  }
}

export const buildRestoredUserMessage = async (
  content: string,
  attachments: AgentAttachment[] | undefined,
  options?: ContextAttachmentResolutionOptions
): Promise<ConversationMessage> => {
  const fileAttachments = (attachments ?? []).filter((a) => a.type === 'file')
  let messageContent = content
  let images: string[] = []

  if (fileAttachments.length) {
    const fileContent = await fetchAttachmentContent(
      fileAttachments.map((a) => ({ name: a.name, url: a.url, mimeType: a.mimeType }))
    )
    if (fileContent.textBlocks.length) {
      messageContent = `${messageContent}\n\n${fileContent.textBlocks.join('\n\n')}`
    }
    images = fileContent.images
  }

  messageContent = appendSpanContextToMessage(messageContent, attachments)
  messageContent = appendElementContextToMessage(messageContent, attachments)

  if (options?.workspaceId && options?.projectId && options?.mcpConfig) {
    const snapshotResult = await resolveSnapshotAttachments(messageContent, attachments, options)
    messageContent = snapshotResult.messageContent
    images = [...images, ...snapshotResult.images]
  }

  return { role: 'user', content: messageContent, ...(images.length ? { images } : {}) }
}
