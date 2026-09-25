import fs from 'fs'
import path from 'path'
import type { ElectronApplication, JSHandle, Locator, Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import { startSessionIn, waitBooted, wsRows } from './helpers/p1'
import { openTabs, pinnedTab } from './helpers/browser'
import { artifactBody, openFileTab, WORKBENCH } from './helpers/workbench'
import type { E2EEnv } from './helpers/env'

const PIC = path.join(__dirname, 'fixtures', 'md-preview', 'c-pic.png')

function write(ws: string, rel: string, body: string): string {
  const full = path.join(ws, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
  return full
}

function fence(lang: string, body: string): string {
  return '```' + lang + '\n' + body + '\n```'
}

function emptyFence(lang: string): string {
  return '```' + lang + '\n```'
}

function mermaidOfLength(len: number, marker: string): string {
  const head = 'flowchart TD\n%% '
  const tail = `\n  A[${marker}] --> B[${marker}End]`
  const pad = 'x'.repeat(len - head.length - tail.length)
  return head + pad + tail
}

function flow(marker: string): string {
  return `flowchart TD\n  ${marker}A[${marker}] --> ${marker}B[${marker}End]`
}

function lines(n: number, make: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => make(i + 1)).join('\n')
}

async function putSessionOnScreen(page: Page): Promise<void> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
}

async function openDoc(page: Page, env: E2EEnv, rel: string): Promise<void> {
  await openFileTab(page, env, path.join(env.workspaces.a, rel))
  await expect(artifactTitle(page)).toHaveText(rel, { timeout: 30_000 })
}

function artifactTitle(page: Page): Locator {
  return page.locator(WORKBENCH.artifactTitle)
}

function outlineToggle(page: Page): Locator {
  return page.locator(WORKBENCH.outline)
}

function mdBody(page: Page): Locator {
  return artifactBody(page).locator('.md-body')
}

function diagrams(page: Page): Locator {
  return mdBody(page).locator('.mmd svg')
}

function bodyText(page: Page): Promise<string> {
  return mdBody(page).innerText()
}

async function renderedText(page: Page, marker: string): Promise<string> {
  await expect(mdBody(page)).toContainText(marker, { timeout: 30_000 })
  return bodyText(page)
}

async function scroller(page: Page): Promise<JSHandle<HTMLElement>> {
  return page.evaluateHandle(() => {
    const bodies = Array.from(document.querySelectorAll<HTMLElement>('.md-body'))
    const body =
      bodies.find(
        (el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden'
      ) ?? bodies[0]
    let el: HTMLElement | null = body ?? null
    while (el) {
      if (el.scrollHeight > el.clientHeight + 1) return el
      el = el.parentElement
    }
    return body
  })
}

async function scrollTopOf(page: Page): Promise<number> {
  const h = await scroller(page)
  return h.evaluate((el) => el.scrollTop)
}

async function setScrollTop(page: Page, top: number): Promise<void> {
  const h = await scroller(page)
  await h.evaluate((el, t) => {
    el.scrollTop = t
  }, top)
}

async function scrollStep(page: Page): Promise<boolean> {
  const h = await scroller(page)
  return h.evaluate((el) => {
    const before = el.scrollTop
    el.scrollTop = Math.min(before + el.clientHeight * 0.6, el.scrollHeight)
    return el.scrollTop <= before
  })
}

async function scrollToBottom(page: Page, steps = 60, pause = 350): Promise<void> {
  for (let i = 0; i < steps; i++) {
    const atEnd = await scrollStep(page)
    await page.waitForTimeout(pause)
    if (atEnd) return
  }
}

interface CopyRecorder {
  __koloftCopied?: string[]
}

async function armCopySpy(app: ElectronApplication, page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as CopyRecorder
    const seen: string[] = []
    w.__koloftCopied = seen
    const nav = navigator as Navigator & { clipboard?: Clipboard }
    if (nav.clipboard) {
      const proto = Object.getPrototypeOf(nav.clipboard) as {
        writeText: (t: string) => Promise<void>
      }
      proto.writeText = (t: string): Promise<void> => {
        seen.push(String(t))
        return Promise.resolve()
      }
    }
    const orig = document.execCommand.bind(document)
    document.execCommand = (cmd: string, showUI?: boolean, value?: string): boolean => {
      if (cmd === 'copy') {
        const active = document.activeElement
        const fromField =
          active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
            ? active.value
            : ''
        seen.push(fromField || String(document.getSelection() ?? ''))
        return true
      }
      return orig(cmd, showUI, value)
    }
  })
  await app.evaluate(({ clipboard }) => {
    const g = globalThis as typeof globalThis & CopyRecorder
    const seen: string[] = []
    g.__koloftCopied = seen
    clipboard.writeText = (text: string): void => {
      seen.push(text)
    }
  })
}

async function copiedTexts(app: ElectronApplication, page: Page): Promise<string[]> {
  const fromPage = await page.evaluate(
    () => (window as unknown as CopyRecorder).__koloftCopied ?? []
  )
  const fromMain = await app.evaluate(
    () => (globalThis as typeof globalThis & CopyRecorder).__koloftCopied ?? []
  )
  return [...fromPage, ...fromMain]
}

