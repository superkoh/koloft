import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../../node_modules/@xterm/addon-webgl')

const ATLAS_FIX_FINGERPRINT = '_lastSeenPageLayoutVersion'

it('the installed addon is on the atlas-fixed stream (>= 0.20.0-beta.298)', () => {
  const version = (
    JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      version: string
    }
  ).version
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/)
  expect(m, `unparseable addon version: ${version}`).not.toBeNull()
  const [, major, minor, , beta] = m!
  const ok =
    Number(major) > 0 ||
    Number(minor) > 20 ||
    (Number(minor) === 20 && (beta === undefined || Number(beta) >= 298))
  expect(ok, `@xterm/addon-webgl ${version} predates the atlas fixes`).toBe(true)
})

const bundles = ['addon-webgl.js', 'addon-webgl.mjs'].map(
  (name) => [name, readFileSync(resolve(root, 'lib', name), 'utf8')] as const
)

describe.each(bundles)(
  '%s (the CJS main bundle, and the ESM one vite ships): atlas fix fingerprint',
  (_name, lib) => {
    it('carries the per-renderer page-invalidation mechanism the release gate greps for', () => {
      expect(lib).toContain(ATLAS_FIX_FINGERPRINT)
    })
  }
)
