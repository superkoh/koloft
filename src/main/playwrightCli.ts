import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { EXEC_MARKER, perInstallHash, unpackedModulePath } from './statusline'

// PLATFORM§42
const LAUNCHER = `const path = require('path')
process.defaultApp = true
process.execPath = path.join(__dirname, 'node')
process.argv.splice(1, 1)
require(process.argv[1])
`

function nodeScript(dir: string): string {
  return `#!/bin/sh
${EXEC_MARKER}${process.execPath}
ELECTRON_RUN_AS_NODE=1 exec ${shq(process.execPath)} ${shq(path.join(dir, 'launcher.cjs'))} "$@"
`
}

function cliScript(dir: string): string {
  return `#!/bin/sh
NO_UPDATE_NOTIFIER=1 exec ${shq(path.join(dir, 'node'))} ${shq(unpackedModulePath('@playwright', 'cli', 'playwright-cli.js'))} "$@"
`
}

function writeExecutable(file: string, text: string): void {
  fs.writeFileSync(file, text, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
}

// ADR-0004
function pruneDeadInstalls(root: string, keep: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (name === keep) continue
    const dir = path.join(root, name)
    try {
      const marker = fs
        .readFileSync(path.join(dir, 'node'), 'utf8')
        .split('\n')
        .find((l) => l.startsWith(EXEC_MARKER))
      if (marker && !fs.existsSync(marker.slice(EXEC_MARKER.length)))
        fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

export function setupPlaywrightCli(): string {
  const root = path.join(app.getPath('userData'), 'playwright-cli')
  const name = perInstallHash()
  const dir = path.join(root, name)
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(dir, 'launcher.cjs'), LAUNCHER)
  writeExecutable(path.join(dir, 'node'), nodeScript(dir))
  writeExecutable(path.join(bin, 'playwright-cli'), cliScript(dir))
  pruneDeadInstalls(root, name)
  return bin
}
