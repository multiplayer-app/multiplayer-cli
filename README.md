![Description](./docs/img/header-js.png)

<div align="center">
<a href="https://github.com/multiplayer-app/multiplayer-cli">
  <img src="https://img.shields.io/github/stars/multiplayer-app/multiplayer-cli?style=social&label=Star&maxAge=2592000" alt="GitHub stars">
</a>
  <a href="https://github.com/multiplayer-app/multiplayer-cli/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/multiplayer-app/multiplayer-cli" alt="License">
  </a>
  <a href="https://multiplayer.app">
    <img src="https://img.shields.io/badge/Visit-multiplayer.app-blue" alt="Visit Multiplayer">
  </a>

</div>
<div>
  <p align="center">
    <a href="https://x.com/trymultiplayer">
      <img src="https://img.shields.io/badge/Follow%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X" />
    </a>
    <a href="https://www.linkedin.com/company/multiplayer-app/">
      <img src="https://img.shields.io/badge/Follow%20on%20LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" alt="Follow on LinkedIn" />
    </a>
    <a href="https://discord.com/invite/q9K3mDzfrx">
      <img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord" />
    </a>
  </p>
</div>

# @multiplayer-app/cli

AI-powered debugging agent and release management CLI for [Multiplayer](https://multiplayer.app).

## Install

```sh
npm install -g @multiplayer-app/cli
```

Supports macOS (arm64, x64), Linux (arm64, x64), and Windows (arm64, x64). The correct platform binary is installed automatically.

## Commands

| Command | Description |
|---------|-------------|
| `multiplayer [agent]` | Start the debugging agent (default) |
| `multiplayer releases create` | Register a release |
| `multiplayer deployments create` | Register a deployment |
| `multiplayer sourcemaps upload` | Upload sourcemap files |
| `multiplayer auth login` | Log in via browser OAuth |
| `multiplayer auth logout` | Log out and clear credentials |
| `multiplayer auth status` | Check authentication status |
| `multiplayer mcp` | Start an MCP server for AI agent integration |

---

## Debugging Agent

Connects to the Multiplayer backend and automatically resolves incoming issues using AI.

```sh
multiplayer [agent] [options]
```

Options are resolved in this order: **CLI flag → environment variable → config profile**.

| Flag | Env var | Description |
|------|---------|-------------|
| `--api-key <key>` | `MULTIPLAYER_API_KEY` | Multiplayer API key |
| `--dir <path>` | `MULTIPLAYER_DIR` | Project directory (must be a git repo) |
| `--model <name>` | `AI_MODEL` | AI model (e.g. `claude-sonnet-4-6`, `gpt-4o`) |
| `--model-key <key>` | `AI_API_KEY` | AI provider API key (not required for Claude models) |
| `--model-url <url>` | `AI_BASE_URL` | Base URL for OpenAI-compatible APIs |
| `--headless` | `MULTIPLAYER_HEADLESS=true` | Run without TUI — outputs structured JSON logs |
| `--profile <name>` | `MULTIPLAYER_PROFILE` | Config profile to load (default: `default`) |
| `--name <name>` | `MULTIPLAYER_AGENT_NAME` | Agent name (defaults to hostname) |
| `--max-concurrent <n>` | `MULTIPLAYER_MAX_CONCURRENT` | Max issues resolved in parallel (default: `2`) |
| `--no-git-branch` | `MULTIPLAYER_NO_GIT_BRANCH=true` | Work in current branch — no worktree, no push |
| `--health-port <port>` | `MULTIPLAYER_HEALTH_PORT` | HTTP health check port (headless mode only) |
| `--url <url>` | `MULTIPLAYER_URL` | Multiplayer API base URL |

### TUI mode (default)

An interactive terminal dashboard that shows active sessions and live logs.

```sh
multiplayer --api-key <key> --dir /path/to/repo --model claude-sonnet-4-6
```

### Headless mode

Outputs newline-delimited JSON logs — suitable for CI, containers, and log aggregators.

```sh
multiplayer --headless --api-key <key> --dir /path/to/repo --model claude-sonnet-4-6
```

In headless mode, `SIGTERM` waits for active sessions to finish before exiting; `SIGINT` exits immediately.

### Config files

Configuration is split across two JSON files:

**`~/.multiplayer/credentials.json`** — authentication, one entry per account (keyed by email):

```json
{
  "you@example.com": {
    "apiKey": "<your-api-key>",
    "authType": "api_key",
    "url": "https://api.multiplayer.app"
  }
}
```

**`<project-dir>/.multiplayer/settings.json`** — per-project settings:

```json
{
  "model": "claude-sonnet-4-6",
  "maxConcurrentIssues": 2,
  "noGitBranch": false,
  "git": {
    "commit": true,
    "branch_create": true,
    "pr_create": true,
    "push": true,
    "use_worktree": true
  }
}
```

Supported project settings keys:

| Key | Description |
|-----|-------------|
| `model` | AI model name |
| `modelKey` | AI provider API key |
| `modelUrl` | Base URL for OpenAI-compatible APIs |
| `name` | Agent name |
| `maxConcurrentIssues` | Max parallel issues |
| `noGitBranch` | `true` to skip branch/worktree creation |
| `git.commit` | Allow committing changes |
| `git.branch_create` | Allow creating branches |
| `git.pr_create` | Allow opening pull requests |
| `git.push` | Allow pushing to remote |
| `git.use_worktree` | Use git worktrees for isolation |

---

## Auth

```sh
multiplayer auth login    # Log in via browser OAuth flow
multiplayer auth logout   # Log out and clear stored credentials
multiplayer auth status   # Check current authentication status
```

---

## Releases

```sh
multiplayer releases create [options]
```

| Flag | Env var | Description |
|------|---------|-------------|
| `--api-key <key>` | `MULTIPLAYER_API_KEY` | Multiplayer API key |
| `--service <name>` | `SERVICE_NAME` | Service name |
| `--release-version <version>` | `RELEASE` | Release version |
| `--commit-hash <hash>` | `COMMIT_HASH` | Commit hash |
| `--repository-url <url>` | `REPOSITORY_URL` | Repository URL |
| `--release-notes <notes>` | `RELEASE_NOTES` | Release notes (optional) |
| `--base-url <url>` | `BASE_URL` | API base URL (optional) |

**Example:**

```sh
multiplayer releases create \
  --api-key $MULTIPLAYER_API_KEY \
  --service my-service \
  --release-version 1.2.3 \
  --commit-hash abc123 \
  --repository-url https://github.com/org/repo
```

---

## Deployments

```sh
multiplayer deployments create [options]
```

| Flag | Env var | Description |
|------|---------|-------------|
| `--api-key <key>` | `MULTIPLAYER_API_KEY` | Multiplayer API key |
| `--service <name>` | `SERVICE_NAME` | Service name |
| `--release <version>` | `RELEASE` | Release version |
| `--environment <name>` | `ENVIRONMENT` | Environment name |
| `--base-url <url>` | `BASE_URL` | API base URL (optional) |

**Example:**

```sh
multiplayer deployments create \
  --api-key $MULTIPLAYER_API_KEY \
  --service my-service \
  --release 1.2.3 \
  --environment production
```

---

## Sourcemaps

```sh
multiplayer sourcemaps upload <directories...> [options]
```

| Flag | Env var | Description |
|------|---------|-------------|
| `--api-key <key>` | `MULTIPLAYER_API_KEY` | Multiplayer API key |
| `--service <name>` | `SERVICE_NAME` | Service name |
| `--release <version>` | `RELEASE` | Release version |
| `--base-url <url>` | `BASE_URL` | API base URL (optional) |

**Example:**

```sh
multiplayer sourcemaps upload ./dist ./build \
  --api-key $MULTIPLAYER_API_KEY \
  --service my-service \
  --release 1.2.3
```

---

## MCP Server

`multiplayer mcp` starts an [MCP](https://modelcontextprotocol.io) server over stdio, exposing Multiplayer operations as tools that AI agents (Claude Desktop, Claude Code, Cursor, etc.) can call directly.

### Tools

| Tool | Description |
|------|-------------|
| `create_release` | Register a release for a service |
| `create_deployment` | Deploy a release to an environment |
| `upload_sourcemaps` | Upload `.map` files from local directories |

### Setup

Add the server to your MCP client config. Example for Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "multiplayer": {
      "command": "multiplayer",
      "args": ["mcp"],
      "env": {
        "MULTIPLAYER_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

Example for Claude Code (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "multiplayer": {
      "command": "multiplayer",
      "args": ["mcp"],
      "env": {
        "MULTIPLAYER_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

Once configured, the AI can create releases, deployments, and upload sourcemaps without any shell commands or manual steps.

## License

MIT — see [LICENSE](./LICENSE).
