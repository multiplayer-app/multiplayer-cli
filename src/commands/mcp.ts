import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import jwt from 'jsonwebtoken'
import * as API from '../services/version-api.service.js'
import { API_URL } from '../config.js'
import { getAuthHeaders } from '../lib/authHeaders.js'

interface JwtPayload {
  workspace?: string
  project?: string
}

function decodeJwt(apiKey: string): JwtPayload {
  try {
    return (jwt.decode(apiKey) as JwtPayload) || {}
  } catch {
    return {}
  }
}

function requireApiKey(): string {
  const key = process.env.MULTIPLAYER_API_KEY
  if (!key) throw new Error('MULTIPLAYER_API_KEY environment variable is not set')
  return key
}

const collectSourcemaps = (dir: string): string[] => {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectSourcemaps(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.map')) {
      files.push(fullPath)
    }
  }
  return files
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'multiplayer',
    version: '1.0.0',
  })

  server.registerTool(
    'create_release',
    {
      description: 'Register a new release for a service in Multiplayer.',
      inputSchema: {
        service: z.string().describe('Service name'),
        version: z.string().describe('Release version (e.g. 1.2.3 or git SHA)'),
        commitHash: z.string().optional().describe('Git commit hash'),
        repositoryUrl: z.string().optional().describe('Repository URL'),
        releaseNotes: z.string().optional().describe('Release notes'),
        baseUrl: z.string().optional().describe('Multiplayer API base URL (uses default if omitted)'),
      },
    },
    async ({ service, version, commitHash, repositoryUrl, releaseNotes, baseUrl }) => {
      const apiKey = requireApiKey()
      const { workspace, project } = decodeJwt(apiKey)

      const branchId = await API.getDefaultBranchId(apiKey, workspace, project, baseUrl)
      const serviceId = await API.getEntityId(apiKey, workspace, project, branchId, service, 'platform_component', baseUrl)

      await API.createRelease(apiKey, workspace, project, {
        entity: serviceId,
        version,
        releaseNotes: releaseNotes ?? '',
        commitHash,
        repositoryUrl,
      }, baseUrl)

      return {
        content: [{ type: 'text' as const, text: `Release ${version} created successfully for service "${service}".` }],
      }
    },
  )

  server.registerTool(
    'create_deployment',
    {
      description: 'Register a deployment linking a release to an environment in Multiplayer.',
      inputSchema: {
        service: z.string().describe('Service name'),
        release: z.string().describe('Release version to deploy'),
        environment: z.string().describe('Target environment name (e.g. production, staging)'),
        baseUrl: z.string().optional().describe('Multiplayer API base URL (uses default if omitted)'),
      },
    },
    async ({ service, release, environment, baseUrl }) => {
      const apiKey = requireApiKey()
      const { workspace, project } = decodeJwt(apiKey)

      const branchId = await API.getDefaultBranchId(apiKey, workspace, project, baseUrl)
      const serviceId = await API.getEntityId(apiKey, workspace, project, branchId, service, 'platform_component', baseUrl)
      const releaseId = await API.getReleaseId(apiKey, workspace, project, serviceId, release, baseUrl)
      const environmentId = await API.getEntityId(apiKey, workspace, project, branchId, environment, 'environment', baseUrl)

      await API.createDeployment(apiKey, workspace, project, {
        entity: serviceId,
        release: releaseId,
        environment: environmentId,
      }, baseUrl)

      return {
        content: [{ type: 'text' as const, text: `Deployment of release "${release}" to "${environment}" created successfully for service "${service}".` }],
      }
    },
  )

  server.registerTool(
    'upload_sourcemaps',
    {
      description: 'Upload sourcemap (.map) files from one or more local directories to a Multiplayer release.',
      inputSchema: {
        directories: z.array(z.string()).describe('Local directory paths to scan for .map files'),
        service: z.string().describe('Service name'),
        release: z.string().describe('Release version the sourcemaps belong to'),
        baseUrl: z.string().optional().describe('Multiplayer API base URL (uses default if omitted)'),
      },
    },
    async ({ directories, service, release, baseUrl }) => {
      const apiKey = requireApiKey()
      const { workspace, project } = decodeJwt(apiKey)

      const branchId = await API.getDefaultBranchId(apiKey, workspace, project, baseUrl)
      const serviceId = await API.getEntityId(apiKey, workspace, project, branchId, service, 'platform_component', baseUrl)
      const releaseId = await API.getReleaseId(apiKey, workspace, project, serviceId, release, baseUrl)

      const files = directories.flatMap(collectSourcemaps)
      if (files.length === 0) {
        throw new Error(`No .map files found in: ${directories.join(', ')}`)
      }

      for (const filePath of files) {
        const stream = fs.createReadStream(filePath)
        await API.uploadSourcemap(apiKey, workspace, project, releaseId, filePath, stream, baseUrl)
      }

      return {
        content: [{ type: 'text' as const, text: `Uploaded ${files.length} sourcemap(s) for release "${release}" of service "${service}".` }],
      }
    },
  )

  const baseUrl = process.env.MULTIPLAYER_URL || API_URL
  const debugSessionId = z.string().describe('The debug session ID')

  server.registerTool(
    'get_debug_session_traces',
    {
      description: 'Fetch OTLP traces for a Multiplayer debug session.',
      inputSchema: { debugSessionId },
    },
    async ({ debugSessionId: id }) => {
      const apiKey = requireApiKey()
      const { workspace, project } = decodeJwt(apiKey)
      const url = new URL(`${baseUrl}/v0/radar/workspaces/${workspace}/projects/${project}/debug-sessions/${id}/otel-traces`)
      url.searchParams.set('skip', '0')
      url.searchParams.set('limit', '300')
      const res = await fetch(url.toString(), { headers: getAuthHeaders(apiKey) })
      const data = res.ok ? await res.json() : { error: `${res.status} ${res.statusText}` }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    },
  )

  server.registerTool(
    'get_debug_session_logs',
    {
      description: 'Fetch OTLP logs for a Multiplayer debug session.',
      inputSchema: { debugSessionId },
    },
    async ({ debugSessionId: id }) => {
      const apiKey = requireApiKey()
      const { workspace, project } = decodeJwt(apiKey)
      const url = new URL(`${baseUrl}/v0/radar/workspaces/${workspace}/projects/${project}/debug-sessions/${id}/otel-logs`)
      url.searchParams.set('skip', '0')
      url.searchParams.set('limit', '300')
      const res = await fetch(url.toString(), { headers: getAuthHeaders(apiKey) })
      const data = res.ok ? await res.json() : { error: `${res.status} ${res.statusText}` }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    },
  )

  server.registerTool(
    'get_debug_session_notes',
    {
      description: 'Fetch session notes and sketches for a Multiplayer debug session.',
      inputSchema: { debugSessionId },
    },
    async ({ debugSessionId: id }) => {
      const apiKey = requireApiKey()
      const { workspace, project } = decodeJwt(apiKey)
      const url = new URL(`${baseUrl}/v0/radar/workspaces/${workspace}/projects/${project}/debug-sessions/${id}/session-notes/context`)
      const res = await fetch(url.toString(), { headers: getAuthHeaders(apiKey) })
      const data = res.ok ? await res.json() : { error: `${res.status} ${res.statusText}` }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    },
  )

  server.registerTool(
    'get_debug_session_rrweb_timeline',
    {
      description: 'Fetch the rrweb UI recording timeline for a Multiplayer debug session.',
      inputSchema: { debugSessionId },
    },
    async ({ debugSessionId: id }) => {
      const apiKey = requireApiKey()
      const { workspace, project } = decodeJwt(apiKey)
      const url = new URL(`${baseUrl}/v0/radar/workspaces/${workspace}/projects/${project}/debug-sessions/${id}/rrweb-events`)
      url.searchParams.set('limit', '5000')
      const res = await fetch(url.toString(), { headers: getAuthHeaders(apiKey) })
      const data = res.ok ? await res.json() : { error: `${res.status} ${res.statusText}` }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
