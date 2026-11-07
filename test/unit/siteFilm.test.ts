import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { describe, expect, it } from 'vitest'
import { packFilm, type RawFrame } from '../e2e/helpers/siteFilm'

const SITE = path.join(__dirname, '..', '..', 'site')

type Hunk = [at: number, cut: number, text: string]

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

const FILMS = ['assist', 'browser', 'pal-jump', 'pal-search', 'pal-start', 'tree']

function readFilm(text: string): PackedFilm {
  const ctx = { window: {} as { KOLOFT_FRAMES?: PackedFilm } }
  vm.runInNewContext(text, ctx)
  return ctx.window.KOLOFT_FRAMES!
}

function playersApplyHunks(): (doc: string, hunks: Hunk[]) => string {
  const player = fs.readFileSync(path.join(SITE, 'demo', 'player.html'), 'utf8')
  const source = /function applyHunks\(doc, hunks\) \{[\s\S]*?\n {6}\}/.exec(player)![0]
  return new Function(`${source}\nreturn applyHunks`)()
}

function unpack(film: PackedFilm): RawFrame[] {
  const applyHunks = playersApplyHunks()
  let doc = ''
  return film.frames.map((f) => {
    doc = applyHunks(doc, f.d)
    const [root, portals] = doc.split('\u0001')
    return {
      t: f.t,
      w: f.w,
      h: f.h,
      html: f.html,
      body: f.body,
      styles: f.s.map((i) => film.styles[i]),
      root,
      portals: portals ? portals.split('\u0002') : []
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
    'the committed %s film is exactly what packFilm makes of the frames the player unpacks from it',
    (name) => {
      const text = fs.readFileSync(path.join(SITE, 'demo', `${name}.frames.js`), 'utf8')
      const film = readFilm(text)
      expect(packFilm([unpack(film)], film.marks)).toBe(text)
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
