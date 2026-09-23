import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Every `var(--x)` in the stylesheet must resolve to a custom property that actually
 * exists.
 *
 * A typo'd or invented token is invalid at computed-value time: the declaration is
 * dropped and the property falls back to its inherited/initial value. So a wrong color
 * name does not throw, does not warn, and does not show up in a screenshot of the
 * common case — it only appears in whichever state happens to use that rule (here: a
 * usage bar over 70%, which silently rendered with a transparent fill while the
 * under-70% bars looked perfect).
 */
const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer', 'src')
const CSS = path.join(RENDERER, 'styles.css')

/** Custom properties a component sets at runtime via an inline style (e.g. the context
 *  ring's `--p`) are defined too — just not in the stylesheet. Collect those so the
 *  check flags typos rather than every JS-driven property. */
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
  it('every var(-x) reference without a fallback is defined somewhere', () => {
    const css = fs.readFileSync(CSS, 'utf8')

    const defined = jsDefinedProps(RENDERER)
    for (const m of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1])

    // `var(--x, fallback)` is safe by construction — only bare references can break
    const missing = new Set<string>()
    for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)) {
      if (!defined.has(m[1])) missing.add(m[1])
    }

    expect([...missing].sort()).toEqual([])
  })

  // T-SPEC-02 (agent-centric V0): the five collected hexes live ONLY as their
  // :root token — a second literal occurrence is a color that silently drifts
  // from the token on the next palette edit, which no visual test catches.
  it.each([
    ['--folder', '#c9a06a'],
    ['--fg-cold', '#9a958d'],
    ['--danger', '#f0a0a0'],
    ['--amber', '#f0a830'],
    ['--red', '#d9776a']
  ])('%s: %s appears exactly once, inside a :root block', (token, hex) => {
    const css = fs.readFileSync(CSS, 'utf8').toLowerCase()
    const occurrences = css.split(hex).length - 1
    expect(occurrences).toBe(1)
    const rootBlocks = [...css.matchAll(/:root\s*{[^}]*}/g)].map((m) => m[0])
    const inRoot = rootBlocks.some((b) => b.includes(`${token}: ${hex}`))
    expect(inRoot, `${token} must be declared as ${hex} in :root`).toBe(true)
  })
})
