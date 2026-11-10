import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { describe, expect, it } from 'vitest'
import { packFilm, type Hunk, type RawFrame } from '../e2e/helpers/siteFilm'

const SITE = path.join(__dirname, '..', '..', 'site')
const DEMO = path.join(SITE, 'demo')

interface PackedFrame {
  t: number
  w: number
  h: number
  html: Record<string, string>
  body: Record<string, string>
  s: number[]
  d: Hunk[]
}

interface PackedFilm {
  styles: string[]
  frames: PackedFrame[]
  marks: Record<string, number>
}

const FILMS = fs
  .readdirSync(DEMO)
  .filter((f) => f.endsWith('.frames.js'))
  .map((f) => f.replace(/\.frames\.js$/, ''))

function readFilm(text: string): PackedFilm {
  const ctx = { window: {} as { KOLOFT_FRAMES?: PackedFilm } }
  vm.runInNewContext(text, ctx)
  return ctx.window.KOLOFT_FRAMES!
}

type Decode = (frames: PackedFrame[], n: number) => { root: string; portals: string[] }

function unpack(film: PackedFilm): RawFrame[] {
  const player = {} as { decode: Decode }
  vm.runInNewContext(fs.readFileSync(path.join(DEMO, 'film.js'), 'utf8'), player)
  return film.frames.map((f, n) => {
    const { root, portals } = player.decode(film.frames, n)
    return {
      t: f.t,
      w: f.w,
      h: f.h,
      html: f.html,
      body: f.body,
      styles: f.s.map((i) => film.styles[i]),
      root,
      portals
    }
  })
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

  it('a frame that changes two far-apart areas packs into two small hunks the player turns back into that frame', () => {
    const rows = (word: string): string => Array(200).fill(`<i>${word}</i>`).join('')
    const page = (side: string, main: string): string =>
      `<div class="app"><div class="side"><b>${side}</b>${rows('row')}</div><div class="main">${rows('line')}<b>${main}</b></div></div>`
    const frames = [page('idle', 'old'), page('working', 'new')].map(raw)
    const film = readFilm(packFilm([frames], {}))
    const hunks = film.frames[1].d
    expect(hunks).toHaveLength(2)
    for (const [, , text] of hunks) expect(text.length).toBeLessThan(20)
    expect(unpack(film).map((f) => f.root)).toEqual(frames.map((f) => f.root))
  })

  it.each(FILMS)(
    'the committed %s film plays the same frames after packFilm packs what the player unpacks from it',
    (name) => {
      const film = readFilm(fs.readFileSync(path.join(DEMO, `${name}.frames.js`), 'utf8'))
      const isHunk = (h: unknown): boolean =>
        Array.isArray(h) &&
        typeof h[0] === 'number' &&
        typeof h[1] === 'number' &&
        typeof h[2] === 'string'
      expect(film.frames.every((f) => f.d.every(isHunk))).toBe(true)
      const frames = unpack(film)
      const again = readFilm(packFilm([frames], film.marks))
      expect(unpack(again)).toEqual(frames)
      expect(again.marks).toEqual(film.marks)
    }
  )

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
