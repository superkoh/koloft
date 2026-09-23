import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Guards that the installed @xterm/addon-webgl carries the upstream atlas-corruption
// fixes (the garbled-screen class: #5883 page-merge glyph corruption, #6014/#6055 stale sibling
// tabs on the shared atlas, and the June–July 2026 per-renderer page invalidation +
// overflow work). Those fixes exist only in 0.20.0-beta.298+ — stable 0.19.0 (which
// Koloft used to carry with a hand-ported patch) never received them, so a dependency
// change that regresses below the fixed stream must fail here loudly, not ship
// silently corrupting.
//
// The addon ships TWO bundles: lib/addon-webgl.js (webpack CJS, `main`) and
// lib/addon-webgl.mjs (esbuild ESM, `module` — the one vite bundles into the
// renderer). The fingerprint below is a property name from the per-renderer
// invalidation mechanism itself; scripts/assert-webgl-atlas.sh greps the SAME string
// in built artifacts, so if upstream renames it on a future bump this suite fails at
// unit time instead of the release gate failing at build time.

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

describe.each(bundles)('%s: atlas fix fingerprint', (_name, lib) => {
  it('carries the per-renderer page-invalidation mechanism the release gate greps for', () => {
    expect(lib).toContain(ATLAS_FIX_FINGERPRINT)
  })
})
