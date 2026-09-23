import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import { sendShortcut, startSessionIn, waitBooted } from './helpers/p1'
import { artifactBody, openFileTab, WORKBENCH } from './helpers/workbench'
import type { E2EEnv } from './helpers/env'

const ENOUGH_SAMPLES_TO_PROVE_THE_WATCHER_RAN = 4
const SCROLL_INTO_VIEW_ROUNDING_PX = 2
const ROOM_FOR_A_WRONG_EAGER_RENDER_MS = 3000

const FIXTURE_PNG = path.join(__dirname, 'fixtures', 'md-preview', 'bbm-pic.png')

function writeFile(env: E2EEnv, rel: string, body: string): string {
  const full = path.join(env.workspaces.a, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
  return full
}

function writePng(env: E2EEnv, rel: string): string {
  const full = path.join(env.workspaces.a, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.copyFileSync(FIXTURE_PNG, full)
  return full
}

function filler(lines: number, tag: string): string {
  return Array.from({ length: lines }, (_, i) => `${tag} filler body line ${i + 1}.`).join('\n\n')
}

function mdBody(page: Page): Locator {
  return artifactBody(page).locator('.md-body')
}

function diagramBoxes(page: Page): Locator {
  return mdBody(page).locator('.mmd')
}

function renderedDiagrams(page: Page): Locator {
  return mdBody(page).locator('.mmd > svg')
}

function artifactTitle(page: Page): Locator {
  return page.locator(WORKBENCH.artifactTitle)
}

function outlineToggle(page: Page): Locator {
  return page.locator(WORKBENCH.outline)
}

async function openInPreview(page: Page, env: E2EEnv, rel: string): Promise<void> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openFileTab(page, env, path.join(env.workspaces.a, rel))
  await expect(artifactTitle(page)).toContainText(path.basename(rel), { timeout: 30_000 })
  await expect(mdBody(page)).toBeVisible({ timeout: 30_000 })
}

function previewScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.querySelector('.wb-artifact')
    if (!root) return -1
    let max = (root as HTMLElement).scrollTop
    for (const n of Array.from(root.querySelectorAll('*'))) {
      max = Math.max(max, (n as HTMLElement).scrollTop)
    }
    return max
  })
}

async function scrollThroughPreview(page: Page): Promise<void> {
  let bottomHits = 0
  for (let i = 0; i < 80 && bottomHits < 3; i++) {
    const wasAtBottom = await page.evaluate(() => {
      const root = document.querySelector('.wb-artifact')
      if (!root) return true
      let atBottom = true
      for (const n of [root, ...Array.from(root.querySelectorAll('*'))]) {
        const el = n as HTMLElement
        if (el.scrollHeight - el.clientHeight <= 8) continue
        if (el.scrollTop + el.clientHeight < el.scrollHeight - 4) atBottom = false
        el.scrollTop += Math.max(160, el.clientHeight * 0.8)
      }
      return atBottom
    })
    await page.waitForTimeout(200)
    bottomHits = wasAtBottom ? bottomHits + 1 : 0
  }
}

function clipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText())
}

async function withClipboardRestored<T>(
  app: ElectronApplication,
  body: () => Promise<T>
): Promise<T> {
  const saved = await clipboardText(app)
  try {
    return await body()
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
  }
}

function normalizeCopied(text: string): string {
  return text.replace(/\n+$/, '')
}

interface DiagramWatch {
  min: number
  samples: number
}

async function watchDiagrams(page: Page, needle = ''): Promise<void> {
  await page.evaluate((mark: string) => {
    const state: DiagramWatch = { min: Number.MAX_SAFE_INTEGER, samples: 0 }
    ;(window as unknown as { __bbmWatch: DiagramWatch }).__bbmWatch = state
    const sample = (): void => {
      const svgs = Array.from(document.querySelectorAll('.md-body .mmd > svg'))
      const n = mark ? svgs.filter((s) => (s.textContent ?? '').includes(mark)).length : svgs.length
      if (n < state.min) state.min = n
      state.samples += 1
    }
    sample()
    const root = document.querySelector('.wb-artifact') ?? document.body
    new MutationObserver(sample).observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    })
    window.setInterval(sample, 8)
  }, needle)
}

function readDiagramWatch(page: Page): Promise<DiagramWatch> {
  return page.evaluate(
    () => (window as unknown as { __bbmWatch?: DiagramWatch }).__bbmWatch ?? { min: -1, samples: 0 }
  )
}

function sampleTs(): string {
  return (
    Array.from({ length: 40 }, (_, i) => `export const l${i + 1} = 'bbmline-${i + 1}'`).join('\n') +
    '\n'
  )
}

