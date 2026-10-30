import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { REMOTE_OPEN_SHIM } from '../../src/main/openShimScript'

let base: string
let cwd: string
let binDir: string
let realOpenDir: string

const RECORD_ARGS = (out: string): string =>
  `#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$${out}"\nexit 0\n`

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-rmopen-')))
  cwd = path.join(base, 'repo')
  fs.mkdirSync(cwd)
  fs.writeFileSync(path.join(cwd, 'page.html'), '<h1>page</h1>\n')
  fs.writeFileSync(path.join(cwd, 'data.xyz'), 'nope\n')
  binDir = path.join(base, 'bin')
  fs.mkdirSync(binDir)
  fs.writeFileSync(path.join(binDir, 'open'), REMOTE_OPEN_SHIM, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'koloft'), RECORD_ARGS('KOLOFT_OUT'), { mode: 0o755 })
  realOpenDir = path.join(base, 'real')
  fs.mkdirSync(realOpenDir)
  fs.writeFileSync(path.join(realOpenDir, 'open'), RECORD_ARGS('OPEN_OUT'), { mode: 0o755 })
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

function runShim(
  args: string[],
  tabId = 'tab-1'
): { koloftArgs: string[] | null; realArgs: string[] | null } {
  const koloftOut = path.join(base, 'koloft-out')
  const openOut = path.join(base, 'open-out')
  fs.rmSync(koloftOut, { force: true })
  fs.rmSync(openOut, { force: true })
  const res = spawnSync(path.join(binDir, 'open'), args, {
    cwd,
    env: {
      PATH: [binDir, realOpenDir, '/usr/bin', '/bin'].join(':'),
      PWD: cwd,
      KOLOFT_TAB_ID: tabId,
      KOLOFT_OUT: koloftOut,
      OPEN_OUT: openOut
    },
    encoding: 'utf8'
  })
  expect(res.status).toBe(0)
  const read = (f: string): string[] | null =>
    fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : null
  return { koloftArgs: read(koloftOut), realArgs: read(openOut) }
}

describe('open shim on a remote machine', () => {
  it('hands a viewable file to koloft open by its full path on the machine, and never runs the real open', () => {
    expect(runShim(['page.html'])).toEqual({
      koloftArgs: ['open', path.join(cwd, 'page.html')],
      realArgs: null
    })
  })

  it('hands an http page to koloft open the same way', () => {
    expect(runShim(['http://localhost:5173/a'])).toEqual({
      koloftArgs: ['open', 'http://localhost:5173/a'],
      realArgs: null
    })
  })

  it('passes anything it does not show, and every call outside a Koloft tab, to the real open with the exact arguments', () => {
    for (const args of [['data.xyz'], ['-a', 'Safari', 'page.html'], ['missing.html']])
      expect(runShim(args), args.join(' ')).toEqual({ koloftArgs: null, realArgs: args })
    expect(runShim(['page.html'], '')).toEqual({ koloftArgs: null, realArgs: ['page.html'] })
  })
})
