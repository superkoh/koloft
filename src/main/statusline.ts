import fs from 'fs'
import path from 'path'
import { REMOTE_PATH_LINE } from './remote/install'
import modManifest from './statuslineMod/.claude-plugin/plugin.json?raw'
import modHooks from './statuslineMod/hooks/hooks.json?raw'
import modRegister from './statuslineMod/hooks/register.tsx?raw'

// CC§6
export interface StatusLineSetting {
  type: 'command'
  command: string
  padding: number
}

// CC§16
export const HIDES_THE_USERS_OWN_STATUS_LINE: StatusLineSetting = {
  type: 'command',
  command: 'true',
  padding: 0
}

const STATUSLINE_MOD_FILES: Record<string, string> = {
  '.claude-plugin/plugin.json': modManifest,
  'hooks/hooks.json': modHooks,
  'hooks/register.tsx': modRegister
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// CC§16 ADR-0004
export function writeStatuslineMod(userData: string): string {
  const dir = path.join(userData, 'statusline-mod')
  for (const [rel, text] of Object.entries(STATUSLINE_MOD_FILES)) {
    const file = path.join(dir, rel)
    if (readOrNull(file) === text) continue
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  return dir
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

export function bundlePath(): string {
  return path.resolve(
    __dirname,
    '..',
    '..',
    'node_modules',
    'ccstatusline',
    'dist',
    'ccstatusline.js'
  )
}

export function remoteWrapperScript(): string {
  return `#!/usr/bin/env bash
${REMOTE_PATH_LINE}
D="$(cd "$(dirname "$0")" && pwd)"
node="$HOME/.koloft/node/bin/node"
[ -x "$node" ] || node="$(command -v node 2>/dev/null)"
[ -n "$node" ] || exit 0
# PLATFORM§36
export NODE_COMPILE_CACHE="$HOME/.koloft/vcache"
# CC§6 PLATFORM§36
[ -n "$COLUMNS" ] && export CCSTATUSLINE_WIDTH="$COLUMNS"
# CC§6 PLATFORM§2 PLATFORM§36
"$node" "$D/ccstatusline.js" --config "$D/theme.json" <&0 &
pid=$!
( sleep 10; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 & wd=$!
wait "$pid"; rc=$?
kill "$wd" 2>/dev/null
exit $rc
`
}
