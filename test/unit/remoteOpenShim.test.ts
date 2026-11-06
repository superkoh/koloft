import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { REMOTE_OPEN_SHIM } from '../../src/main/openShimScript'
import { REMOTE_AGENT_SHIM } from '../../src/main/agentShim'

let home: string
let cwd: string
let binDir: string
let realOpenDir: string
let hookDir: string

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-rmopen-')))
  cwd = path.join(home, 'repo')
  fs.mkdirSync(cwd)
  fs.writeFileSync(path.join(cwd, 'page.html'), '<h1>page</h1>\n')
  binDir = path.join(home, '.koloft', 'm-1', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, 'open'), REMOTE_OPEN_SHIM, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'koloft'), REMOTE_AGENT_SHIM, { mode: 0o755 })
  realOpenDir = path.join(home, 'real')
  fs.mkdirSync(realOpenDir)
  fs.writeFileSync(
    path.join(realOpenDir, 'open'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$OPEN_OUT"\n',
    {
      mode: 0o755
    }
  )
  hookDir = path.join(home, '.koloft', 'hook-sessions')
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function runShim(
  args: string[],
  tabId = 'tab-1'
): { stdout: string; requests: unknown[]; realArgs: string[] | null } {
  const openOut = path.join(home, 'open-out')
  const res = spawnSync(path.join(binDir, 'open'), args, {
    cwd,
    env: {
      HOME: home,
      PATH: [binDir, realOpenDir, '/usr/bin', '/bin'].join(':'),
      PWD: cwd,
      KOLOFT_TAB_ID: tabId,
      OPEN_OUT: openOut
    },
    encoding: 'utf8',
    timeout: 5000
  })
  expect(res.status).toBe(0)
  const requests = fs.existsSync(hookDir)
    ? fs.readdirSync(hookDir).map((f) => JSON.parse(fs.readFileSync(path.join(hookDir, f), 'utf8')))
    : []
  const realArgs = fs.existsSync(openOut)
    ? fs.readFileSync(openOut, 'utf8').split('\n').filter(Boolean)
    : null
  return { stdout: res.stdout, requests, realArgs }
}

describe('open on a remote machine', () => {
  it('leaves a koloft open request for a viewable file, by its full path there, that wants no answer, and returns at once without running the real open', () => {
    expect(runShim(['page.html'])).toEqual({
      stdout: '',
      requests: [
        expect.objectContaining({
          tabId: 'tab-1',
          reply: false,
          argv: ['open', path.join(cwd, 'page.html')]
        })
      ],
      realArgs: null
    })
  })

  it('leaves the same request for an http page', () => {
    expect(runShim(['http://localhost:5173/a']).requests).toEqual([
      expect.objectContaining({ reply: false, argv: ['open', 'http://localhost:5173/a'] })
    ])
  })

  it('outside a Koloft tab it hands the call to the real open', () => {
    expect(runShim(['page.html'], '')).toEqual({
      stdout: '',
      requests: [],
      realArgs: ['page.html']
    })
  })
})
