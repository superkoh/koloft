import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { describe, expect, it } from 'vitest'
import { packFilm, type RawFrame } from '../e2e/helpers/siteFilm'

const SITE = path.join(__dirname, '..', '..', 'site')

interface PackedFilm {
  frames: unknown[]
  marks: Record<string, number>
}

function readFilm(text: string): PackedFilm {
  const ctx = { window: {} as { KOLOFT_FRAMES?: PackedFilm } }
  vm.runInNewContext(text, ctx)
  return ctx.window.KOLOFT_FRAMES!
}

function raw(root: string): RawFrame {
  return { t: 0, w: 10, h: 10, html: {}, body: {}, styles: [], root, portals: [] }
}

describe('site films', () => {
  it('a mark lands on the first kept frame that shows a change at or after it, whatever the packer drops', () => {
    const film = readFilm(
      packFilm([['a', 'a', 'b', 'b', 'c'].map(raw)], {
        first: 0,
        sameAsA: 1,
        sameAsB: 3,
        after: 5
      })
    )
    expect(film.frames).toHaveLength(3)
    expect(film.marks).toEqual({ first: 0, sameAsA: 1, sameAsB: 2, after: 2 })
  })

  it('every mark site/index.html steers a film by is a mark that film has', () => {
    const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8')
    let named = 0
    for (const win of html.split('<div').filter((d) => /data-film="/.test(d))) {
      const film = /data-film="([^"]+)"/.exec(win)![1]
      const attr = (name: string): string | undefined =>
        new RegExp(`data-${name}='([^']*)'`).exec(win)?.[1] ??
        new RegExp(`data-${name}="([^"]*)"`).exec(win)?.[1]
      const from = attr('from')
      const moments = [
        ...(JSON.parse(attr('cam') ?? '[]') as { at: unknown }[]).map((c) => c.at),
        ...(JSON.parse(attr('cues') ?? '[]') as { at: unknown; to?: unknown }[]).flatMap((c) => [
          c.at,
          c.to
        ]),
        from && /^\d+$/.test(from) ? Number(from) : from
      ]
      const { marks } = readFilm(
        fs.readFileSync(path.join(SITE, 'demo', `${film}.frames.js`), 'utf8')
      )
      for (const m of moments.filter((m): m is string => typeof m === 'string')) {
        const name = /^([a-z-]+)(?:[+-]\d+)?$/.exec(m)?.[1]
        named++
        expect(name && name in marks, `${film} has no mark "${m}"`).toBe(true)
      }
    }
    expect(named).toBeGreaterThan(0)
  })
})
