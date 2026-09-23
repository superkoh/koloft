import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync, type SpawnSyncReturns } from 'child_process'
import { createPackage } from '@electron/asar'

const repo = path.resolve(__dirname, '../..')
const script = path.join(repo, 'scripts/assert-webgl-atlas.sh')

function runGate(...targets: string[]): SpawnSyncReturns<string> {
  return spawnSync('bash', [script, ...targets], { encoding: 'utf8' })
}

const FINGERPRINT = '_lastSeenPageLayoutVersion'

let fx: string

async function makeAppAsarWithFingerprintInTestSources(
  name: string,
  rendererJs: string
): Promise<string> {
  const src = path.join(fx, `${name}-src`)
  fs.mkdirSync(path.join(src, 'out/renderer/assets'), { recursive: true })
  fs.writeFileSync(path.join(src, 'out/renderer/assets/index-abc.js'), rendererJs)
  fs.mkdirSync(path.join(src, 'test/unit'), { recursive: true })
  fs.writeFileSync(
    path.join(src, 'test/unit/webglAtlasFix.test.ts'),
    `expect(lib).toContain('${FINGERPRINT}')`
  )
  const out = path.join(fx, `${name}.asar`)
  await createPackage(src, out)
  return out
}

let fixedAsar: string
let staleAsar: string

beforeAll(async () => {
  fx = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-webgl-gate-'))
  fs.mkdirSync(path.join(fx, 'fixed/assets'), { recursive: true })
  fs.writeFileSync(path.join(fx, 'fixed/assets/index-abc.js'), `e.${FINGERPRINT}=-1`)
  fs.mkdirSync(path.join(fx, 'stale/assets'), { recursive: true })
  fs.writeFileSync(path.join(fx, 'stale/assets/index-abc.js'), 'e.version++')
  fixedAsar = await makeAppAsarWithFingerprintInTestSources('fixed', `e.${FINGERPRINT}=-1`)
  staleAsar = await makeAppAsarWithFingerprintInTestSources('stale', 'e.version++')
})

describe('assert-webgl-atlas.sh (the artifact gate)', () => {
  it('passes a build dir whose bundle carries the atlas-fix fingerprint', () => {
    expect(runGate(path.join(fx, 'fixed')).status).toBe(0)
  })

  it('fails a build dir compiled from a pre-fix addon — the v0.4.1 incident class — and names npm install as the remedy', () => {
    const r = runGate(path.join(fx, 'stale'))
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('npm install')
  })

  it('passes an asar whose out/renderer bundle carries the fingerprint', () => {
    expect(runGate(fixedAsar).status).toBe(0)
  })

  it('fails a stale asar even though packed-in test/ sources mention the fingerprint — the exact v0.4.1 trap', () => {
    expect(runGate(staleAsar).status).not.toBe(0)
  })

  it('fails when any one of several targets is stale — no partial pass', () => {
    expect(runGate(path.join(fx, 'fixed'), staleAsar).status).not.toBe(0)
  })

  it('fails on a missing target instead of vacuously passing', () => {
    expect(runGate(path.join(fx, 'does-not-exist')).status).not.toBe(0)
  })

  it('fails with no arguments instead of vacuously passing', () => {
    expect(runGate().status).not.toBe(0)
  })
})

describe('the gate is wired into every path that ships a build, since webglAtlasFix.test.ts only guards node_modules where tests run', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }

  it('postbuild asserts the fingerprint in the compiled renderer', () => {
    expect(pkg.scripts.postbuild).toContain('assert-webgl-atlas.sh')
    expect(pkg.scripts.postbuild).toContain('out/renderer')
  })

  it('make-dmg.sh asserts the fingerprint in the final app.asar', () => {
    const sh = fs.readFileSync(path.join(repo, 'scripts/make-dmg.sh'), 'utf8')
    expect(sh).toMatch(/assert-webgl-atlas\.sh.*app\.asar/)
  })
})