function sameSource(copied: string, source: string): boolean {
  return copied.replace(/\n$/, '') === source.replace(/\n$/, '')
}

async function textColors(el: Locator): Promise<string[]> {
  return el.evaluate((root) => {
    const seen = new Set<string>()
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walk.nextNode()
    const enoughColoursToTellHighlighted = 4
    while (node && seen.size < enoughColoursToTellHighlighted) {
      const parent = node.parentElement
      if (parent && (node.textContent ?? '').trim()) {
        seen.add(getComputedStyle(parent).color)
      }
      node = walk.nextNode()
    }
    return Array.from(seen)
  })
}

test.describe('rich Markdown preview corner cases — black-box against each case’s Given/When/Then and the DOM contract, never reading the real clipboard', () => {
  test('BB-C01 a diagram with broken syntax shows an error card, the rest renders as usual', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const broken = 'flowchart TD\n  @@@ ??? ###'
    write(
      ws,
      'c01.md',
      [
        '# C01',
        '',
        'body-one-C01',
        '',
        fence('mermaid', broken),
        '',
        'body-two-C01',
        '',
        fence('mermaid', flow('C01ok')),
        ''
      ].join('\n')
    )

    await putSessionOnScreen(page)
    await armCopySpy(app, page)
    await openDoc(page, env, 'c01.md')
    await scrollToBottom(page)

    const card = mdBody(page).locator('.mmd-error')
    await expect(card).toHaveCount(1, { timeout: 60_000 })
    await expect(card.locator('.mmd-error-msg')).not.toBeEmpty()
    await expect(card.locator('pre')).toContainText('@@@ ??? ###')

    await card.locator('button.mmd-copy').click()
    await expect
      .poll(async () => (await copiedTexts(app, page)).some((t) => sameSource(t, broken)), {
        timeout: 15_000
      })
      .toBe(true)

    const text = await bodyText(page)
    expect(text).toContain('body-one-C01')
    expect(text).toContain('body-two-C01')
    await expect(mdBody(page).locator('.mmd svg')).toHaveCount(1, { timeout: 60_000 })
    await expect(mdBody(page).locator('.mmd svg')).toContainText('C01ok')
  })

  test('BB-C02 diagram source over the limit is not rendered and shows a notice', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(
      ws,
      'c02.md',
      [
        '# C02',
        '',
        fence('mermaid', mermaidOfLength(50001, 'C02BIG')),
        '',
        'tail-body-C02',
        ''
      ].join('\n')
    )

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c02.md')

    const toobig = mdBody(page).locator('.mmd-toobig')
    await expect(toobig).toHaveCount(1, { timeout: 60_000 })
    await expect(toobig.locator('pre')).toContainText('C02BIG')
    await expect(mdBody(page).locator('.mmd svg')).toHaveCount(0)
    const notice = await toobig.evaluate((el) => {
      const clone = el.cloneNode(true) as HTMLElement
      clone.querySelectorAll('pre').forEach((p) => p.remove())
      return (clone.textContent ?? '').trim()
    })
    expect(notice.length).toBeGreaterThan(0)
    expect(await bodyText(page)).toContain('tail-body-C02')
  })

  test('BB-C03 diagram source exactly at the limit renders normally', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(
      ws,
      'c03.md',
      ['# C03', '', fence('mermaid', mermaidOfLength(50000, 'C03ok')), ''].join('\n')
    )

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c03.md')

    await expect(diagrams(page)).toHaveCount(1, { timeout: 120_000 })
    await expect(mdBody(page).locator('.mmd-toobig')).toHaveCount(0)
  })

  test('BB-C04 an empty diagram fence shows an error card and does not affect the document', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(
      ws,
      'c04.md',
      ['# C04', '', emptyFence('mermaid'), '', 'following-body-C04', ''].join('\n')
    )

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c04.md')

    await expect(mdBody(page).locator('.mmd-error')).toHaveCount(1, { timeout: 60_000 })
    expect(await bodyText(page)).toContain('following-body-C04')
    await expect(mdBody(page).locator('.mmd svg')).toHaveCount(0)
  })

  test('BB-C05 file changed while rendering shows only the new content — opened with openFileTab, not openDoc, whose title wait would let the first render settle and remove the race', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const v1 = [
      '# C05',
      '',
      'version-one-C05',
      '',
      ...[1, 2, 3, 4, 5].map((i) => fence('mermaid', flow(`C05v1n${i}`)) + '\n'),
      ''
    ].join('\n')
    const v2 = ['# C05', '', 'version-two-C05', '', fence('mermaid', flow('C05v2')), ''].join('\n')
    const file = write(ws, 'c05.md', v1)

    await putSessionOnScreen(page)
    await openFileTab(page, env, file)
    await mdBody(page).waitFor({ state: 'attached', timeout: 30_000 })
    fs.writeFileSync(file, v2)

    await expect(mdBody(page)).toContainText('version-two-C05', { timeout: 30_000 })
    await scrollToBottom(page)
    expect(await bodyText(page)).not.toContain('version-one-C05')
    await expect(mdBody(page).locator('.mmd')).toHaveCount(1, { timeout: 30_000 })
  })

  test('BB-C06 an image outside the workspace loads, since images have no workspace fence; a missing one shows the placeholder', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const outside = path.join(env.home, 'outside-c06')
    fs.mkdirSync(outside, { recursive: true })
    const pic = path.join(outside, 'pic.png')
    fs.copyFileSync(PIC, pic)
    const missing = path.join(outside, 'no-such-pic.png')
    write(
      ws,
      'c06.md',
      ['# C06', '', `![outside image](${pic})`, '', `![missing image](${missing})`, ''].join('\n')
    )

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c06.md')

    const img = mdBody(page).locator('img')
    await expect(img).toHaveCount(1, { timeout: 30_000 })
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 })
      .toBeGreaterThan(0)

    const holder = mdBody(page).locator(`:text("${missing}")`).last()
    await expect(holder).toBeVisible({ timeout: 30_000 })
    expect(await bodyText(page)).toContain(missing)
    const box = await holder.boundingBox()
    expect(box).not.toBeNull()
    expect((box?.width ?? 0) * (box?.height ?? 0)).toBeGreaterThan(0)
  })

  test('BB-C19 a relative image in a parent directory can be shown', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
    fs.copyFileSync(PIC, path.join(ws, 'assets', 'pic.png'))
    write(ws, 'docs/c19.md', ['# C19', '', '![image](../assets/pic.png)', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'docs/c19.md')

    const img = mdBody(page).locator('img')
    await expect(img).toHaveCount(1, { timeout: 30_000 })
    await expect
      .poll(
        () =>
          img.evaluate((el) => {
            const i = el as HTMLImageElement
            return Math.min(i.naturalWidth, i.naturalHeight)
          }),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)
  })

  test('BB-C30 a remote image is not loaded and shows a placeholder', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const url = 'https://img.example.com/badge.svg'
    write(ws, 'c30.md', ['# C30', '', `![badge](${url})`, ''].join('\n'))

    const requested: string[] = []
    page.on('request', (r) => requested.push(r.url()))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c30.md')

    const blocked = mdBody(page).locator('.md-img-blocked')
    await expect(blocked).toHaveCount(1, { timeout: 30_000 })
    await expect(blocked).toContainText(url)
    await page.waitForTimeout(3000)
    expect(requested.filter((u) => u.includes('img.example.com'))).toEqual([])
  })

  test('BB-C07 clicking a reference to a missing file does nothing quietly', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(
      ws,
      'c07.md',
      ['# C07', '', 'See the no-such-file.ts:9 section.', '', 'marker-C07', ''].join('\n')
    )

    const dialogs: string[] = []
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.dismiss()
    })

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c07.md')

    await mdBody(page)
      .locator('a.md-fileref', { hasText: 'no-such-file.ts:9' })
      .click({ timeout: 30_000 })
    await page.waitForTimeout(3000)

    await expect(artifactTitle(page)).toHaveText('c07.md')
    expect(await bodyText(page)).toContain('marker-C07')
    expect(dialogs).toEqual([])
    await expect(page.locator('.modal')).toHaveCount(0)
  })

  test('BB-C38 clicking a path reference that resolves outside the workspace and the document’s directory does nothing, silently', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const outside = path.join(env.home, 'outside-c38')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(
      path.join(outside, 'secret.ts'),
      ['const a = 1', '// C38_ESCAPED_MARK', 'const c = 3'].join('\n') + '\n'
    )
    write(
      ws,
      'sub38/c38.md',
      [
        '# C38',
        '',
        'See line ../../outside-c38/secret.ts:2 for details.',
        '',
        'marker-C38',
        ''
      ].join('\n')
    )

    const dialogs: string[] = []
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.dismiss()
    })

    await putSessionOnScreen(page)
    await openDoc(page, env, 'sub38/c38.md')

    await mdBody(page)
      .locator('a.md-fileref', { hasText: 'outside-c38/secret.ts:2' })
      .click({ timeout: 30_000 })
    await page.waitForTimeout(3000)

    await expect(artifactTitle(page)).toHaveText('sub38/c38.md')
    expect(await bodyText(page)).toContain('marker-C38')
    expect(await artifactBody(page).innerText()).not.toContain('C38_ESCAPED_MARK')
    expect(dialogs).toEqual([])
    await expect(page.locator('.toast')).toHaveCount(0)
    await expect(page.locator('.modal')).toHaveCount(0)
  })

  test('an absolute path:line reference that climbs out with .. (/ws/../../x:1) and a plain <a href="../.."> link both do nothing when the target resolves outside the workspace fence', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const outside = path.join(env.home, 'outside-climb')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(
      path.join(outside, 'secret.ts'),
      ['const a = 1', 'const CLIMB_ESCAPED_MARK = 2', 'const c = 3'].join('\n') + '\n'
    )
    const climbingRef = `${ws}/sub-climb/../../outside-climb/secret.ts:2`
    write(
      ws,
      'sub-climb/climb.md',
      [
        '# Climb',
        '',
        'See `' + climbingRef + '` for details.',
        '',
        'Or <a href="../../outside-climb/secret.ts">climb-link</a> instead.',
        '',
        'marker-climb',
        ''
      ].join('\n')
    )

    const dialogs: string[] = []
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.dismiss()
    })

    await putSessionOnScreen(page)
    await openDoc(page, env, 'sub-climb/climb.md')

    const stillOnTheDocument = async (): Promise<void> => {
      await page.waitForTimeout(3000)
      await expect(artifactTitle(page)).toHaveText('sub-climb/climb.md')
      expect(await bodyText(page)).toContain('marker-climb')
      expect(await artifactBody(page).innerText()).not.toContain('CLIMB_ESCAPED_MARK')
      expect(dialogs).toEqual([])
      await expect(page.locator('.toast')).toHaveCount(0)
      await expect(page.locator('.modal')).toHaveCount(0)
    }

    await mdBody(page)
      .locator('a.md-fileref', { hasText: 'outside-climb/secret.ts:2' })
      .click({ timeout: 30_000 })
    await stillOnTheDocument()

    await mdBody(page).locator('a', { hasText: 'climb-link' }).click({ timeout: 30_000 })
    await stillOnTheDocument()
  })

  test('a formula KaTeX refuses shows the author’s own source text, never KaTeX’s ParseError message — even a source holding --> or ]>', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const refusedInline = ['\\koloftbad{x}', '\\koloftbad{a-->b}', '\\koloftbad{c]>d}']
    const refusedBlock = '\\koloftbad{e-->f]>g}'
    write(
      ws,
      'katex-refused.md',
      [
        '# Refused',
        '',
        ...refusedInline.map((src) => 'Inline $' + src + '$ here.'),
        '',
        '$$',
        refusedBlock,
        '$$',
        '',
        'marker-refused',
        ''
      ].join('\n')
    )

    await putSessionOnScreen(page)
    await openDoc(page, env, 'katex-refused.md')

    await expect(mdBody(page)).toContainText('marker-refused', { timeout: 30_000 })
    await expect(mdBody(page).locator('.katex-error')).toHaveText(
      [...refusedInline, refusedBlock],
      { timeout: 30_000 }
    )
    await expect(mdBody(page)).not.toContainText(/parse ?error/i)
  })

  test('BB-C08 money amounts do not swallow the body text', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(
      ws,
      'c08.md',
      ['# C08', '', 'Spent $100 this month, budget $200 next month.', ''].join('\n')
    )

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c08.md')

    const text = await renderedText(page, 'Spent')
    expect(text).toContain('Spent')
    expect(text).toContain('budget')
    expect(text).toContain('100')
    expect(text).toContain('200')
  })

  test('BB-C29 dollar signs in code are not treated as formulas', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(
      ws,
      'c29.md',
      [
        '# C29',
        '',
        fence('bash', 'echo $HOME\ncp $1 $2'),
        '',
        'Inline `$PATH` ends here.',
        ''
      ].join('\n')
    )

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c29.md')

    const text = await renderedText(page, 'echo $HOME')
    expect(text).toContain('echo $HOME')
    expect(text).toContain('cp $1 $2')
    expect(text).toContain('$PATH')
    await expect(mdBody(page).locator('.md-code .katex')).toHaveCount(0)
    await expect(mdBody(page).locator('p code .katex')).toHaveCount(0)
  })

  test('BB-C09 a code block in an unsupported language falls back to plain text but can still be copied', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const src = 'defmodule C09 do\n  def hello, do: :world\nend'
    write(ws, 'c09.md', ['# C09', '', fence('elixir', src), ''].join('\n'))

    await putSessionOnScreen(page)
    await armCopySpy(app, page)
    await openDoc(page, env, 'c09.md')

    const block = mdBody(page).locator('.md-code')
    await expect(block).toHaveCount(1, { timeout: 30_000 })
    expect(await block.innerText()).toContain('defmodule C09 do')
    expect(await block.innerText()).toContain('def hello, do: :world')

    await block.locator('button.md-code-copy').click()
    await expect
      .poll(async () => (await copiedTexts(app, page)).some((t) => sameSource(t, src)), {
        timeout: 15_000
      })
      .toBe(true)
  })

  test('BB-C10 a very long code block skips highlighting but is still shown in full', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const ws = env.workspaces.a
    const body = lines(2001, (i) =>
      i === 1 ? 'const c10First = 1' : i === 2001 ? 'const c10Last = 2001' : `const v${i} = ${i}`
    )
    write(ws, 'c10.md', ['# C10', '', fence('ts', body), ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c10.md')

    const pre = mdBody(page).locator('.md-code pre')
    await expect(pre).toHaveCount(1, { timeout: 60_000 })
    await expect.poll(async () => (await textColors(pre)).length, { timeout: 60_000 }).toBe(1)
    const text = await pre.innerText()
    expect(text).toContain('const c10First = 1')
    expect(text).toContain('const c10Last = 2001')
  })

  test('BB-C11 a code block exactly at the line limit is still highlighted', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const ws = env.workspaces.a
    const body = lines(2000, (i) => `const v${i} = ${i}`)
    write(ws, 'c11.md', ['# C11', '', fence('ts', body), ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c11.md')

    const pre = mdBody(page).locator('.md-code pre')
    await expect(pre).toHaveCount(1, { timeout: 60_000 })
    await expect
      .poll(async () => (await textColors(pre)).length, { timeout: 120_000 })
      .toBeGreaterThanOrEqual(2)
  })

  test('BB-C12 an empty code fence does not error', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(ws, 'c12.md', ['# C12', '', emptyFence('bash'), '', 'following-body-C12', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c12.md')

    const block = mdBody(page).locator('.md-code')
    await expect(block).toHaveCount(1, { timeout: 30_000 })
    await expect(block.locator('.md-code-lang')).toHaveText('bash')
    await expect(block.locator('button.md-code-copy')).toHaveCount(1)
    expect((await block.locator('pre').innerText()).trim()).toBe('')
    expect(await bodyText(page)).toContain('following-body-C12')
  })

  test('BB-C13 opening an empty document does not error, and its ≡ stays in the kind bar, disabled', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(ws, 'c13.md', '')

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c13.md')

    await expect(mdBody(page)).toHaveCount(1, { timeout: 30_000 })
    await page.waitForTimeout(2000)
    expect((await bodyText(page)).trim()).toBe('')
    await expect(outlineToggle(page)).toBeDisabled()
    await expect(page.locator('.outline-list')).toHaveCount(0)
  })

  test('BB-C14 a document with no headings shows no outline toggle — the kind bar’s ≡ stays, disabled', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(ws, 'c14.md', ['para-one-C14', '', 'para-two-C14', '', 'para-three-C14', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c14.md')

    await expect(mdBody(page)).toContainText('para-three-C14', { timeout: 30_000 })
    await expect(outlineToggle(page)).toBeDisabled()
    await expect(page.locator('.outline-list')).toHaveCount(0)
  })

  test('BB-C15 invalid front matter is shown as a code block', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(ws, 'c15.md', ['---', 'a: [1, 2', '---', '', 'body-C15', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c15.md')

    await expect(mdBody(page)).toContainText('body-C15', { timeout: 30_000 })
    await expect(mdBody(page).locator('pre')).toContainText('a: [1, 2')
    await expect(mdBody(page).locator('.md-frontmatter')).toHaveCount(0)
  })

  test('BB-C16 empty front matter does not produce an empty card', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(ws, 'c16.md', ['---', '---', '', 'first-para-C16', '', 'second-para-C16', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c16.md')

    await expect(mdBody(page)).toContainText('first-para-C16', { timeout: 30_000 })
    await expect(mdBody(page).locator('.md-frontmatter')).toHaveCount(0)
    const first = await mdBody(page).evaluate((el) =>
      (el.firstElementChild?.textContent ?? '').trim()
    )
    expect(first).toContain('first-para-C16')
  })

  test('BB-C35 list values in front matter are shown verbatim', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(ws, 'c35.md', ['---', 'tags: [a, b]', 'owner: koh', '---', '', 'body-C35', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c35.md')

    const card = mdBody(page).locator('.md-frontmatter')
    await expect(card).toHaveCount(1, { timeout: 30_000 })
    const keys = (await card.locator('.md-fm-key').allInnerTexts()).join('\n')
    const vals = (await card.locator('.md-fm-val').allInnerTexts()).join('\n')
    expect(keys).toContain('tags')
    expect(keys).toContain('owner')
    expect(vals).toContain('[a, b]')
    expect(vals).toContain('koh')
    await expect(card.locator('li')).toHaveCount(0)
  })

  test('BB-C17 diagrams nested inside lists and alert blocks still render', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const ws = env.workspaces.a
    const inList = [
      '- list-item-C17',
      '',
      '  ```mermaid',
      '  flowchart TD',
      '    L1[C17list] --> L2[C17listEnd]',
      '  ```'
    ].join('\n')
    const inAlert = [
      '> [!NOTE]',
      '> note-C17',
      '>',
      '> ```mermaid',
      '> flowchart TD',
      '>   N1[C17note] --> N2[C17noteEnd]',
      '> ```'
    ].join('\n')
    write(ws, 'c17.md', ['# C17', '', inList, '', inAlert, ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c17.md')
    await scrollToBottom(page)

    await expect(diagrams(page)).toHaveCount(2, { timeout: 120_000 })
    await expect(mdBody(page).locator('li .mmd svg')).toHaveCount(1)
    await expect(mdBody(page).locator('.md-alert .mmd svg')).toHaveCount(1)
  })

  test('BB-C18 all diagrams show even when their count exceeds the cache size', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(600_000)
    const ws = env.workspaces.a
    const parts: string[] = ['# C18', '']
    for (let i = 1; i <= 60; i++) {
      parts.push(`para ${i}-C18`, '', fence('mermaid', flow(`C18n${i}`)), '')
    }
    write(ws, 'c18.md', parts.join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c18.md')

    await expect
      .poll(
        async () => {
          await scrollStep(page)
          return diagrams(page).count()
        },
        { timeout: 480_000, intervals: [500] }
      )
      .toBe(60)
    await expect(mdBody(page).locator('.mmd-error')).toHaveCount(0)

    await setScrollTop(page, 0)
    await page.waitForTimeout(2000)
    const first = mdBody(page).locator('.mmd').nth(0)
    const second = mdBody(page).locator('.mmd').nth(1)
    await expect(first.locator('svg')).toHaveCount(1)
    await expect(second.locator('svg')).toHaveCount(1)
    await expect(first.locator('svg')).toContainText('C18n1')
    await expect(second.locator('svg')).toContainText('C18n2')
  })

  test('BB-C37 a very wide diagram scrolls sideways inside its own container', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const ws = env.workspaces.a
    const chain = Array.from({ length: 60 }, (_, i) => `W${i}[wide_node_${i}]`).join(' --> ')
    write(
      ws,
      'c37.md',
      ['# C37', '', 'body-para-C37', '', fence('mermaid', `flowchart LR\n  ${chain}`), ''].join(
        '\n'
      )
    )

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c37.md')

    const para = mdBody(page).locator('p', { hasText: 'body-para-C37' })
    await expect(mdBody(page).locator('.mmd')).toHaveCount(1, { timeout: 30_000 })
    const widthBefore = await para.evaluate((el) => (el as HTMLElement).clientWidth)

    await expect(diagrams(page)).toHaveCount(1, { timeout: 180_000 })
    await page.waitForTimeout(1500)

    expect(await para.evaluate((el) => (el as HTMLElement).clientWidth)).toBe(widthBefore)
    const pageOverflow = await (
      await scroller(page)
    ).evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(pageOverflow).toBeLessThanOrEqual(1)
    const box = await mdBody(page)
      .locator('.mmd')
      .evaluate((el) => ({
        overflowX: getComputedStyle(el).overflowX,
        over: el.scrollWidth - el.clientWidth
      }))
    expect(box.over).toBeGreaterThan(1)
    expect(['auto', 'scroll']).toContain(box.overflowX)
  })

  test('BB-C20 the same document open in two tabs at once renders fully in both — two file tabs mounted together, then two sessions in turn', async ({
    page,
    env
  }) => {
    test.setTimeout(600_000)
    const ws = env.workspaces.a
    const doc = [
      '# C20',
      '',
      'marker-C20',
      '',
      fence('mermaid', flow('C20one')),
      '',
      fence('mermaid', flow('C20two')),
      ''
    ].join('\n')
    write(ws, 'c20.md', doc)
    write(ws, 'c20-copy.md', doc)

    await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
    await startSessionIn(page, 'ws-a')
    await startSessionIn(page, 'ws-a')
    const rows = wsRows(page, 'ws-a')
    await expect(rows).toHaveCount(2)

    await rows.nth(0).click()
    await openDoc(page, env, 'c20.md')
    await scrollToBottom(page)
    await expect(diagrams(page)).toHaveCount(2, { timeout: 120_000 })
    await openDoc(page, env, 'c20-copy.md')
    await scrollToBottom(page)
    await expect(diagrams(page)).toHaveCount(2, { timeout: 120_000 })

    await expect
      .poll(
        () =>
          page.locator(`${WORKBENCH.artifact} .md-body`).evaluateAll((els) =>
            els.map((el) => ({
              svgs: el.querySelectorAll('.mmd svg').length,
              marked: (el.textContent ?? '').includes('marker-C20')
            }))
          ),
        { timeout: 60_000 }
      )
      .toEqual([
        { svgs: 2, marked: true },
        { svgs: 2, marked: true }
      ])

    await rows.nth(1).click()
    await openDoc(page, env, 'c20.md')
    await scrollToBottom(page)
    await expect(diagrams(page)).toHaveCount(2, { timeout: 120_000 })

    await rows.nth(0).click()
    await expect(artifactTitle(page)).toHaveText('c20-copy.md', { timeout: 30_000 })
    await expect(mdBody(page)).toBeVisible({ timeout: 30_000 })
    await scrollToBottom(page)
    await expect(diagrams(page)).toHaveCount(2, { timeout: 120_000 })
    await expect(mdBody(page)).toContainText('marker-C20')
  })

  test('BB-C25 switching away from a tab and back keeps the diagrams and the scroll position; a session round trip comes back at the same scroll position and draws every diagram again', async ({
    page,
    env
  }) => {
    test.setTimeout(600_000)
    const ws = env.workspaces.a
    const parts: string[] = ['# C25', '']
    for (let i = 1; i <= 3; i++) {
      parts.push(fence('mermaid', flow(`C25n${i}`)), '')
      for (let j = 0; j < 20; j++) parts.push(`para ${i}-${j} filler-body-C25`, '')
    }
    write(ws, 'c25.md', parts.join('\n'))

    await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
    await startSessionIn(page, 'ws-a')
    await openDoc(page, env, 'c25.md')
    await scrollToBottom(page)
    await expect(diagrams(page)).toHaveCount(3, { timeout: 180_000 })

    const h = await scroller(page)
    const middle = await h.evaluate((el) => Math.floor((el.scrollHeight - el.clientHeight) / 2))
    await setScrollTop(page, middle)
    const before = await scrollTopOf(page)
    expect(before, 'the sample really did scroll').toBeGreaterThan(0)

    await pinnedTab(page).click()
    await expect(artifactBody(page)).toHaveCount(0)
    await page.waitForTimeout(4000)
    await openTabs(page).first().click()

    await expect(diagrams(page)).toHaveCount(3, { timeout: 60_000 })
    const kept = await diagrams(page).evaluateAll((els) => els.map((e) => e.textContent ?? ''))
    expect(kept.join('|')).toContain('C25n1')
    expect(kept.join('|')).toContain('C25n2')
    expect(kept.join('|')).toContain('C25n3')
    await expect.poll(() => scrollTopOf(page), { timeout: 15_000 }).toBe(before)

    await startSessionIn(page, 'ws-b')
    await page.waitForTimeout(4000)
    await wsRows(page, 'ws-a').first().click()

    await expect(artifactTitle(page)).toHaveText('c25.md', { timeout: 30_000 })
    await expect(mdBody(page)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => scrollTopOf(page), { timeout: 15_000 }).toBe(before)
    await setScrollTop(page, 0)
    await expect(mdBody(page).locator('.mmd').first().locator('svg')).toHaveCount(1, {
      timeout: 60_000
    })
    await scrollToBottom(page)
    await expect(diagrams(page)).toHaveCount(3, { timeout: 120_000 })
    const texts = await diagrams(page).evaluateAll((els) => els.map((e) => e.textContent ?? ''))
    expect(texts.join('|')).toContain('C25n1')
    expect(texts.join('|')).toContain('C25n2')
    expect(texts.join('|')).toContain('C25n3')
  })

  test('BB-C21 clicking a task-list checkbox does not change the file on disk', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const file = write(ws, 'c21.md', ['# C21', '', '- [ ] todo one', ''].join('\n'))
    const before = fs.readFileSync(file)

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c21.md')

    const box = mdBody(page).locator('input[type=checkbox].md-task')
    await expect(box).toHaveCount(1, { timeout: 30_000 })
    await box.click({ force: true })
    await page.waitForTimeout(2000)

    expect(await box.isChecked()).toBe(false)
    expect(fs.readFileSync(file).equals(before)).toBe(true)
  })

  test('BB-C22 a path reference with a Chinese file name can jump', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(
      ws,
      'docs/设计说明.md',
      [
        '# 设计说明-C22',
        '',
        '第三行-C22',
        '',
        '第五行-C22',
        '',
        '第七行-C22',
        '',
        '第九行-C22',
        '',
        '第十一行-C22',
        ''
      ].join('\n')
    )
    write(ws, 'c22.md', ['# C22', '', 'See the docs/设计说明.md:3 section.', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c22.md')

    await mdBody(page)
      .locator('a.md-fileref', { hasText: 'docs/设计说明.md:3' })
      .click({ timeout: 30_000 })

    await expect(artifactTitle(page)).toHaveText('docs/设计说明.md', { timeout: 30_000 })
    await expect(artifactBody(page).getByText('第三行-C22').first()).toBeInViewport({
      timeout: 20_000
    })
  })

  test('BB-C27 a path reference resolves first to the file in the document’s own directory', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const root = [
      'const a = 1',
      'const b = 2',
      '// I am in the root directory',
      'const c = 3',
      'const d = 4'
    ].join('\n')
    const sub = [
      'const a = 1',
      'const b = 2',
      '// I am in the sub directory',
      'const c = 3',
      'const d = 4'
    ].join('\n')
    write(ws, 'helper.ts', root + '\n')
    write(ws, 'sub27/helper.ts', sub + '\n')
    write(ws, 'sub27/c27.md', ['# C27', '', 'See line helper.ts:3 for details.', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'sub27/c27.md')

    await mdBody(page)
      .locator('a.md-fileref', { hasText: 'helper.ts:3' })
      .click({ timeout: 30_000 })

    await expect(artifactTitle(page)).toHaveText('sub27/helper.ts', { timeout: 30_000 })
    await expect(artifactBody(page)).toContainText('I am in the sub directory', {
      timeout: 30_000
    })
    const shown = await artifactBody(page).innerText()
    expect(shown).not.toContain('I am in the root directory')
  })

  test('BB-C28 falls back to the workspace root when the document’s directory has no match', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(
      ws,
      'only-root.ts',
      [
        'const first = 1',
        '// L2_C28_MARK',
        'const third = 3',
        'const fourth = 4',
        'const fifth = 5'
      ].join('\n') + '\n'
    )
    write(ws, 'sub28/c28.md', ['# C28', '', 'See line only-root.ts:2 for details.', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'sub28/c28.md')

    await mdBody(page)
      .locator('a.md-fileref', { hasText: 'only-root.ts:2' })
      .click({ timeout: 30_000 })

    await expect(artifactTitle(page)).toHaveText('only-root.ts', { timeout: 30_000 })
    await expect(artifactBody(page).getByText('L2_C28_MARK').first()).toBeInViewport({
      timeout: 20_000
    })
  })

  test('BB-C31 a reference with a column number can jump too', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(
      ws,
      'sample.ts',
      lines(40, (i) => (i === 12 ? '// L12_C31_MARK' : `const v${i} = ${i}`)) + '\n'
    )
    write(ws, 'c31.md', ['# C31', '', 'See the spot at sample.ts:12:5 for details.', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c31.md')

    await mdBody(page)
      .locator('a.md-fileref', { hasText: 'sample.ts:12:5' })
      .click({ timeout: 30_000 })

    await expect(artifactTitle(page)).toHaveText('sample.ts', { timeout: 30_000 })
    await expect(artifactBody(page).getByText('L12_C31_MARK').first()).toBeInViewport({
      timeout: 20_000
    })
  })

  test('BB-C23 a full-width colon is not treated as a path reference', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(ws, 'c23.md', ['# C23', '', 'See the sample.ts：12 section', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c23.md')

    const para = mdBody(page).locator('p', { hasText: 'sample.ts' })
    await expect(para).toHaveCount(1, { timeout: 30_000 })
    await expect(para.locator('a')).toHaveCount(0)
    expect(await para.innerText()).toContain('See the sample.ts：12 section')
  })

  test('BB-C24 version numbers and times are not treated as path references', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(ws, 'c24.md', ['# C24', '', 'v0.13.1:12 released at 09:30', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c24.md')

    const para = mdBody(page).locator('p', { hasText: 'v0.13.1' })
    await expect(para).toHaveCount(1, { timeout: 30_000 })
    await expect(para.locator('a')).toHaveCount(0)
    expect(await para.innerText()).toContain('v0.13.1:12 released at 09:30')
  })

  test('BB-C32 paths inside a multi-line code block do not become links', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const code = ['const c32 = 1', '// see src/main/index.ts:975', 'export const f = c32'].join(
      '\n'
    )
    write(ws, 'c32.md', ['# C32', '', fence('ts', code), ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c32.md')

    const block = mdBody(page).locator('.md-code')
    await expect(block).toHaveCount(1, { timeout: 30_000 })
    await expect(block.locator('a')).toHaveCount(0)
    expect(await block.locator('pre').innerText()).toContain('// see src/main/index.ts:975')
    await expect
      .poll(async () => (await textColors(block.locator('pre'))).length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(2)
  })

  test('BB-C33 colon-number in a URL is not treated as a path reference', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(ws, 'c33.md', ['# C33', '', 'See http://localhost:3000/app.ts:12', ''].join('\n'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c33.md')

    const para = mdBody(page).locator('p', { hasText: 'localhost:3000' })
    await expect(para).toHaveCount(1, { timeout: 30_000 })
    const ref = para.locator('a.md-fileref')
    if ((await ref.count()) > 0) {
      await ref.first().click()
    } else {
      await para.click({ position: { x: 3, y: 3 } })
    }
    await page.waitForTimeout(3000)

    await expect(artifactTitle(page)).toHaveText('c33.md')
  })

  test('BB-C26 the outline updates when a heading is added to the file', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    const filler = Array.from({ length: 12 }, (_, i) => `filler-body-C26-${i}`).join('\n\n')
    const base = [
      '## section-one-C26',
      '',
      filler,
      '',
      '## section-two-C26',
      '',
      filler,
      '',
      '## section-three-C26',
      '',
      filler,
      ''
    ].join('\n')
    const file = write(ws, 'c26.md', base)

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c26.md')

    await outlineToggle(page).click({ timeout: 30_000 })
    await expect(page.locator('.outline-list .outline-it')).toHaveCount(3, { timeout: 20_000 })

    fs.appendFileSync(file, ['', '## new section', '', filler, ''].join('\n'))

    const items = page.locator('.outline-list .outline-it')
    await expect(items).toHaveCount(4, { timeout: 30_000 })
    await expect(items.last()).toHaveText('new section')

    await items.last().click()
    await expect(mdBody(page).locator('h2', { hasText: 'new section' })).toBeInViewport({
      timeout: 20_000
    })
  })

  test('BB-C34 lower-case alert blocks render as cards too', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    write(
      ws,
      'c34.md',
      [
        '# C34',
        '',
        '> [!note]',
        '> lowercase-note-C34',
        '',
        '> [!warning]',
        '> lowercase-warning-C34',
        ''
      ].join('\n')
    )

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c34.md')

    const alerts = mdBody(page).locator('.md-alert')
    await expect(alerts).toHaveCount(2, { timeout: 30_000 })
    await expect(mdBody(page).locator('.md-alert-note')).toHaveCount(1)
    await expect(mdBody(page).locator('.md-alert-warning')).toHaveCount(1)
    await expect(mdBody(page).locator('.md-alert-icon')).toHaveCount(2)

    const skins = await alerts.evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el)
        const icon = el.querySelector('.md-alert-icon')
        const ics = icon ? getComputedStyle(icon) : null
        return [cs.color, cs.backgroundColor, cs.borderLeftColor, ics?.color ?? ''].join('|')
      })
    )
    expect(skins[0]).not.toBe(skins[1])

    expect(await bodyText(page)).not.toContain('[!note]')
  })

  test('BB-C36 a file change on disk closes the zoomed view while it is open', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const ws = env.workspaces.a
    const doc = (marker: string): string =>
      ['# C36', '', marker, '', fence('mermaid', flow('C36')), ''].join('\n')
    const file = write(ws, 'c36.md', doc('original-C36'))

    await putSessionOnScreen(page)
    await openDoc(page, env, 'c36.md')

    await expect(diagrams(page)).toHaveCount(1, { timeout: 120_000 })
    await diagrams(page).first().click()
    await expect(page.locator('.mmd-zoom')).toBeVisible({ timeout: 20_000 })

    fs.writeFileSync(file, doc('new-text-C36'))

    await expect(page.locator('.mmd-zoom')).toHaveCount(0, { timeout: 30_000 })
    await expect(mdBody(page)).toContainText('new-text-C36', { timeout: 30_000 })
  })
})
