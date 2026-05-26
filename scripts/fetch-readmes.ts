#!/usr/bin/env bun
/**
 * Fetches SDK integration READMEs from GitHub and writes them to
 * src/session-recorder/readme-content/ so they can be bundled into the binary.
 *
 * Run manually: bun run scripts/fetch-readmes.ts
 * Run automatically: called by scripts/build.ts before compilation.
 */
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_DIR = path.join(ROOT, 'src', 'session-recorder', 'readme-content')
const GITHUB_RAW_BASE =
  'https://raw.githubusercontent.com/multiplayer-app/multiplayer-session-recorder-javascript/main'

const READMES: { file: string; repoPath: string }[] = [
  { file: 'react.md', repoPath: 'packages/session-recorder-react/README.md' },
  { file: 'browser.md', repoPath: 'packages/session-recorder-browser/README.md' },
  { file: 'node.md', repoPath: 'packages/session-recorder-node/README.md' },
  { file: 'react-native.md', repoPath: 'packages/session-recorder-react-native/README.md' },
  { file: 'angular.md', repoPath: 'packages/session-recorder-browser/examples/angular/README.md' },
  { file: 'vue.md', repoPath: 'packages/session-recorder-browser/examples/vue/README.md' },
]

fs.mkdirSync(OUT_DIR, { recursive: true })

let ok = true
for (const { file, repoPath } of READMES) {
  const url = `${GITHUB_RAW_BASE}/${repoPath}`
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`  ✗ ${file} (HTTP ${res.status}: ${url})`)
    ok = false
    continue
  }
  fs.writeFileSync(path.join(OUT_DIR, file), await res.text())
  console.log(`  ✓ ${file}`)
}

if (!ok) process.exit(1)
