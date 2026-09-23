import { app } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { REMOTE_PATH_LINE } from './remote/install'

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
export function bundlePath(): string {
  const raw = path.resolve(
    __dirname,
    '..',
    '..',
    'node_modules',
    'ccstatusline',
    'dist',
    'ccstatusline.js'
  )
  return app.isPackaged
    ? raw.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    : raw
}

// ADR-0004
function perInstallWrapperName(): string {
  return `run-${crypto.createHash('sha256').update(process.execPath).digest('hex').slice(0, 10)}.sh`
}

const EXEC_MARKER = '# koloft-exec: '

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
function pruneDeadWrappers(dir: string, keep: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name === keep || !/^run-[0-9a-f]+\.sh$/.test(name)) continue
    const full = path.join(dir, name)
    try {
      const marker = fs
        .readFileSync(full, 'utf8')
        .split('\n')
        .find((l) => l.startsWith(EXEC_MARKER))
      if (marker && !fs.existsSync(marker.slice(EXEC_MARKER.length))) {
        fs.rmSync(full, { force: true })
      }
    } catch {}
  }
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

// CC§6
export function statusLineSetting(paths: StatuslinePaths): StatusLineSetting {
  return { type: 'command', command: shq(paths.wrapper), padding: 0 }
}
