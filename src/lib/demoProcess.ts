import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { logToTui } from './tuiSink.js'

export type DemoStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error'

export interface DemoState {
  status: DemoStatus
  url: string | null
  error: string | null
}

interface DemoProcessEvents {
  change: (state: DemoState) => void
}

const LOCAL_URL_RE = /Local:\s+(https?:\/\/\S+)/i
const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

class DemoProcessManager extends EventEmitter {
  private state: DemoState = { status: 'idle', url: null, error: null }
  private child: ChildProcess | null = null
  private dir: string | null = null

  override on<E extends keyof DemoProcessEvents>(event: E, listener: DemoProcessEvents[E]): this {
    return super.on(event, listener)
  }

  override off<E extends keyof DemoProcessEvents>(event: E, listener: DemoProcessEvents[E]): this {
    return super.off(event, listener)
  }

  getState(): DemoState {
    return this.state
  }

  start(dir: string): void {
    if (this.child) return
    this.dir = dir
    this.setState({ status: 'starting', url: null, error: null })

    const child = spawn('npm', ['run', 'dev'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      detached: process.platform !== 'win32',
    })

    this.child = child

    const onChunk = (buf: Buffer) => {
      if (this.state.url) return
      const text = stripAnsi(buf.toString('utf-8'))
      const match = LOCAL_URL_RE.exec(text)
      if (match?.[1]) {
        const url = match[1].replace(/\/+$/, '')
        this.setState({ status: 'running', url, error: null })
      }
    }

    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    child.on('error', (err) => {
      logToTui('error', `Demo dev server failed to start: ${err.message}`)
      this.child = null
      this.setState({ status: 'error', url: null, error: err.message })
    })

    child.on('exit', (code, signal) => {
      const wasCurrent = this.child === child
      if (!wasCurrent) return
      this.child = null
      if (signal === 'SIGTERM' || signal === 'SIGKILL' || code === 0 || code === null) {
        this.setState({ status: 'stopped', url: null, error: null })
      } else {
        this.setState({ status: 'error', url: null, error: `Demo dev server exited with code ${code}` })
      }
    })
  }

  stop(): void {
    const child = this.child
    if (!child) {
      if (this.state.status !== 'idle' && this.state.status !== 'stopped') {
        this.setState({ status: 'stopped', url: null, error: null })
      }
      return
    }
    this.child = null
    try {
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          child.kill('SIGTERM')
        }
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      /* best-effort */
    }
    this.setState({ status: 'stopped', url: null, error: null })
  }

  toggle(): void {
    if (this.state.status === 'running' || this.state.status === 'starting') {
      this.stop()
    } else if (this.dir) {
      this.start(this.dir)
    }
  }

  private setState(next: DemoState): void {
    this.state = next
    this.emit('change', next)
  }
}

export const demoProcess = new DemoProcessManager()

let exitHandlerInstalled = false
export function installDemoProcessExitHandler(): void {
  if (exitHandlerInstalled) return
  exitHandlerInstalled = true
  const kill = () => demoProcess.stop()
  process.on('exit', kill)
  process.on('SIGINT', kill)
  process.on('SIGTERM', kill)
}
