import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import {
  bundlePath,
  remoteWrapperScript,
  DEFAULT_THEME,
  writeStatuslineMod
} from '../../src/main/statusline'

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

const MOD_SOURCE = path.join(__dirname, '..', '..', 'src', 'main', 'statuslineMod')
const MOD_FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx']

describe('the statusline mod on disk', () => {
  let userData: string

  beforeAll(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-statusline-mod-'))
  })
  afterAll(() => fs.rmSync(userData, { recursive: true, force: true }))

  it('lays out the plugin folder claude loads, file for file', () => {
    const dir = writeStatuslineMod(userData)
    for (const rel of MOD_FILES)
      expect(fs.readFileSync(path.join(dir, rel), 'utf8')).toBe(
        fs.readFileSync(path.join(MOD_SOURCE, rel), 'utf8')
      )
  })

  // CC§16 ADR-0004
  it('leaves an unchanged file untouched and puts back a changed one — claude reloads the mod in every live session on any write', () => {
    const dir = writeStatuslineMod(userData)
    const register = path.join(dir, 'hooks', 'register.tsx')
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json')
    const longAgo = new Date(2000, 0, 1)
    fs.utimesSync(manifest, longAgo, longAgo)
    fs.writeFileSync(register, 'edited elsewhere')
    writeStatuslineMod(userData)
    expect(fs.statSync(manifest).mtime.getTime()).toBe(longAgo.getTime())
    expect(fs.readFileSync(register, 'utf8')).toBe(
      fs.readFileSync(path.join(MOD_SOURCE, 'hooks', 'register.tsx'), 'utf8')
    )
  })
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

  it('renders the real bundle to ANSI lines, with no orphaned watchdog holding stdout open', () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-remote-sl-real-'))
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-remote-home-real-'))
    try {
      fs.writeFileSync(path.join(realDir, 'run.sh'), remoteWrapperScript(), { mode: 0o755 })
      fs.copyFileSync(bundlePath(), path.join(realDir, 'ccstatusline.js'))
      fs.writeFileSync(path.join(realDir, 'package.json'), '{"type":"module"}')
      fs.writeFileSync(path.join(realDir, 'theme.json'), JSON.stringify(DEFAULT_THEME))
      const bin = path.join(realHome, '.koloft', 'node', 'bin')
      fs.mkdirSync(bin, { recursive: true })
      fs.symlinkSync(process.execPath, path.join(bin, 'node'))
      const started = Date.now()
      const res = spawnSync('/bin/bash', [path.join(realDir, 'run.sh')], {
        input: PAYLOAD,
        encoding: 'utf8',
        // CC§6
        env: { HOME: realHome, PATH: '/usr/bin:/bin', COLUMNS: '120' },
        timeout: 25_000
      })
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('[')
      // CC§6
      expect(Date.now() - started).toBeLessThan(8000)
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true })
      fs.rmSync(realHome, { recursive: true, force: true })
    }
  }, 30_000)
})
