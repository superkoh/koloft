import fs from 'fs'
import path from 'path'
import { test, expect } from '../../test/e2e/helpers/app'
import { gitCommitAll, gitInit, startSessionIn, waitBooted } from '../../test/e2e/helpers/p1'
import { artifactBody, openFileTab } from '../../test/e2e/helpers/workbench'

const FILE_LINES = 4000
const CHANGE_EVERY = 8
const SETTLE_MS = 3000
const WIDTHS = [0, 360, 900]
const CJK_EVERY = 50
const TAB_EVERY = 70

function realSourceLines(): string[] {
  const repo = path.resolve(__dirname, '../..')
  const sources = [
    'docs/platform-contract.md',
    'src/renderer/src/components/ChangesView.tsx',
    'src/renderer/src/components/ArtifactPane.tsx'
  ]
  const all = sources.flatMap((s) => fs.readFileSync(path.join(repo, s), 'utf8').split('\n'))
  return all.slice(0, FILE_LINES).map((l, i) =>
    i % CJK_EVERY === 0
      ? `// 这是一行中文说明文字，用来测量宽字符在窄面板里怎样折行，还有 English words mixed in ${i}`
      : i % TAB_EVERY === 0
        ? `\t\tindented_with_tabs(${i}) // tab stops`
        : l
  )
}

test('row height from text against the real height, on real source and prose, at three widths', async ({
  page,
  env
}) => {
  test.setTimeout(300_000)
  const ws = env.workspaces.a
  const abs = path.join(ws, 'src', 'real.ts')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const base = realSourceLines()
  fs.writeFileSync(abs, base.join('\n') + '\n')
  gitInit(ws)
  gitCommitAll(ws)
  fs.writeFileSync(
    abs,
    base.map((l, i) => (i % CHANGE_EVERY === 0 ? `${l} // changed` : l)).join('\n') + '\n'
  )
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openFileTab(page, env, abs)
  const idiff = artifactBody(page).locator('.idiff')
  await expect(idiff).toBeVisible()
  await expect.poll(() => idiff.locator('.idiff-code > span').count()).toBeGreaterThan(0)
  await page.waitForTimeout(SETTLE_MS)

  const results = []
  for (const w of WIDTHS) {
    results.push(
      await idiff.evaluate((el, width) => {
        const box = el as HTMLElement
        if (width) box.style.width = `${width}px`
        const codes = [...box.querySelectorAll<HTMLElement>('.idiff-row .idiff-code')]
        const cs = getComputedStyle(codes[0])
        const ctx = document.createElement('canvas').getContext('2d')!
        ctx.font = `${cs.fontSize} ${cs.fontFamily}`
        const charW = ctx.measureText('x'.repeat(100)).width / 100
        const lineH = parseFloat(getComputedStyle(codes[0].parentElement!).lineHeight)
        const colW = codes[0].clientWidth - parseFloat(cs.paddingRight)
        const perLine = Math.max(1, Math.floor(colW / charW))
        const widthOf = new Map<string, number>()
        const w = (ch: string): number => {
          let v = widthOf.get(ch)
          if (v === undefined) {
            v = ctx.measureText(ch).width
            widthOf.set(ch, v)
          }
          return v
        }
        const isWide = (ch: string): boolean => /[⺀-鿿豈-﫿＀-￯]/.test(ch)
        const columns = (t: string): number => {
          let col = 0
          for (const ch of t) col = ch === '\t' ? (Math.floor(col / 8) + 1) * 8 : col + (isWide(ch) ? 2 : 1)
          return col
        }
        const wrapLines = (t: string): number => {
          if (!t) return 1
          const tokens = t.match(/\t|[ ]+|[⺀-鿿豈-﫿＀-￯]|[^\s⺀-鿿豈-﫿＀-￯]+/g) ?? []
          let lines = 1
          let x = 0
          const tabW = charW * 8
          for (const tok of tokens) {
            if (tok === '\t') {
              x = (Math.floor(x / tabW + 1e-6) + 1) * tabW
              if (x > colW + 0.5) {
                lines++
                x = tabW
              }
              continue
            }
            if (tok[0] === ' ') {
              x += tok.length * charW
              continue
            }
            let tw = 0
            for (const ch of tok) tw += w(ch)
            if (x + tw <= colW + 0.5) {
              x += tw
              continue
            }
            if (x > 0) {
              lines++
              x = 0
            }
            for (const ch of tok) {
              const cw = w(ch)
              if (x + cw > colW + 0.5) {
                lines++
                x = 0
              }
              x += cw
            }
          }
          return lines
        }
        let real = 0
        let estCols = 0
        let estWrap = 0
        let offCols = 0
        let offWrap = 0
        let multi = 0
        const t0 = performance.now()
        const texts = codes.map((c) => c.textContent ?? '')
        const wraps = texts.map((t) => wrapLines(t.replace(/ /g, ' ')))
        const wrapMs = performance.now() - t0
        codes.forEach((c, i) => {
          const h = c.parentElement!.offsetHeight
          const ec = Math.max(1, Math.ceil(columns(texts[i]) / perLine)) * lineH
          const ew = wraps[i] * lineH
          real += h
          estCols += ec
          estWrap += ew
          if (h > lineH + 1) multi++
          if (Math.abs(h - ec) > 1) offCols++
          if (Math.abs(h - ew) > 1) offWrap++
        })
        box.style.width = ''
        return {
          colW,
          perLine,
          rows: codes.length,
          rowsThatWrap: multi,
          real,
          byColumns: { total: estCols, rowsOff: offCols, errorPct: Math.round(((estCols - real) / real) * 1000) / 10 },
          byWordWrap: { total: estWrap, rowsOff: offWrap, errorPct: Math.round(((estWrap - real) / real) * 1000) / 10, ms: Math.round(wrapMs) }
        }
      }, w)
    )
  }
  console.log(JSON.stringify(results, null, 2))
})
