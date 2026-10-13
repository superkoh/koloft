import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-playwright-cli-'))
  return { app: { getPath: () => base, isPackaged: false } }
})

import { setupPlaywrightCli } from '../../src/main/playwrightCli'

let bin: string
let install: string
let scratch: string

beforeAll(() => {
  bin = setupPlaywrightCli()
  install = path.dirname(bin)
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-playwright-cli-run-'))
})
afterAll(() => {
  fs.rmSync(path.dirname(path.dirname(install)), { recursive: true, force: true })
  fs.rmSync(scratch, { recursive: true, force: true })
})

function json(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>
}

describe('the playwright-cli Koloft puts on a session’s PATH', () => {
  it('its folder holds only playwright-cli, so putting it on PATH shadows no other command', () => {
    expect(fs.readdirSync(bin)).toEqual(['playwright-cli'])
  })

  it('runs the bundled CLI and never asks npm for updates', () => {
    const home = path.join(scratch, 'home')
    fs.mkdirSync(home)
    const res = spawnSync(path.join(bin, 'playwright-cli'), ['--version'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: home },
      timeout: 30_000
    })
    expect(res.status).toBe(0)
    const bundled = json(
      fs.readFileSync(
        path.join(__dirname, '..', '..', 'node_modules', '@playwright', 'cli', 'package.json'),
        'utf8'
      )
    )
    expect(res.stdout.trim()).toBe(bundled.version)
    expect(res.stderr).not.toMatch(/Update available/)
    expect(fs.existsSync(path.join(home, 'Library', 'Caches', 'ms-playwright'))).toBe(false)
  }, 30_000)

  // PLATFORM§42
  it('hands the script its own arguments as under plain node, and a child it starts with process.execPath goes through the same launcher', () => {
    const child = path.join(scratch, 'child.js')
    const parent = path.join(scratch, 'parent.js')
    fs.writeFileSync(
      child,
      'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), defaultApp: process.defaultApp }))\n'
    )
    fs.writeFileSync(
      parent,
      `const { spawnSync } = require('child_process')
const r = spawnSync(process.execPath, [${JSON.stringify(child)}, 'x', 'y'], { encoding: 'utf8' })
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), defaultApp: process.defaultApp, child: JSON.parse(r.stdout) }))
`
    )
    const res = spawnSync(path.join(install, 'node'), [parent, 'a', 'b c'], {
      encoding: 'utf8',
      timeout: 30_000
    })
    expect(res.status).toBe(0)
    expect(json(res.stdout)).toEqual({
      args: ['a', 'b c'],
      defaultApp: true,
      child: { args: ['x', 'y'], defaultApp: true }
    })
  }, 30_000)

  // ADR-0004
  it('removes an install whose app binary is gone and keeps one whose binary is still there', () => {
    const root = path.dirname(install)
    const dead = path.join(root, 'deadbeef00')
    const live = path.join(root, 'aaaaaaaaaa')
    fs.mkdirSync(dead)
    fs.mkdirSync(live)
    fs.writeFileSync(
      path.join(dead, 'node'),
      `#!/bin/sh\n# koloft-exec: ${path.join(root, 'gone')}\n`
    )
    fs.writeFileSync(path.join(live, 'node'), `#!/bin/sh\n# koloft-exec: ${process.execPath}\n`)
    setupPlaywrightCli()
    expect(fs.existsSync(dead)).toBe(false)
    expect(fs.existsSync(live)).toBe(true)
  })
})
