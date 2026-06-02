import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { AgentAttachment, ConversationMessage } from '../types/index.js'
import { sanitizeCapturedValue, wrapUntrustedObservabilityData } from '../lib/untrustedObservability.js'
import {
  buildAttachedSessionContextDoc,
  buildDebugSessionMcpServer,
  fetchAttachmentContent,
  fetchDebugSessionContext,
  fetchDebugSessionSnapshot,
  type McpConfig
} from './ai.service.js'

/** Matches web-app AgentChat attachment kinds. */
export const CONTEXT_ATTACHMENT_KIND = {
  DEBUG_SESSION: 'debugSession',
  DEBUG_SESSION_SPAN: 'debugSessionSpan',
  DEBUG_SESSION_SNAPSHOT: 'debugSessionSnapshot'
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
    isMulti ? '## Spans Data' : '## Span Data',
    '```json',
    clipJson(sanitizeCapturedValue(payload), MAX_SPAN_JSON_CHARS),
    '```'
  ].join('\n')

  return ['## Context Attachment: debug session span', wrapUntrustedObservabilityData(body)].join('\n\n')
}

const appendSpanContextToMessage = (
  content: string,
  attachments: AgentAttachment[] | undefined,
  onLog?: LogFn
): string => {
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
 * Renders snapshot context attachments into prompt text and vision images.
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

const isClaudeModel = (model: string): boolean => model === 'claude-code' || model.startsWith('claude')

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
    messageContent = `${messageContent}\n\n> Debug session${debugSessionIds.length > 1 ? 's' : ''} attached: ${idList}. Use the \`get_debug_session_context\` tool to fetch traces, logs, and notes for ${debugSessionIds.length > 1 ? 'each session' : 'this session'}.`
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
  let messageContent = appendSpanContextToMessage(params.content, params.attachments, params.onLog)

  const snapshotResult = await resolveSnapshotAttachments(messageContent, params.attachments, {
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    mcpConfig: params.mcpConfig,
    onLog: params.onLog
  })
  messageContent = snapshotResult.messageContent

  if (params.workspaceId && params.projectId) {
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

  return {
    messageContent,
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

  if (options?.workspaceId && options?.projectId && options?.mcpConfig) {
    const snapshotResult = await resolveSnapshotAttachments(messageContent, attachments, options)
    messageContent = snapshotResult.messageContent
    images = [...images, ...snapshotResult.images]
  }

  return { role: 'user', content: messageContent, ...(images.length ? { images } : {}) }
}
