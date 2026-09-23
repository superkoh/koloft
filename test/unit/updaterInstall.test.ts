import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { INSTALL_SCRIPT, pickAppBundle } from '../../src/main/updaterInstall'

const roots: string[] = []
afterAll(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true })
})

function bundle(at: string, tag: string): void {
  fs.mkdirSync(path.join(at, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(at, 'Contents', 'MacOS', 'app'), tag)
}
const tagOf = (at: string): string =>
  fs.readFileSync(path.join(at, 'Contents', 'MacOS', 'app'), 'utf8')

function runScript(args: string[]): { status: number | null; opened: string[]; stderr: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-install-'))
  roots.push(root)
  const stubbedOpenDir = path.join(root, 'bin')
  fs.mkdirSync(stubbedOpenDir)
  const openLog = path.join(root, 'open.log')
  fs.writeFileSync(path.join(stubbedOpenDir, 'open'), `#!/bin/bash\necho "$1" >> "${openLog}"\n`, {
    mode: 0o755
  })
  const script = path.join(root, 'install.sh')
  fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 })
  const alreadyExitedPid = spawnSync('true').pid
  const res = spawnSync('/bin/bash', [script, String(alreadyExitedPid), ...args], {
    env: { ...process.env, PATH: `${stubbedOpenDir}:${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 20_000
  })
  const opened = fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8').trim().split('\n') : []
  return { status: res.status, opened, stderr: res.stderr }
}

function fixture(): { root: string; work: string; apps: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-swap-'))
  roots.push(root)
  const work = path.join(root, 'work')
  const apps = path.join(root, 'Applications')
  fs.mkdirSync(work)
  fs.mkdirSync(apps)
  return { root, work, apps }
}

describe('pickAppBundle', () => {
  it('finds the one .app among the dmg furniture', () => {
    expect(pickAppBundle(['.background', '.DS_Store', 'Applications', 'Koloft.app'])).toBe(
      'Koloft.app'
    )
    expect(pickAppBundle(['Applications', 'OldName.app'])).toBe('OldName.app')
  })
  it('prefers Koloft.app if a dmg ever carried two, and reports none', () => {
    expect(pickAppBundle(['OldName.app', 'Koloft.app'])).toBe('Koloft.app')
    expect(pickAppBundle(['Applications'])).toBeNull()
  })
})

describe('INSTALL_SCRIPT, run for real against throwaway bundles', () => {
  it('same name: swaps the running bundle in place, relaunches it, leaves no scratch behind', () => {
    const { work, apps } = fixture()
    const src = path.join(work, 'staging', 'Koloft.app')
    const dest = path.join(apps, 'Koloft.app')
    bundle(src, 'new')
    bundle(dest, 'old')

    const r = runScript([src, dest, work, ''])
    expect(r.status, r.stderr).toBe(0)
    expect(tagOf(dest)).toBe('new')
    expect(fs.existsSync(`${dest}.old`)).toBe(false)
    expect(fs.existsSync(`${dest}.new`)).toBe(false)
    expect(fs.existsSync(work)).toBe(false)
    expect(r.opened).toEqual([dest])
  })

  it('rename: installs Koloft.app beside OldName.app, removes OldName.app, relaunches the new one', () => {
    const { work, apps } = fixture()
    const src = path.join(work, 'staging', 'Koloft.app')
    const dest = path.join(apps, 'Koloft.app')
    const old = path.join(apps, 'OldName.app')
    bundle(src, 'new')
    bundle(old, 'old')

    const r = runScript([src, dest, work, old])
    expect(r.status, r.stderr).toBe(0)
    expect(tagOf(dest)).toBe('new')
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(work)).toBe(false)
    expect(r.opened).toEqual([dest])
  })

  it('a failed copy leaves the running bundle untouched — in both shapes; the old app goes only after the new one is complete', () => {
    const { work, apps } = fixture()
    const missingSrc = path.join(work, 'staging', 'Koloft.app')
    const dest = path.join(apps, 'Koloft.app')
    bundle(dest, 'old')
    let r = runScript([missingSrc, dest, work, ''])
    expect(r.status).not.toBe(0)
    expect(tagOf(dest)).toBe('old')
    expect(r.opened).toEqual([])

    const f2 = fixture()
    const old = path.join(f2.apps, 'OldName.app')
    bundle(old, 'old')
    r = runScript([
      path.join(f2.work, 'nothing.app'),
      path.join(f2.apps, 'Koloft.app'),
      f2.work,
      old
    ])
    expect(r.status).not.toBe(0)
    expect(tagOf(old)).toBe('old')
    expect(fs.existsSync(path.join(f2.apps, 'Koloft.app'))).toBe(false)
  })
})
