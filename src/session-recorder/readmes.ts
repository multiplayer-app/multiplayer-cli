/**
 * SDK integration READMEs embedded as strings.
 *
 * Files in readme-content/ are fetched from GitHub by scripts/fetch-readmes.ts
 * before each build and bundled into the compiled binary by Bun.
 *
 * To update: run `bun run scripts/fetch-readmes.ts` then rebuild.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTENT_DIR = path.join(__dirname, 'readme-content')

function read(file: string): string {
  try {
    return fs.readFileSync(path.join(CONTENT_DIR, file), 'utf-8')
  } catch {
    return `(README not available: run scripts/fetch-readmes.ts before building)`
  }
}

// ─── Embedded READMEs ────────────────────────────────────────────────────────

const README_REACT = read('react.md')
const README_BROWSER = read('browser.md')
const README_NODE = read('node.md')
const README_REACT_NATIVE = read('react-native.md')
const README_ANGULAR = read('angular.md')
const README_VUE = read('vue.md')

// ─── Lookup by SDK + framework ───────────────────────────────────────────────

export function getReadmeContent(sdkPackage: string, framework: string): string {
  // Framework-specific overrides
  if (framework === 'angular') return README_ANGULAR
  if (framework === 'vue' || framework === 'nuxt') return README_VUE

  // SDK-level defaults
  switch (sdkPackage) {
    case '@multiplayer-app/session-recorder-react':
      return README_REACT
    case '@multiplayer-app/session-recorder-react-native':
      return README_REACT_NATIVE
    case '@multiplayer-app/session-recorder-node':
      return README_NODE
    case '@multiplayer-app/session-recorder-browser':
      return README_BROWSER
    default:
      // Non-JS SDKs — use browser README as best available reference
      return README_BROWSER
  }
}
