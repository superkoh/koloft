import { app } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { REMOTE_PATH_LINE } from './remote/install'
import { AGY_COST_ENV } from './agyHooks'

// CC§6
export interface StatusLineSetting {
  type: 'command'
  command: string
  padding: number
}

export interface StatuslinePaths {
  wrapper: string
  config: string
}

// CC§6
export const DEFAULT_THEME = {
  version: 3,
  lines: [
    [
      {
        id: 'd2f479ac-df95-42cd-b7a4-1159d9afdfd4',
        type: 'custom-command',
        backgroundColor: 'bgBrightMagenta',
        commandPath: 'echo $ANT_ACCOUNT'
      },
      { id: '6edf5b07-78f9-4bf8-bc6f-d6b0b235c90d', type: 'context-percentage' },
      { id: '1d0acad2-a059-406f-810d-0ab46929d34d', type: 'git-changes' },
      {
        id: 'b329fb24-6efe-4f8d-b6ec-e9375fc1246c',
        type: 'git-branch',
        backgroundColor: 'bgBrightCyan'
      },
      {
        id: 'cdf12122-7c89-4d9d-80cf-3f342232f59d',
        type: 'git-worktree',
        backgroundColor: 'bgBrightBlue'
      }
    ],
    [
      { id: 'c2bac7fd-4ed4-4c7b-a07b-42de719cb731', type: 'version' },
      { id: 'caf386ef-9bb2-4a6b-84f1-f02ff9292b43', type: 'model' },
      { id: '5a7c1e02-3b6d-4f8e-9c21-7d0e4b9a6f13', type: 'thinking-effort' },
      { id: '2d3200c7-33ee-40c8-9910-76db5eb917c9', type: 'session-cost' },
      {
        id: 'c789245c-7aca-443c-9606-047a87f4f5d6',
        type: 'git-review',
        backgroundColor: 'bgYellow'
      }
    ],
    [
      {
        id: '3eb24189-c494-4770-8af8-07046a1c1948',
        type: 'current-working-dir',
        metadata: { abbreviateHome: 'true' }
      }
    ]
  ],
  flexMode: 'full',
  compactThreshold: 60,
  colorLevel: 2,
  defaultPadding: ' ',
  inheritSeparatorColors: false,
  globalBold: true,
  gitCacheTtlSeconds: 5,
  minimalistMode: true,
  powerline: {
    enabled: true,
    separators: [''],
    separatorInvertBackground: [false],
    startCaps: [],
    endCaps: [''],
    theme: 'nord-aurora',
    autoAlign: false,
    continueThemeAcrossLines: true
  }
}

// PLATFORM§4
export function unpackedModulePath(...parts: string[]): string {
  const raw = path.resolve(__dirname, '..', '..', 'node_modules', ...parts)
  return app.isPackaged
    ? raw.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    : raw
}

export function bundlePath(): string {
  return unpackedModulePath('ccstatusline', 'dist', 'ccstatusline.js')
}

// ADR-0004
export function perInstallHash(): string {
  return crypto.createHash('sha256').update(process.execPath).digest('hex').slice(0, 10)
}

function perInstallWrapperName(): string {
  return `run-${perInstallHash()}.sh`
}

export const EXEC_MARKER = '# koloft-exec: '

interface WrapperParts {
  head: string
  node: string
  bundle: string
  config: string
  cacheDir: string
}

function wrapperScript(p: WrapperParts): string {
  return `#!/usr/bin/env bash
${p.head}
# PLATFORM§36
export NODE_COMPILE_CACHE=${p.cacheDir}
# CC§6 PLATFORM§36
[ -n "$COLUMNS" ] && export CCSTATUSLINE_WIDTH="$COLUMNS"
# CC§6 PLATFORM§2 PLATFORM§36
${p.node} ${p.bundle} --config ${p.config} <&0 &
pid=$!
( sleep 10; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 & wd=$!
wait "$pid"; rc=$?
kill "$wd" 2>/dev/null
exit $rc
`
}

