import path from 'path'
import os from 'os'

// ─── Multiplayer home directory ───────────────────────────────────────────────

export const MP_DIR = path.join(os.homedir(), '.multiplayer')
export const LEGACY_TOKENS_FILE = path.join(MP_DIR, 'tokens.json')

// ─── API ──────────────────────────────────────────────────────────────────────

export const PRODUCTION_API_HOSTNAME = 'api.multiplayer.app'
export const PRODUCTION_WEB_HOSTNAME = 'go.multiplayer.app'

/**
 * The single source of truth for which Multiplayer server the CLI talks to,
 * and at which version/prefix its routes are mounted. Configurable via --url /
 * MULTIPLAYER_URL. The backend's own route prefix is independently overridable
 * there (multiplayer-api-service/radar-service both read API_PREFIX from env,
 * defaulting to /v0/api and /v0/radar respectively) — so this is NOT assumed to
 * always be `/v0`; toApiBase() below preserves whatever path the caller
 * configured rather than forcing one, so a self-hosted deploy with a different
 * prefix (or none) is respected everywhere instead of being silently overwritten.
 */
export const API_URL = process.env.MULTIPLAYER_URL || `https://${PRODUCTION_API_HOSTNAME}/v0`

/**
 * Origin (scheme + host) of a Multiplayer API URL, discarding any path. Use
 * this for root-mounted endpoints that live outside the versioned API, like
 * `/.well-known/...`, and for the socket.io connection origin (whose own
 * versioned path is passed separately via socket.io's `path` option).
 */
export function toApiOrigin(url: string): string {
  return new URL(url).origin
}

/**
 * Normalizes a configured Multiplayer API URL for safe path concatenation by
 * trimming any trailing slash. Every backend route (the api-service's
 * `/api/...` domain and the standalone radar-service's `/radar/...` domain) is
 * relative to this base — e.g. `${toApiBase(url)}/api/auth/user-session`,
 * `${toApiBase(url)}/radar/...`. Deliberately does NOT rebuild the path from
 * the origin — the configured URL (default: https://.../v0) already carries
 * whatever version/prefix segment the target backend expects.
 */
export function toApiBase(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Derives the web app base URL from the API URL (e.g. --url flag). */
export function getWebBaseUrl(apiUrl?: string): string {
  if (!apiUrl) return `https://${PRODUCTION_WEB_HOSTNAME}`
  try {
    const { hostname } = new URL(apiUrl)
    if (hostname === PRODUCTION_API_HOSTNAME) return `https://${PRODUCTION_WEB_HOSTNAME}`
    return new URL(apiUrl).origin
  } catch {
    return `https://${PRODUCTION_WEB_HOSTNAME}`
  }
}
// ─── Demo repo ────────────────────────────────────────────────────────────────

export const DEMO_REPO_URL = 'https://github.com/multiplayer-app/cli-app-demo'
export const DEMO_DIR = path.join(os.homedir(), 'multiplayer-demo')

// ─── Agent defaults ───────────────────────────────────────────────────────────

export const DEFAULT_MAX_CONCURRENT = 2

// ─── AI service limits ────────────────────────────────────────────────────────

export const MAX_FILE_SIZE = 50_000 // chars
export const MAX_FILES_TO_READ = 20

// ─── Socket.IO reconnection ───────────────────────────────────────────────────

export const SOCKET_RECONNECTION_DELAY = 2_000 // ms
export const SOCKET_RECONNECTION_DELAY_MAX = 30_000 // ms

// ─── Socket event names ───────────────────────────────────────────────────────

export const EVENT_MESSAGE_NEW = 'message:new'
export const EVENT_CHAT_NEW = 'chat:new'
export const EVENT_CHAT_UPDATE = 'chat:update'
export const EVENT_CHAT_SUBSCRIBE = 'chat:subscribe'
export const EVENT_CHAT_UNSUBSCRIBE = 'chat:unsubscribe'
export const EVENT_AGENT_CHAT_BULK_DELETE = 'chat:bulk_delete'
export const EVENT_AGENT_CHAT_DELETE = 'chat:delete'
export const EVENT_DEBUGGING_AGENT_RESOLVE_ISSUE = 'debugging-agent:resolve-issue'
export const EVENT_DEBUGGING_AGENT_READY = 'debugging-agent:ready'
export const EVENT_DEBUGGING_AGENT_FIX_PUSHED = 'debugging-agent:fix-pushed'
export const EVENT_DEBUGGING_AGENT_FIX_FAILED = 'debugging-agent:fix-failed'
export const EVENT_DEBUGGING_AGENT_UPDATE = 'debugging-agent:update'
