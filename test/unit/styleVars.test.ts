import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer', 'src')
const CSS = path.join(RENDERER, 'styles.css')

function jsDefinedProps(dir: string): Set<string> {
  const out = new Set<string>()
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(e.name)) {
        const src = fs.readFileSync(full, 'utf8')
        for (const m of src.matchAll(/['"](--[A-Za-z0-9_-]+)['"]/g)) out.add(m[1])
      }
    }
  }
  walk(dir)
  return out
}

describe('styles.css custom properties', () => {
  it('every var(-x) reference without a fallback is defined somewhere — an undefined one silently drops its declaration', () => {
    const css = fs.readFileSync(CSS, 'utf8')

    const defined = jsDefinedProps(RENDERER)
    for (const m of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1])

    const missing = new Set<string>()
    for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)) {
      if (!defined.has(m[1])) missing.add(m[1])
    }

    expect([...missing].sort()).toEqual([])
  })

  it.each([
    ['--folder', '#c9a06a'],
    ['--fg-cold', '#9a958d'],
    ['--danger', '#f0a0a0'],
    ['--amber', '#f0a830'],
    ['--red', '#d9776a']
  ])(
    'T-SPEC-02: %s: %s appears exactly once, inside a :root block — a second literal would drift from the token',
    (token, hex) => {
      const css = fs.readFileSync(CSS, 'utf8').toLowerCase()
      const occurrences = css.split(hex).length - 1
      expect(occurrences).toBe(1)
      const rootBlocks = [...css.matchAll(/:root\s*{[^}]*}/g)].map((m) => m[0])
      const inRoot = rootBlocks.some((b) => b.includes(`${token}: ${hex}`))
      expect(inRoot, `${token} must be declared as ${hex} in :root`).toBe(true)
    }
  )
})