function localWrapperScript(config: string, cacheDir: string): string {
  return wrapperScript({
    head: `${EXEC_MARKER}${process.execPath}\nexport ELECTRON_RUN_AS_NODE=1`,
    node: shq(process.execPath),
    bundle: shq(bundlePath()),
    config: shq(config),
    cacheDir: shq(cacheDir)
  })
}

export function remoteWrapperScript(): string {
  return wrapperScript({
    head: `${REMOTE_PATH_LINE}
D="$(cd "$(dirname "$0")" && pwd)"
node="$HOME/.koloft/node/bin/node"
[ -x "$node" ] || node="$(command -v node 2>/dev/null)"
[ -n "$node" ] || exit 0`,
    node: '"$node"',
    bundle: '"$D/ccstatusline.js"',
    config: '"$D/theme.json"',
    cacheDir: '"$HOME/.koloft/vcache"'
  })
}

// ADR-0004
export function pruneDeadInstalls(
  dir: string,
  keep: string,
  markerFile: (entry: string) => string | undefined
): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const full = path.join(dir, name)
    const file = name === keep ? undefined : markerFile(full)
    if (!file) continue
    try {
      const marker = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .find((l) => l.startsWith(EXEC_MARKER))
      if (marker && !fs.existsSync(marker.slice(EXEC_MARKER.length))) {
        fs.rmSync(full, { recursive: true, force: true })
      }
    } catch {}
  }
}

function pruneDeadWrappers(dir: string, keep: string): void {
  pruneDeadInstalls(dir, keep, (entry) =>
    /^run-[0-9a-f]+\.sh$/.test(path.basename(entry)) ? entry : undefined
  )
}

export function setupStatusline(): StatuslinePaths {
  const dir = path.join(app.getPath('userData'), 'statusline')
  const cacheDir = path.join(dir, 'vcache')
  fs.mkdirSync(cacheDir, { recursive: true })

  const config = path.join(dir, 'settings.json')
  fs.writeFileSync(config, JSON.stringify(DEFAULT_THEME, null, 2))

  const name = perInstallWrapperName()
  const wrapper = path.join(dir, name)
  fs.writeFileSync(wrapper, localWrapperScript(config, cacheDir), { mode: 0o755 })
  fs.chmodSync(wrapper, 0o755)
  pruneDeadWrappers(dir, name)

  return { wrapper, config }
}

// AGY§11
const AGY_STATUSLINE_JS = `const fs = require('fs')
const { spawnSync } = require('child_process')
const [bundle, config] = process.argv.slice(2)
let input = {}
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}
if (!input.model) process.exit(0)
let cost
try {
  cost = Number(fs.readFileSync(process.env.${AGY_COST_ENV}, 'utf8'))
} catch {}
if (Number.isFinite(cost)) input.cost = { ...(input.cost || {}), total_cost_usd: cost }
const run = spawnSync(process.execPath, [bundle, '--config', config], {
  input: JSON.stringify(input),
  stdio: ['pipe', 'inherit', 'inherit']
})
process.exit(run.status ?? 0)
`

export function setupAgyStatusline(paths: StatuslinePaths): string {
  const dir = path.dirname(paths.wrapper)
  const script = path.join(dir, 'agy-statusline.js')
  fs.writeFileSync(script, AGY_STATUSLINE_JS)
  const wrapper = path.join(dir, `agy-${path.basename(paths.wrapper)}`)
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
${EXEC_MARKER}${process.execPath}
export ELECTRON_RUN_AS_NODE=1
[ -n "$COLUMNS" ] && export CCSTATUSLINE_WIDTH="$COLUMNS"
exec ${shq(process.execPath)} ${shq(script)} ${shq(bundlePath())} ${shq(paths.config)}
`,
    { mode: 0o755 }
  )
  return `/bin/bash ${shq(wrapper)}`
}

// CC§6
export function statusLineSetting(paths: StatuslinePaths): StatusLineSetting {
  return { type: 'command', command: shq(paths.wrapper), padding: 0 }
}