function fence(lang: string, code: string): string {
  return '```' + lang + '\n' + code + '\n```\n'
}

test.describe('rich Markdown preview, main flow — black-box: each assertion is a case’s Then plus the DOM contract', () => {
  test('BB-M01 mermaid flowchart renders as a picture', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    writeFile(env, 'bbm01.md', '# BB-M01\n\n' + fence('mermaid', 'flowchart TD\n  A --> B'))

    await openInPreview(page, env, 'bbm01.md')

    const svg = renderedDiagrams(page)
    await expect(svg).toHaveCount(1, { timeout: 60_000 })
    await expect(svg).toContainText('A')
    await expect(svg).toContainText('B')
    await expect(mdBody(page)).not.toContainText('flowchart TD')
  })

  const DIAGRAM_KINDS: { token: string; code: string }[] = [
    { token: 'bbm02flw', code: 'flowchart TD\n  n1[bbm02flw] --> n2[tail]' },
    {
      token: 'bbm02seq',
      code: 'sequenceDiagram\n    participant bbm02seq\n    bbm02seq->>Bob: hello'
    },
    { token: 'bbm02cls', code: 'classDiagram\n    class bbm02cls {\n      +int id\n    }' },
    { token: 'bbm02sta', code: 'stateDiagram-v2\n    [*] --> bbm02sta\n    bbm02sta --> [*]' },
    { token: 'bbm02erd', code: 'erDiagram\n    bbm02erd ||--o{ ORDER : places' },
    {
      token: 'bbm02gnt',
      code:
        'gantt\n    title bbm02gnt\n    dateFormat YYYY-MM-DD\n' +
        '    section One\n    task one :a1, 2024-01-01, 3d'
    },
    { token: 'bbm02pie', code: 'pie title bbm02pie\n    "Alpha" : 60\n    "Beta" : 40' },
    {
      token: 'bbm02jny',
      code: 'journey\n    title bbm02jny\n    section Morning\n      Walk: 5: Me'
    },
    { token: 'bbm02mnd', code: 'mindmap\n  root((bbm02mnd))\n    child one' },
    { token: 'bbm02tml', code: 'timeline\n    title bbm02tml\n    2024 : first event' },
    { token: 'bbm02git', code: 'gitGraph\n    commit id: "bbm02git"' },
    {
      token: 'bbm02cfr',
      code: 'C4Context\n    title bbm02cfr\n    Person(user, "User", "a person")'
    },
    { token: 'bbm02snk', code: 'sankey-beta\n\nbbm02snk,Bravo,5' },
    {
      token: 'bbm02xyc',
      code:
        'xychart-beta\n    title "bbm02xyc"\n    x-axis [alpha, bravo]\n' +
        '    y-axis "amount" 0 --> 10\n    bar [3, 7]'
    },
    { token: 'bbm02blk', code: 'block-beta\n  columns 1\n  a["bbm02blk"]' },
    { token: 'bbm02kbn', code: 'kanban\n  todo[bbm02kbn]\n    task1[an item]' },
    {
      token: 'bbm02arc',
      code:
        'architecture-beta\n    group bbm02arc(cloud)[bbm02arc]\n' +
        '    service db(database)[Store] in bbm02arc'
    }
  ]

  test('BB-M02 every diagram kind the spec names renders', async ({ app, page, env }) => {
    test.setTimeout(600_000)
    const doc =
      '# BB-M02\n\n' +
      DIAGRAM_KINDS.map((d, i) => `## Kind ${i + 1}\n\n` + fence('mermaid', d.code)).join('\n')
    writeFile(env, 'bbm02.md', doc)

    await openInPreview(page, env, 'bbm02.md')
    await scrollThroughPreview(page)

    await expect(renderedDiagrams(page)).toHaveCount(DIAGRAM_KINDS.length, { timeout: 120_000 })
    for (const kind of DIAGRAM_KINDS) {
      await expect(
        mdBody(page).locator('.mmd > svg', { hasText: kind.token }),
        `diagram carrying ${kind.token}`
      ).toHaveCount(1)
    }
    await expect(page.locator('.mmd-error')).toHaveCount(0)
  })

  test('BB-M03 code blocks have syntax colors', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    writeFile(
      env,
      'bbm03.md',
      '# BB-M03\n\n' +
        fence('ts', "export const answer: number = 42\nconsole.log('answer', answer)") +
        '\n' +
        fence('bash', 'set -e\necho "hello bbm03"')
    )

    await openInPreview(page, env, 'bbm03.md')

    const blocks = mdBody(page).locator(' .md-code')
    await expect(blocks).toHaveCount(2, { timeout: 30_000 })
    for (let i = 0; i < 2; i++) {
      const colors = await blocks.nth(i).evaluate((el) => {
        const seen = new Set<string>()
        for (const n of Array.from(el.querySelectorAll('pre span'))) {
          if (n.querySelector('span')) continue
          if (!(n.textContent ?? '').trim()) continue
          seen.add(getComputedStyle(n).color)
        }
        return Array.from(seen)
      })
      expect(
        colors.length,
        `distinct foreground colours in code block ${i + 1}`
      ).toBeGreaterThanOrEqual(2)
    }
  })

  test('BB-M04 code blocks have a language tag and a copy button, copy gives the source text', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const code = 'def add(a, b):\n    return a + b'
    writeFile(env, 'bbm04.md', '# BB-M04\n\n' + fence('python', code))

    await openInPreview(page, env, 'bbm04.md')
    const block = mdBody(page).locator(' .md-code')
    await expect(block).toHaveCount(1, { timeout: 30_000 })

    await withClipboardRestored(app, async () => {
      await block.locator('button.md-code-copy').click()
      await expect(block.locator('.md-code-lang')).toHaveText(/^\s*python\s*$/i)
      await expect
        .poll(async () => normalizeCopied(await clipboardText(app)), { timeout: 15_000 })
        .toBe(code)
    })
  })

  test('BB-M05 inline math renders', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    writeFile(env, 'bbm05.md', '# BB-M05\n\nWhen $E = mc^2$ holds\n')

    await openInPreview(page, env, 'bbm05.md')

    const katex = mdBody(page).locator(' .katex').first()
    await expect(katex).toBeVisible({ timeout: 30_000 })
    const sup = await katex.evaluate((el) => {
      const n = el.querySelector('.msupsub, msup')
      return n ? (n.textContent ?? '') : null
    })
    expect(sup, 'a superscript inside the rendered formula').not.toBeNull()
    expect(sup).toContain('2')
    await expect(mdBody(page)).not.toContainText('$E = mc^2$')
  })

  test('BB-M06 block math renders', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    writeFile(env, 'bbm06.md', '# BB-M06\n\n$$\\frac{a}{b}$$\n\nClosing text.\n')

    await openInPreview(page, env, 'bbm06.md')

    const display = mdBody(page).locator(' .katex-display')
    await expect(display).toHaveCount(1, { timeout: 30_000 })
    const box = await display.evaluate((el) => {
      const s = getComputedStyle(el)
      return {
        display: s.display,
        textAlign: s.textAlign,
        fractions: el.querySelectorAll('.mfrac, mfrac').length
      }
    })
    expect(box.display).toBe('block')
    expect(box.textAlign).toBe('center')
    expect(box.fractions, 'the rendered fraction').toBeGreaterThan(0)
    await expect(mdBody(page)).not.toContainText('$$')
  })

  const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution']

  test('BB-M07 all five callout kinds render as cards', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const doc =
      '# BB-M07\n\n' +
      ALERT_KINDS.map((k, i) => `> [!${k.toUpperCase()}]\n> Callout body ${i + 1}.\n`).join('\n')
    writeFile(env, 'bbm07.md', doc)

    await openInPreview(page, env, 'bbm07.md')

    const cards = mdBody(page).locator(' .md-alert')
    await expect(cards).toHaveCount(5, { timeout: 30_000 })
    for (let i = 0; i < ALERT_KINDS.length; i++) {
      const card = cards.nth(i)
      await expect(card).toHaveClass(new RegExp(`\\bmd-alert-${ALERT_KINDS[i]}\\b`))
      await expect(card.locator('.md-alert-title')).toHaveText(
        new RegExp(`^\\s*${ALERT_KINDS[i]}\\s*$`, 'i')
      )
      await expect(card.locator('.md-alert-icon')).toBeVisible()
    }

    const signatures = await cards.evaluateAll((els) =>
      els.map((el) => {
        const colourOf = (n: Element | null): string => {
          if (!n) return ''
          const s = getComputedStyle(n)
          return [s.color, s.backgroundColor, s.fill, s.stroke].join(',')
        }
        const s = getComputedStyle(el)
        return [
          s.color,
          s.backgroundColor,
          s.borderLeftColor,
          s.borderTopColor,
          colourOf(el.querySelector('.md-alert-title')),
          colourOf(el.querySelector('.md-alert-icon')),
          colourOf(el.querySelector('.md-alert-icon svg'))
        ].join('|')
      })
    )
    expect(new Set(signatures).size, 'pairwise different card colours').toBe(5)

    await expect(mdBody(page)).not.toContainText('[!')
  })

  test('BB-M08 task list renders as read-only checkboxes', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    writeFile(env, 'bbm08.md', '# BB-M08\n\n- [ ] open item\n- [x] done item\n')

    await openInPreview(page, env, 'bbm08.md')

    const boxes = mdBody(page).locator(' input[type=checkbox].md-task')
    await expect(boxes).toHaveCount(2, { timeout: 30_000 })
    await expect(boxes.nth(0)).not.toBeChecked()
    await expect(boxes.nth(1)).toBeChecked()
    await expect(boxes.nth(0)).toBeDisabled()
    await expect(boxes.nth(1)).toBeDisabled()

    const text = (await mdBody(page).textContent()) ?? ''
    expect(text).not.toContain('[ ]')
    expect(text).not.toContain('[x]')
  })

  test('BB-M09 footnotes jump both ways', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    writeFile(
      env,
      'bbm09.md',
      '# BB-M09\n\nHere is a footnote[^1]\n\n' +
        filler(200, 'bbm09') +
        '\n\n[^1]: footnote text bbm09-footnote-body\n'
    )

    await openInPreview(page, env, 'bbm09.md')

    const ref = mdBody(page).locator('sup a, a sup').first()
    await expect(ref).toBeVisible({ timeout: 30_000 })
    const entry = mdBody(page).locator(' li', { hasText: 'bbm09-footnote-body' })
    await expect(entry).toHaveCount(1)
    await expect(entry).not.toBeInViewport()

    await ref.click()
    await expect(entry).toBeInViewport({ timeout: 20_000 })

    await entry.locator('a').last().click()
    await expect(ref).toBeInViewport({ timeout: 20_000 })
  })

  test('BB-M10 front matter renders as an info card', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    writeFile(
      env,
      'bbm10.md',
      '---\ntitle: Design spec\nstatus: draft\n---\n\nFirst body paragraph bbm10-body\n'
    )

    await openInPreview(page, env, 'bbm10.md')

    const card = artifactBody(page).locator('.md-frontmatter')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.locator('.md-fm-key', { hasText: 'title' })).toHaveCount(1)
    await expect(card.locator('.md-fm-val', { hasText: 'Design spec' })).toHaveCount(1)
    await expect(card.locator('.md-fm-key', { hasText: 'status' })).toHaveCount(1)
    await expect(card.locator('.md-fm-val', { hasText: 'draft' })).toHaveCount(1)

    const cardTop = await card.evaluate((el) => el.getBoundingClientRect().top)
    const bodyTop = await mdBody(page)
      .locator('p', { hasText: 'bbm10-body' })
      .first()
      .evaluate((el) => el.getBoundingClientRect().top)
    expect(cardTop).toBeLessThan(bodyTop)

    await expect(mdBody(page).locator('hr')).toHaveCount(0)
    expect((await mdBody(page).textContent()) ?? '').not.toContain('title: Design spec')
  })

  test('BB-M11 relative-path image shows', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    writePng(env, 'bbm11/pic.png')
    writeFile(env, 'bbm11/doc.md', '# BB-M11\n\n![pic](./pic.png)\n')

    await openInPreview(page, env, 'bbm11/doc.md')

    const img = mdBody(page).locator(' img')
    await expect(img).toHaveCount(1, { timeout: 30_000 })
    await expect
      .poll(
        () =>
          img.evaluate((el) => {
            const i = el as HTMLImageElement
            return Math.min(i.naturalWidth, i.naturalHeight)
          }),
        { timeout: 20_000 }
      )
      .toBeGreaterThan(0)
  })

  test('BB-M12 absolute-path image shows', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const png = writePng(env, 'bbm12-pic.png')
    writeFile(env, 'bbm12.md', `# BB-M12\n\n![pic](${png})\n`)

    await openInPreview(page, env, 'bbm12.md')

    const img = mdBody(page).locator(' img')
    await expect(img).toHaveCount(1, { timeout: 30_000 })
    await expect
      .poll(
        () =>
          img.evaluate((el) => {
            const i = el as HTMLImageElement
            return Math.min(i.naturalWidth, i.naturalHeight)
          }),
        { timeout: 20_000 }
      )
      .toBeGreaterThan(0)
  })

  test('BB-M13 a "path:line" in the body is a click-to-open link', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    writeFile(env, 'sample.ts', sampleTs())
    writeFile(env, 'bbm13.md', '# BB-M13\n\nThe error is on line sample.ts:12 here.\n')

    await openInPreview(page, env, 'bbm13.md')

    await mdBody(page)
      .locator('a.md-fileref', { hasText: 'sample.ts:12' })
      .click({ timeout: 30_000 })

    await expect(artifactTitle(page)).toHaveText('sample.ts', { timeout: 30_000 })
    const line12 = artifactBody(page).getByText('bbmline-12').first()
    await expect(line12).toBeInViewport({ timeout: 20_000 })
  })

  test('BB-M14 a backticked "path:line" is clickable too', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    writeFile(env, 'sample.ts', sampleTs())
    writeFile(env, 'bbm14.md', '# BB-M14\n\nSee line `sample.ts:5` here.\n')

    await openInPreview(page, env, 'bbm14.md')

    await mdBody(page)
      .locator('a.md-fileref', { hasText: 'sample.ts:5' })
      .click({ timeout: 30_000 })

    await expect(artifactTitle(page)).toHaveText('sample.ts', { timeout: 30_000 })
    const line5 = artifactBody(page).getByText('bbmline-5').first()
    await expect(line5).toBeInViewport({ timeout: 20_000 })
  })

  test('BB-M15 outline lists headings and jumps to them', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    writeFile(
      env,
      'bbm15.md',
      '# Overview\n\nOverview body.\n\n## Design\n\nDesign body.\n\n' +
        filler(200, 'bbm15') +
        '\n\n### Details\n\nDetails body bbm15-detail\n'
    )

    await openInPreview(page, env, 'bbm15.md')

    const heading = mdBody(page).locator(' h3', { hasText: 'Details' })
    await expect(heading).not.toBeInViewport()

    await outlineToggle(page).click({ timeout: 30_000 })
    const items = page.locator('.outline-list .outline-it')
    await expect(items).toHaveCount(3, { timeout: 15_000 })
    await expect(items.nth(0)).toHaveText(/Overview/)
    await expect(items.nth(1)).toHaveText(/Design/)
    await expect(items.nth(2)).toHaveText(/Details/)

    const indents = await items.evaluateAll((els) =>
      els.map((el) => {
        const s = getComputedStyle(el)
        return (
          el.getBoundingClientRect().left +
          parseFloat(s.paddingLeft || '0') +
          parseFloat(s.textIndent || '0')
        )
      })
    )
    expect(indents[0], 'H1 indented less than H2').toBeLessThan(indents[1])
    expect(indents[1], 'H2 indented less than H3').toBeLessThan(indents[2])

    await items.nth(2).click()
    await expect(heading).toBeInViewport({ timeout: 20_000 })
  })

  test('BB-M16 file change on disk re-renders in place without jumping to the top', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const head =
      '# BB-M16\n\n' +
      filler(100, 'bbm16head') +
      '\n\n' +
      fence('mermaid', 'flowchart TD\n  p1[bbm16one] --> p2[tail]') +
      '\n' +
      fence('mermaid', 'flowchart TD\n  q1[bbm16two] --> q2[tail]') +
      '\n' +
      filler(100, 'bbm16tail') +
      '\n\n'
    const doc = writeFile(env, 'bbm16.md', head + 'closing text bbm16-before\n')

    await openInPreview(page, env, 'bbm16.md')

    await expect(diagramBoxes(page)).toHaveCount(2, { timeout: 60_000 })
    await diagramBoxes(page)
      .first()
      .evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await expect(renderedDiagrams(page)).toHaveCount(2, { timeout: 90_000 })
    await page.waitForTimeout(500)
    const before = await previewScrollTop(page)
    expect(before, 'the sample really did scroll').toBeGreaterThan(0)
    await expect(diagramBoxes(page).nth(0)).toBeInViewport()
    await expect(diagramBoxes(page).nth(1)).toBeInViewport()

    await watchDiagrams(page)
    fs.writeFileSync(doc, head + 'closing text bbm16-after\n')

    await expect(mdBody(page)).toContainText('bbm16-after', { timeout: 30_000 })
    await page.waitForTimeout(1500)
    expect(Math.abs((await previewScrollTop(page)) - before)).toBeLessThanOrEqual(
      SCROLL_INTO_VIEW_ROUNDING_PX
    )
    await expect(diagramBoxes(page).nth(0)).toBeInViewport()
    await expect(diagramBoxes(page).nth(1)).toBeInViewport()

    const watch = await readDiagramWatch(page)
    expect(watch.samples, 'the watcher really sampled').toBeGreaterThan(
      ENOUGH_SAMPLES_TO_PROVE_THE_WATCHER_RAN
    )
    expect(watch.min, 'rendered diagrams never dropped below two').toBeGreaterThanOrEqual(2)
  })

  const UNSUPPORTED_FENCES: { lang: string; head: string; tail: string }[] = [
    {
      lang: 'plantuml',
      head: '@startuml bbm17-plantuml-head',
      tail: '@enduml bbm17-plantuml-tail'
    },
    { lang: 'd2', head: 'bbm17-d2-head -> x', tail: 'x -> bbm17-d2-tail' },
    { lang: 'dot', head: 'digraph bbm17_dot_head {', tail: '} // bbm17-dot-tail' },
    { lang: 'geojson', head: '{ "bbm17-geojson-head": 1,', tail: '"bbm17-geojson-tail": 2 }' }
  ]

  test('BB-M17 unsupported diagram fence falls back to a plain code block', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    writeFile(
      env,
      'bbm17.md',
      '# BB-M17\n\n' +
        UNSUPPORTED_FENCES.map((f) => fence(f.lang, `${f.head}\n${f.tail}`)).join('\n')
    )

    await openInPreview(page, env, 'bbm17.md')

    const blocks = mdBody(page).locator(' .md-code')
    await expect(blocks).toHaveCount(4, { timeout: 30_000 })
    for (const f of UNSUPPORTED_FENCES) {
      const block = blocks.filter({ hasText: f.head })
      await expect(block, `${f.lang} fence`).toHaveCount(1)
      await expect(block).toContainText(f.tail)
    }
    await expect(page.locator('.mmd-error')).toHaveCount(0)
    await expect(diagramBoxes(page)).toHaveCount(0)
  })

  test('BB-M18 wide table scrolls sideways inside itself and its header sticks to the top of the table’s own scroll box', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const cols = Array.from({ length: 12 }, (_, c) => `Column header ${c + 1}`)
    const rows = Array.from(
      { length: 40 },
      (_, r) =>
        '| ' +
        Array.from({ length: 12 }, (_, c) => `Row ${r + 1} cell ${c + 1} text`).join(' | ') +
        ' |'
    )
    writeFile(
      env,
      'bbm18.md',
      '# BB-M18\n\nBody paragraph bbm18-para used to measure the body width.\n\n' +
        '| ' +
        cols.join(' | ') +
        ' |\n' +
        '| ' +
        cols.map(() => '---').join(' | ') +
        ' |\n' +
        rows.join('\n') +
        '\n'
    )

    await openInPreview(page, env, 'bbm18.md')

    const wrap = mdBody(page).locator(' .md-table-wrap')
    await expect(wrap).toHaveCount(1, { timeout: 30_000 })

    const scrolledRight = await wrap.evaluate((el) => {
      el.scrollLeft = 10_000
      return el.scrollLeft
    })
    expect(scrolledRight, 'the table scrolls inside itself').toBeGreaterThan(0)

    const widths = await page.evaluate(() => {
      const pane = document.querySelector('.wb-artifact') as HTMLElement | null
      const body = document.querySelector('.wb-artifact .md-body') as HTMLElement | null
      const para = Array.from(document.querySelectorAll('.wb-artifact .md-body p')).find((p) =>
        (p.textContent ?? '').includes('bbm18-para')
      ) as HTMLElement | undefined
      const overflow: number[] = []
      if (pane) {
        for (const n of [pane, ...Array.from(pane.querySelectorAll('*'))]) {
          const el = n as HTMLElement
          if (el.closest('.md-table-wrap')) continue
          overflow.push(el.scrollWidth - el.clientWidth)
        }
      }
      return {
        paragraph: para ? para.getBoundingClientRect().width : -1,
        bodyWidth: body ? body.clientWidth : -1,
        worstOverflow: overflow.length ? Math.max(...overflow) : -1
      }
    })
    expect(widths.paragraph).toBeGreaterThan(0)
    expect(widths.paragraph).toBeLessThanOrEqual(widths.bodyWidth + 1)
    expect(widths.worstOverflow, 'no horizontal scrollbar outside the table').toBeLessThanOrEqual(1)

    const sticky = await page.evaluate(() => {
      const wrapEl = document.querySelector('.wb-artifact .md-body .md-table-wrap') as HTMLElement
      wrapEl.scrollTop = wrapEl.scrollHeight / 2
      const th = wrapEl.querySelector('th') as HTMLElement
      return {
        scrolled: wrapEl.scrollTop,
        headerTop: th.getBoundingClientRect().top,
        boxTop: wrapEl.getBoundingClientRect().top
      }
    })
    expect(sticky.scrolled, 'really scrolled inside the table').toBeGreaterThan(0)
    expect(
      Math.abs(sticky.headerTop - sticky.boxTop),
      'header row pinned to the top of the table box'
    ).toBeLessThan(8)
  })

  test('BB-M19 find-in-page still hits body text, once a click has given the panel the focus ⌘F needs', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    writeFile(
      env,
      'bbm19.md',
      '# BB-M19\n\nThe first orange is in the body.\n\n' +
        fence('mermaid', 'flowchart TD\n  s1[grape] --> s2[melon]') +
        '\n$$\\frac{a}{b}$$\n\n' +
        '> [!NOTE]\n> A callout body.\n\n' +
        'The second orange is in the body too.\n\n' +
        fence('ts', 'const orangeCount = 2')
    )

    await openInPreview(page, env, 'bbm19.md')
    await expect(renderedDiagrams(page)).toHaveCount(1, { timeout: 60_000 })
    await expect(mdBody(page).locator(' .katex-display')).toHaveCount(1)

    await mdBody(page).click({ position: { x: 4, y: 4 } })
    await sendShortcut(app, 'shortcut:find')
    const bar = page.locator('.find-bar')
    await expect(bar).toBeVisible()
    await expect(bar.locator('.find-input')).toBeFocused()
    await page.keyboard.type('orange')

    await expect(bar.locator('.find-count')).toHaveText(/^\d+\/3$/, { timeout: 15_000 })

    const hits = await page.evaluate(() => {
      interface RangeLike {
        startContainer: Node
        endContainer: Node
        startOffset: number
        endOffset: number
        getBoundingClientRect?: () => DOMRect
        toString?: () => string
      }
      interface HighlightLike {
        [Symbol.iterator](): Iterator<RangeLike>
      }
      interface RegistryLike {
        [Symbol.iterator](): Iterator<[string, HighlightLike]>
      }
      const textOf = (r: RangeLike): string => {
        if (r.startContainer === r.endContainer && r.startContainer.nodeType === 3) {
          return (r.startContainer.textContent ?? '').slice(r.startOffset, r.endOffset)
        }
        return r.toString ? r.toString() : ''
      }
      const out = new Map<string, string>()
      const registry = (CSS as unknown as { highlights?: RegistryLike }).highlights
      if (registry) {
        for (const [, highlight] of registry) {
          for (const range of highlight) {
            const rect = range.getBoundingClientRect ? range.getBoundingClientRect() : null
            if (!rect || rect.width <= 0) continue
            out.set(
              `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}`,
              textOf(range)
            )
          }
        }
      }
      for (const mark of Array.from(document.querySelectorAll('.wb-artifact mark'))) {
        const rect = mark.getBoundingClientRect()
        if (rect.width <= 0) continue
        out.set(
          `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}`,
          mark.textContent ?? ''
        )
      }
      return Array.from(out.values())
    })
    expect(hits.length, 'one highlight per match').toBe(3)
    for (const hit of hits) expect(hit.toLowerCase()).toBe('orange')
  })

  test('BB-M20 diagram opens enlarged on click, Esc closes it, source can be copied', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const src = 'flowchart TD\n  A[bbm20node] --> B[tail]'
    writeFile(env, 'bbm20.md', '# BB-M20\n\n' + fence('mermaid', src))

    await openInPreview(page, env, 'bbm20.md')
    await expect(renderedDiagrams(page)).toHaveCount(1, { timeout: 60_000 })

    const zoom = page.locator('.mmd-zoom')
    const coverage = async (): Promise<{ w: number; h: number }> =>
      page.evaluate(() => {
        const layer = document.querySelector('.mmd-zoom') as HTMLElement
        const pane = document.querySelector('.wb-artifact') as HTMLElement
        const l = layer.getBoundingClientRect()
        const p = pane.getBoundingClientRect()
        return { w: l.width / p.width, h: l.height / p.height }
      })

    await withClipboardRestored(app, async () => {
      await diagramBoxes(page).first().click()
      await expect(zoom).toBeVisible({ timeout: 20_000 })
      const first = await coverage()
      expect(first.w).toBeGreaterThanOrEqual(0.9)
      expect(first.h).toBeGreaterThanOrEqual(0.9)

      await zoom.locator('button.mmd-copy').click()
      await expect
        .poll(async () => normalizeCopied(await clipboardText(app)), { timeout: 15_000 })
        .toBe(src)

      await page.keyboard.press('Escape')
      await expect(page.locator('.mmd-zoom')).toHaveCount(0)
      await expect(mdBody(page)).toBeVisible()

      await diagramBoxes(page).first().click()
      await expect(zoom).toBeVisible({ timeout: 20_000 })
      const second = await coverage()
      expect(second.w).toBeGreaterThanOrEqual(0.9)
      expect(second.h).toBeGreaterThanOrEqual(0.9)

      const box = await zoom.boundingBox()
      expect(box).toBeTruthy()
      await zoom.click({ position: { x: 6, y: (box?.height ?? 20) - 6 } })
      await expect(page.locator('.mmd-zoom')).toHaveCount(0)
      await expect(mdBody(page)).toBeVisible()
    })
  })

  test('BB-M21 diagrams below the first screen render only when scrolled to', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    writeFile(
      env,
      'bbm21.md',
      '# BB-M21\n\n' +
        fence('mermaid', 'flowchart TD\n  t1[bbm21top] --> t2[tail]') +
        '\n' +
        filler(300, 'bbm21') +
        '\n\n' +
        fence('mermaid', 'flowchart TD\n  u1[bbm21bottom] --> u2[tail]')
    )

    await openInPreview(page, env, 'bbm21.md')

    await expect(renderedDiagrams(page)).toHaveCount(1, { timeout: 60_000 })
    await page.waitForTimeout(ROOM_FOR_A_WRONG_EAGER_RENDER_MS)
    await expect(renderedDiagrams(page)).toHaveCount(1)

    await scrollThroughPreview(page)
    await expect(renderedDiagrams(page)).toHaveCount(2, { timeout: 60_000 })
  })

  test('BB-M22 the same diagram repeated in one document shows every time', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const src = 'flowchart LR\n  x1[bbm22node] --> x2[tail]'
    writeFile(
      env,
      'bbm22.md',
      '# BB-M22\n\n' + fence('mermaid', src) + '\n' + fence('mermaid', src)
    )

    await openInPreview(page, env, 'bbm22.md')
    await scrollThroughPreview(page)

    await expect(renderedDiagrams(page)).toHaveCount(2, { timeout: 60_000 })
    await expect(mdBody(page).locator('.mmd > svg', { hasText: 'bbm22node' })).toHaveCount(2)
  })

  test('BB-M23 editing a diagram’s source updates the diagram on screen', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const second = fence('mermaid', 'flowchart TD\n  b1[Bravo] --> b2[Tail]')
    const before =
      '# BB-M23\n\n' + fence('mermaid', 'flowchart TD\n  a1[Alpha] --> a2[Tail]') + '\n' + second
    const after =
      '# BB-M23\n\n' + fence('mermaid', 'flowchart TD\n  a1[Charlie] --> a2[Tail]') + '\n' + second
    const doc = writeFile(env, 'bbm23.md', before)

    await openInPreview(page, env, 'bbm23.md')
    await scrollThroughPreview(page)
    await expect(renderedDiagrams(page)).toHaveCount(2, { timeout: 90_000 })

    await watchDiagrams(page, 'Bravo')
    fs.writeFileSync(doc, after)

    await expect(mdBody(page).locator('.mmd > svg', { hasText: 'Charlie' })).toHaveCount(1, {
      timeout: 30_000
    })
    await expect(diagramBoxes(page).first().locator('svg')).toContainText('Charlie')
    expect((await mdBody(page).textContent()) ?? '').not.toContain('Alpha')
    await expect(mdBody(page).locator('.mmd > svg', { hasText: 'Bravo' })).toHaveCount(1)

    const watch = await readDiagramWatch(page)
    expect(watch.samples, 'the watcher really sampled').toBeGreaterThan(
      ENOUGH_SAMPLES_TO_PROVE_THE_WATCHER_RAN
    )
    expect(watch.min, 'the untouched diagram never blanked out').toBeGreaterThanOrEqual(1)
  })

  test('BB-M24 outline highlights the section being read', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    writeFile(
      env,
      'bbm24.md',
      ['Alpha', 'Bravo', 'Charlie']
        .map(
          (name, i) =>
            `## ${name}\n\n` +
            filler(40, `bbm24-${i}-head`) +
            `\n\nbbm24-${name}-middle mid-section marker.\n\n` +
            filler(40, `bbm24-${i}-tail`)
        )
        .join('\n\n')
    )

    await openInPreview(page, env, 'bbm24.md')

    await outlineToggle(page).click({ timeout: 30_000 })
    const current = page.locator('.outline-list .outline-it.cur')
    await expect(current).toHaveCount(1, { timeout: 20_000 })
    await expect(current).toHaveText(/Alpha/)

    await mdBody(page)
      .locator('p', { hasText: 'bbm24-Bravo-middle' })
      .first()
      .evaluate((el) => el.scrollIntoView({ block: 'start' }))

    await expect(current).toHaveText(/Bravo/, { timeout: 20_000 })
    await expect(page.locator('.outline-list .outline-it.cur')).toHaveCount(1)
  })
})
