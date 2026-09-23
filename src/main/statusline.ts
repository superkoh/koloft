import { app } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { REMOTE_PATH_LINE } from './remote/install'

/** the value injected under `statusLine` in a tab's `--settings` file. The CLI-args
 *  settings tier outranks the user's own statusLine and merges per key, so this
 *  overrides ~/.claude/settings.json without touching anything else in it. */
export interface StatusLineSetting {
  type: 'command'
  command: string
  padding: number
}

export interface StatuslinePaths {
  /** the wrapper script injected as `statusLine.command` */
  wrapper: string
  /** Koloft's ccstatusline theme (rewritten on every start, like the wrapper) */
  config: string
}

/**
 * V1 default theme — verbatim snapshot of the author's ccstatusline config
 *. Three powerline lines:
 * account · context% · git ± / branch / worktree — version · model · effort ·
 * cost · PR review — cwd. The effort segment reads `effort.level` straight from
 * CC's status JSON (contract §6), so it always shows the level THIS session runs
 * at. The account segment reads $ANT_ACCOUNT, which the claude shim exports with
 * the account the multi-account balancer picked for this launch (inherited claude
 * → statusline subprocess); it renders empty when balancing is off and nothing
 * else set the tag. Powerline glyphs need a patched font — Koloft's
 * default terminal font stack already leads with Nerd Fonts.
 */
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

/** The vendored single-file ccstatusline bundle. Resolved relative to the compiled
 *  main bundle (out/main/ → ../../node_modules), NOT via app.getAppPath(): a bare
 *  `electron out/main/index.js` launch (how the e2e suite starts the app) reports
 *  out/main as the app path and the join would point nowhere. An EXTERNAL bash
 *  process must read the file, so a packaged build swaps in the asarUnpack'd copy —
 *  nothing outside Electron can open files inside the asar archive. (The sibling
 *  package.json ships too: the bundle is ESM and node discovers "type":"module"
 *  from it.) */
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

/** One wrapper file PER INSTALL, named by execPath hash. A single shared run.sh was
 *  last-writer-wins: any same-userData instance (a worktree's release build under
 *  test, say) rewrote it with its own baked paths on startup, and once that build's
 *  directory was deleted every render in every OTHER instance exited 127 — the
 *  statusline went blank app-wide. Distinct names end the clobbering; a tab always
 *  points at the wrapper of the instance that created it, and a pty session can't
 *  outlive its instance, so that wrapper's baked binary is alive for as long as
 *  anything renders through it. */
function wrapperName(): string {
  return `run-${crypto.createHash('sha256').update(process.execPath).digest('hex').slice(0, 10)}.sh`
}

/** the marker line pruning reads to tell a dead install's wrapper from a live one */
const EXEC_MARKER = '# koloft-exec: '

/** What differs between the two places the wrapper runs: how it finds node, where the
 *  bundle and theme sit. Every value is already shell-quoted (or a `"$var"` reference). */
interface WrapperParts {
  /** lines before the render: the local one bakes the binary, the remote one finds node */
  head: string
  node: string
  bundle: string
  config: string
  cacheDir: string
}

function wrapperScript(p: WrapperParts): string {
  return `#!/usr/bin/env bash
# koloft statusline wrapper — renders the vendored ccstatusline with Koloft's theme
# (CC protocol: docs/claude-code-contract.md §6). Claude Code pipes its status JSON to stdin
# and renders our stdout under the prompt.
${p.head}
# parsing the 3.1MB bundle dominates render cost — cache the compiled modules
export NODE_COMPILE_CACHE=${p.cacheDir}
# ccstatusline sizes flex layouts from CCSTATUSLINE_WIDTH alone (its stdout is a
# pipe, not a tty); Claude Code ≥2.1.153 exports COLUMNS before running us
[ -n "$COLUMNS" ] && export CCSTATUSLINE_WIDTH="$COLUMNS"
# <&0 is load-bearing: a non-interactive bash gives a background job /dev/null
# stdin, which would render an empty payload. Backgrounding exists purely for the
# watchdog: ccstatusline (upstream #485) never exits while stdin stays open, and
# Claude Code sometimes holds it — kill a hung render instead of leaving a zombie.
# rc≠0 blanks that render, exactly what the hang would have displayed anyway.
#
# The watchdog MUST NOT inherit our stdout: Claude Code treats pipe EOF as "render
# done", and the subshell's orphaned sleep would keep the write end open for the
# full 10s — statusline appears ~10s late on every render (the sleep survives the
# kill of its parent subshell; detached from the pipe it lingers harmlessly).
${p.node} ${p.bundle} --config ${p.config} <&0 &
pid=$!
( sleep 10; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 & wd=$!
wait "$pid"; rc=$?
kill "$wd" 2>/dev/null
exit $rc
`
}

/** The wrapper this install runs: Koloft's own binary in node mode, with absolute
 *  paths baked in on every start, so the machine needs no node install of its own. */
function localWrapperScript(config: string, cacheDir: string): string {
  return wrapperScript({
    head: `${EXEC_MARKER}${process.execPath}\nexport ELECTRON_RUN_AS_NODE=1`,
    node: shq(process.execPath),
    bundle: shq(bundlePath()),
    config: shq(config),
    cacheDir: shq(cacheDir)
  })
}

/** The wrapper pushed to a remote machine next to the bundle and theme (run.sh in
 *  the machine package). node is the private one ensure.sh installs, else the
 *  machine's own; with neither the render exits 0 and the statusline stays blank —
 *  a session must never fail for want of a statusline. */
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

/** Sweep sibling wrappers whose baked binary no longer exists. Deliberately NOT
 *  age-based: a concurrent peer instance may have started days ago and still be
 *  live, and deleting its wrapper would blank its statuslines — the very bug the
 *  per-install naming fixes. "Binary still on disk" is the only death test; an
 *  unreadable or marker-less file is left alone (can't prove it dead). The legacy
 *  shared run.sh is also left for any pre-per-install peer still overwriting it. */
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
    } catch {
      /* raced with a peer instance; ignore */
    }
  }
}

/**
 * Materialize the statusline dir under userData: the theme config and this
 * install's own wrapper. BOTH are rewritten on every start. The theme used to be
 * write-if-absent so hand edits would survive, but the product has no way to make
 * such an edit (the path is never shown), and the price was that a default-theme
 * change never reached an existing install — upgrading Koloft must upgrade the
 * statusline. The wrapper bakes absolute paths that go stale when the app moves or
 * updates; it is named per install so concurrent instances never overwrite each
 * other's — see wrapperName.
 */
export function setupStatusline(): StatuslinePaths {
  const dir = path.join(app.getPath('userData'), 'statusline')
  const cacheDir = path.join(dir, 'vcache')
  fs.mkdirSync(cacheDir, { recursive: true })

  const config = path.join(dir, 'settings.json')
  fs.writeFileSync(config, JSON.stringify(DEFAULT_THEME, null, 2))

  const name = wrapperName()
  const wrapper = path.join(dir, name)
  fs.writeFileSync(wrapper, localWrapperScript(config, cacheDir), { mode: 0o755 })
  fs.chmodSync(wrapper, 0o755)
  pruneDeadWrappers(dir, name)

  return { wrapper, config }
}

/** the object merged into each tab's `--settings` file when the built-in statusline
 *  is enabled. Claude Code runs the command through a shell, so the path is quoted
 *  ("Application Support" has a space). */
export function statusLineSetting(paths: StatuslinePaths): StatusLineSetting {
  return { type: 'command', command: shq(paths.wrapper), padding: 0 }
}
