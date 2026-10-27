import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { EXEC_MARKER, perInstallHash, pruneDeadInstalls, unpackedModulePath } from './statusline'

// PLATFORM§42
const LAUNCHER = `const path = require('path')
process.defaultApp = true
process.execPath = path.join(__dirname, 'node')
process.argv.splice(1, 1)
require(process.argv[1])
`

// PLATFORM§36 PLATFORM§42
function nodeScript(dir: string): string {
  return `#!/bin/sh
${EXEC_MARKER}${process.execPath}
export NODE_COMPILE_CACHE=${shq(path.join(dir, 'vcache'))}
ELECTRON_RUN_AS_NODE=1 exec ${shq(process.execPath)} ${shq(path.join(dir, 'launcher.cjs'))} "$@"
`
}

// PLATFORM§17
function cliScript(dir: string): string {
  return `#!/bin/sh
NO_UPDATE_NOTIFIER=1 exec ${shq(path.join(dir, 'node'))} ${shq(unpackedModulePath('@playwright', 'cli', 'playwright-cli.js'))} "$@"
`
}

export function writeExecutable(file: string, text: string): void {
  fs.rmSync(file, { force: true })
  fs.writeFileSync(file, text, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
}

export function setupPlaywrightCli(): string {
  const root = path.join(app.getPath('userData'), 'commands')
  const name = perInstallHash()
  const dir = path.join(root, name)
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(dir, 'vcache'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'launcher.cjs'), LAUNCHER)
  writeExecutable(path.join(dir, 'node'), nodeScript(dir))
  writeExecutable(path.join(bin, 'playwright-cli'), cliScript(dir))
  pruneDeadInstalls(root, name, (entry) => path.join(entry, 'node'))
  return bin
}
