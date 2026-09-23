import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-statusline-'))
  return {
    app: {
      getPath: () => base,
      isPackaged: false
    }
  }
})

import os from 'os'
import {
  setupStatusline,
  statusLineSetting,
  remoteWrapperScript,
  DEFAULT_THEME
} from '../../src/main/statusline'

let wrapper: string
let config: string

beforeAll(() => {
  ;({ wrapper, config } = setupStatusline())
})
afterAll(() => fs.rmSync(path.dirname(path.dirname(wrapper)), { recursive: true, force: true }))

const PAYLOAD = JSON.stringify({
  hook_event_name: 'Status',
  session_id: 'sess-statusline-unit',
  transcript_path: '/tmp/does-not-exist.jsonl',
  cwd: '/tmp',
  model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
  workspace: { current_dir: '/tmp', project_dir: '/tmp', added_dirs: [] },
  version: '2.1.224',
  cost: {
    total_cost_usd: 0.01234,
    total_duration_ms: 45000,
    total_api_duration_ms: 2300,
    total_lines_added: 156,
    total_lines_removed: 23
  },
  context_window: {
    total_input_tokens: 50113,
    total_output_tokens: 10462,
    context_window_size: 200000,
    current_usage: {
      input_tokens: 8500,
      output_tokens: 1200,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 2000
    },
    used_percentage: 8,
    remaining_percentage: 92
  }
})

describe('built-in statusline', () => {
  it('rewrites the theme on every start, so an upgrade always reaches an existing install and an outside edit is put back', () => {
    const theme = JSON.parse(fs.readFileSync(config, 'utf8'))
    expect(theme.version).toBe(3)
    expect(theme.powerline.theme).toBe('nord-aurora')
    expect(theme.globalBold).toBe(true)
    fs.writeFileSync(config, JSON.stringify({ ...theme, globalBold: false }))
    setupStatusline()
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual(theme)
  })

  it('regenerates an executable wrapper with absolute paths baked in, stdin re-attached to the backgrounded render and a watchdog for a render hung on stdin', () => {
    expect(fs.statSync(wrapper).mode & 0o755).toBe(0o755)
    const script = fs.readFileSync(wrapper, 'utf8')
    expect(script).toContain(process.execPath)
    expect(script).toContain(`--config '${config}'`)
    expect(script).toContain(path.join('node_modules', 'ccstatusline', 'dist', 'ccstatusline.js'))
    expect(script).toContain('<&0 &')
    expect(script).toMatch(/sleep 10; kill/)
  })

  it('names the wrapper per install (execPath hash) — instances stop clobbering each other', () => {
    const expected = `run-${crypto.createHash('sha256').update(process.execPath).digest('hex').slice(0, 10)}.sh`
    expect(path.basename(wrapper)).toBe(expected)
    expect(fs.readFileSync(wrapper, 'utf8')).toContain(`# koloft-exec: ${process.execPath}`)
  })

  it('prunes a dead install’s wrapper; keeps a live peer’s, unprovables, and legacy run.sh', () => {
    const dir = path.dirname(wrapper)
    const dead = path.join(dir, 'run-deadbeef00.sh')
    const live = path.join(dir, 'run-aaaaaaaaaa.sh')
    const bare = path.join(dir, 'run-bbbbbbbbbb.sh')
    const legacy = path.join(dir, 'run.sh')
    fs.writeFileSync(
      dead,
      `#!/usr/bin/env bash\n# koloft-exec: ${path.join(dir, 'gone-build', 'Koloft')}\n`
    )
    const liveContent = `#!/usr/bin/env bash\n# koloft-exec: ${process.execPath}\necho peer\n`
    fs.writeFileSync(live, liveContent)
    fs.writeFileSync(bare, '#!/usr/bin/env bash\n')
    fs.writeFileSync(legacy, '#!/usr/bin/env bash\n')
    setupStatusline()
    expect(fs.existsSync(dead)).toBe(false)
    expect(fs.readFileSync(live, 'utf8')).toBe(liveContent)
    expect(fs.existsSync(bare)).toBe(true)
    expect(fs.existsSync(legacy)).toBe(true)
  })

  it('statusLineSetting is the documented claude-code shape, wrapper path shell-quoted', () => {
    const sl = statusLineSetting({ wrapper, config })
    expect(sl).toEqual({ type: 'command', command: `'${wrapper}'`, padding: 0 })
  })

  it('renders end-to-end: wrapper → node-mode binary → vendored bundle → ANSI lines, with no orphaned watchdog holding stdout open', () => {
    const started = Date.now()
    const res = spawnSync(wrapper, [], {
      input: PAYLOAD,
      encoding: 'utf8',
      // CC§6
      env: { ...process.env, COLUMNS: '120' },
      timeout: 25_000
    })
    expect(res.status).toBe(0)
    expect(res.stdout.length).toBeGreaterThan(0)
    // CC§6
    expect(Date.now() - started).toBeLessThan(8000)
    expect(res.stdout).toContain('[')
  }, 30_000)
})

describe('U-SL-1: remote statusline wrapper, run for real — a machine without node must still start its session', () => {
  let dir: string
  let home: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-remote-sl-'))
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-remote-home-'))
    fs.writeFileSync(path.join(dir, 'run.sh'), remoteWrapperScript(), { mode: 0o755 })
    fs.writeFileSync(path.join(dir, 'ccstatusline.js'), 'process.exit(0)\n')
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(DEFAULT_THEME))
  })
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  const render = (): ReturnType<typeof spawnSync> =>
    spawnSync('/bin/bash', [path.join(dir, 'run.sh')], {
      input: PAYLOAD,
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin', COLUMNS: '120' },
      timeout: 20_000
    })

  it('a machine with no node stays silent instead of failing the render', () => {
    const res = render()
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('runs the packaged bundle with the packaged theme on the node it installed', () => {
    const bin = path.join(home, '.koloft', 'node', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    const argvOut = path.join(home, 'argv.txt')
    fs.writeFileSync(
      path.join(bin, 'node'),
      `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "$@" > '${argvOut}'\nexit 0\n`,
      { mode: 0o755 }
    )
    const res = render()
    expect(res.status).toBe(0)
    const argv = fs.readFileSync(argvOut, 'utf8').trim().split('\n')
    expect(argv).toEqual([
      path.join(dir, 'ccstatusline.js'),
      '--config',
      path.join(dir, 'theme.json')
    ])
  })
})
