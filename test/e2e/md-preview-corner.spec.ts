import fs from 'fs'
import path from 'path'
import type { ElectronApplication, JSHandle, Locator, Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import { startSessionIn, waitBooted, wsRows } from './helpers/p1'
import { openTabs, pinnedTab } from './helpers/browser'
import { artifactBody, openFileTab, WORKBENCH } from './helpers/workbench'
import type { E2EEnv } from './helpers/env'

/**
 * Black-box corner cases for the rich Markdown preview — BB-C01…BB-C37 of
 * the original design notes).
 *
 * Everything here is written against two sources only: each case's own Given/When/Then
 * and the DOM contract (declared in src/renderer/src/markdown/index.ts's header;
 * the spec doc is retired)
 * (`.mmd`, `.mmd-error`, `.mmd-toobig`, `.mmd-zoom`, `.md-code`, `.md-alert`,
 * `.md-task`, `.katex`, `.md-frontmatter`, `.md-img-blocked`, `a.md-fileref`,
 * `.md-table-wrap`, `.outline-*`). No implementation file was read, and no in-app
 * function is called to set a case up: samples are written to the workspace with fs and
 * opened through the product's own ＋ ▸ "Open file…".
 *
 * Surface migration: the aux column's single-file Preview pane is gone, so
 * every case reads its document out of a Workbench `file` tab — FR-30's markdown →
 * Rendered route, through the same PreviewViewer the former pane used. The tree click
 * these cases used to make is FR-10's route now and lands in the `files` tab's Browse
 * reading area, which mounts the identical `ArtifactPane`; the contract is pinned to the
 * `file` tab because ＋ ▸ "Open file…" reaches one without a fixture in the Files half.
 *
 * Two conventions worth knowing before editing:
 *  - the clipboard is never read back. The developer's real clipboard is off limits
 *    (browser-nfr.spec.ts BB-N05), so the copy paths are spied on
 *    instead — renderer `navigator.clipboard.writeText` + `document.execCommand('copy')`
 *    and main's `clipboard.writeText`.
 *  - the preview's scroll container has no contract selector, so it is found at
 *    runtime by walking up from `.md-body` to the first scrollable ancestor.
 */

const PIC = path.join(__dirname, 'fixtures', 'md-preview', 'c-pic.png')

// ---- fixtures on disk ----------------------------------------------------------------

/** Write one sample file into a workspace, creating parent dirs. Returns its full path. */
function write(ws: string, rel: string, body: string): string {
  const full = path.join(ws, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
  return full
}

/** A fenced block, assembled without template literals so ``` stays readable. */
function fence(lang: string, body: string): string {
  return '```' + lang + '\n' + body + '\n```'
}

/** A fence with nothing at all between its two lines. */
function emptyFence(lang: string): string {
  return '```' + lang + '\n```'
}

/** A syntactically valid flowchart whose SOURCE is exactly `len` characters long: the
 *  padding rides inside a `%%` comment line so the diagram itself stays cheap to lay
 *  out (the boundary under test is source length, not node count). */
function mermaidOfLength(len: number, marker: string): string {
  const head = 'flowchart TD\n%% '
  const tail = `\n  A[${marker}] --> B[${marker}End]`
  const pad = 'x'.repeat(len - head.length - tail.length)
  return head + pad + tail
}

/** A two-node flowchart carrying its own visible label. */
function flow(marker: string): string {
  return `flowchart TD\n  ${marker}A[${marker}] --> ${marker}B[${marker}End]`
}

function lines(n: number, make: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => make(i + 1)).join('\n')
}

// ---- reaching the preview ------------------------------------------------------------

/** Put a session in ws-a on screen — the panel hangs off it, and its root is FR-34's
 *  fence. A session is the only carrier there is. */
async function treeFor(page: Page): Promise<void> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
}

/**
 * Open a workspace file as a `file` tab through FR-52's ＋ ▸ "Open file…", and wait for
 * the kind bar to name it. The native panel never appears — the main-side file-dialog
 * seam answers the pick — and draining its queue is the positive barrier that the picker
 * really was raised and really answered.
 */
async function openDoc(page: Page, env: E2EEnv, rel: string): Promise<void> {
  await openFileTab(page, env, path.join(env.workspaces.a, rel))
  await expect(artifactTitle(page)).toHaveText(rel, { timeout: 30_000 })
}

/** FR-31's kind-bar path label: the parent directories relative to the workspace root,
 *  then the file name. Replaces the former FilePane's `.file-pane-title` — and is a
 *  strictly sharper oracle, since a bare basename could not tell two same-named files
 *  apart. Browse's reading area spells the same header `.fv-artifact-hd` (WB-B09). */
function artifactTitle(page: Page): Locator {
  return page.locator(WORKBENCH.artifactTitle)
}

/** FR-32's ≡ — in the kind bar now, and DISABLED (never absent) for an artifact with
 *  nothing to outline: a control that comes and goes as the file is edited underneath is
 *  a moving target for the pointer. */
function outlineToggle(page: Page): Locator {
  return page.locator(WORKBENCH.outline)
}

/** The rendered markdown of the ACTIVE tab's artifact. */
function mdBody(page: Page): Locator {
  return artifactBody(page).locator('.md-body')
}

/** Rendered diagrams (a `.mmd` container that really holds an SVG). */
function diagrams(page: Page): Locator {
  return mdBody(page).locator('.mmd svg')
}

function bodyText(page: Page): Promise<string> {
  return mdBody(page).innerText()
}

/** Wait for the pane to actually have rendered SOMETHING, then snapshot its text. The pane
 *  titles itself before the markdown finishes rendering, so a bare one-shot read races the
 *  render and can legitimately come back empty. (A case about an EMPTY document must use
 *  `bodyText` directly — there is no content to wait for.) */
async function renderedText(page: Page, marker: string): Promise<string> {
  await expect(mdBody(page)).toContainText(marker, { timeout: 30_000 })
  return bodyText(page)
}

// ---- scrolling -----------------------------------------------------------------------

/** The element that actually scrolls the preview: the first scrollable ancestor of the
 *  visible `.md-body` (the DOM contract names no selector for it). An inactive tab is
 *  hidden with `visibility` and not `display` (NFR-03's reason: a subtree with no layout
 *  box cannot hold a scroll offset), so it still HAS an offsetParent — the computed
 *  visibility is what separates the tab on screen from the ones behind it. */
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

/** One page-down inside the preview. Returns true once the bottom cannot move further. */
async function scrollStep(page: Page): Promise<boolean> {
  const h = await scroller(page)
  return h.evaluate((el) => {
    const before = el.scrollTop
    el.scrollTop = Math.min(before + el.clientHeight * 0.6, el.scrollHeight)
    return el.scrollTop <= before
  })
}

/** Walk the whole document top to bottom so every lazy block enters the viewport. */
async function scrollToBottom(page: Page, steps = 60, pause = 350): Promise<void> {
  for (let i = 0; i < steps; i++) {
    const atEnd = await scrollStep(page)
    await page.waitForTimeout(pause)
    if (atEnd) return
  }
}

// ---- clipboard spy -------------------------------------------------------------------

interface CopyRecorder {
  __koloftCopied?: string[]
}

/** Record what a copy button hands to the clipboard WITHOUT touching the real one. */
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

/** Everything the spy caught, renderer side first. */
async function copiedTexts(app: ElectronApplication, page: Page): Promise<string[]> {
  const fromPage = await page.evaluate(
    () => (window as unknown as CopyRecorder).__koloftCopied ?? []
  )
  const fromMain = await app.evaluate(
    () => (globalThis as typeof globalThis & CopyRecorder).__koloftCopied ?? []
  )
  return [...fromPage, ...fromMain]
}

/** "same character for character" up to the one trailing newline a fence body may or may not carry. */
function sameSource(copied: string, source: string): boolean {
  return copied.replace(/\n$/, '') === source.replace(/\n$/, '')
}

// ---- misc probes ---------------------------------------------------------------------

/** Distinct foreground colours of the text inside one element — the observable behind
 *  "highlighted / not highlighted" (a highlighted block paints its tokens in different colours). */
async function textColors(el: Locator): Promise<string[]> {
  return el.evaluate((root) => {
    const seen = new Set<string>()
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walk.nextNode()
    // a handful of distinct colours already answers "highlighted or not"; stopping there keeps
    // a 2000-line highlighted block from costing 10k getComputedStyle calls per poll
    while (node && seen.size < 4) {
      const parent = node.parentElement
      if (parent && (node.textContent ?? '').trim()) {
        seen.add(getComputedStyle(parent).color)
      }
      node = walk.nextNode()
    }
    return Array.from(seen)
  })
}

// =======================================================================================
// BB-C01 … BB-C04 — diagram failure modes
// =======================================================================================

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

  await treeFor(page)
  await armCopySpy(app, page)
  await openDoc(page, env, 'c01.md')
  await scrollToBottom(page)

  // the error card, with both halves the case names
  const card = mdBody(page).locator('.mmd-error')
  await expect(card).toHaveCount(1, { timeout: 60_000 })
  await expect(card.locator('.mmd-error-msg')).not.toBeEmpty()
  await expect(card.locator('pre')).toContainText('@@@ ??? ###')

  // its copy button hands over the fence source verbatim
  await card.locator('button.mmd-copy').click()
  await expect
    .poll(async () => (await copiedTexts(app, page)).some((t) => sameSource(t, broken)), {
      timeout: 15_000
    })
    .toBe(true)

  // …and nothing else in the document suffered
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
    ['# C02', '', fence('mermaid', mermaidOfLength(50001, 'C02BIG')), '', 'tail-body-C02', ''].join(
      '\n'
    )
  )

  await treeFor(page)
  await openDoc(page, env, 'c02.md')

  const toobig = mdBody(page).locator('.mmd-toobig')
  await expect(toobig).toHaveCount(1, { timeout: 60_000 })
  // the source is shown as a code block …
  await expect(toobig.locator('pre')).toContainText('C02BIG')
  // … there is no diagram …
  await expect(mdBody(page).locator('.mmd svg')).toHaveCount(0)
  // … and a readable notice sits beside the source
  const notice = await toobig.evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement
    clone.querySelectorAll('pre').forEach((p) => p.remove())
    return (clone.textContent ?? '').trim()
  })
  expect(notice.length).toBeGreaterThan(0)
  // the rest of the page renders as usual
  expect(await bodyText(page)).toContain('tail-body-C02')
})

test('BB-C03 diagram source exactly at the limit renders normally', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const ws = env.workspaces.a
  write(
    ws,
    'c03.md',
    ['# C03', '', fence('mermaid', mermaidOfLength(50000, 'C03ok')), ''].join('\n')
  )

  await treeFor(page)
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
  write(ws, 'c04.md', ['# C04', '', emptyFence('mermaid'), '', 'following-body-C04', ''].join('\n'))

  await treeFor(page)
  await openDoc(page, env, 'c04.md')

  await expect(mdBody(page).locator('.mmd-error')).toHaveCount(1, { timeout: 60_000 })
  expect(await bodyText(page)).toContain('following-body-C04')
  await expect(mdBody(page).locator('.mmd svg')).toHaveCount(0)
})

// =======================================================================================
// BB-C05 — reload wins over an in-flight render
// =======================================================================================

test('BB-C05 file changed while rendering shows only the new content', async ({
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

  await treeFor(page)
  // open and swap the file underneath the render that opening started — `openFileTab`
  // rather than `openDoc`, whose title wait would let the first render settle and dissolve
  // the race the case is about
  await openFileTab(page, env, file)
  await mdBody(page).waitFor({ state: 'attached', timeout: 30_000 })
  fs.writeFileSync(file, v2)

  await expect(mdBody(page)).toContainText('version-two-C05', { timeout: 30_000 })
  await scrollToBottom(page)
  expect(await bodyText(page)).not.toContain('version-one-C05')
  await expect(mdBody(page).locator('.mmd')).toHaveCount(1, { timeout: 30_000 })
})

// =======================================================================================
// BB-C06 / BB-C19 / BB-C30 — images
// =======================================================================================

// BB-C06 — flipped the first half: an image outside every workspace used to come back
// 403 from `koloft-file://` and show the placeholder. There is no fence any more, so it
// simply loads. The placeholder is still what an image that is not THERE gets, which is the
// second half of this case and the reason it stays one case.
test('BB-C06 an image outside the workspace loads; a missing one shows the placeholder', async ({
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

  await treeFor(page)
  await openDoc(page, env, 'c06.md')

  // the one that exists really renders: a decoded bitmap, not a placeholder
  const img = mdBody(page).locator('img')
  await expect(img).toHaveCount(1, { timeout: 30_000 })
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 })
    .toBeGreaterThan(0)

  // the one that is not there keeps the placeholder: readable, and really occupying space
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

  await treeFor(page)
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

test('BB-C30 a remote image is not loaded and shows a placeholder', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const ws = env.workspaces.a
  const url = 'https://img.example.com/badge.svg'
  write(ws, 'c30.md', ['# C30', '', `![badge](${url})`, ''].join('\n'))

  // recording starts before the document is ever opened (the case's Given)
  const requested: string[] = []
  page.on('request', (r) => requested.push(r.url()))

  await treeFor(page)
  await openDoc(page, env, 'c30.md')

  const blocked = mdBody(page).locator('.md-img-blocked')
  await expect(blocked).toHaveCount(1, { timeout: 30_000 })
  await expect(blocked).toContainText(url)
  await page.waitForTimeout(3000)
  expect(requested.filter((u) => u.includes('img.example.com'))).toEqual([])
})

// =======================================================================================
// BB-C07 — a dead reference stays quiet
// =======================================================================================

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

  await treeFor(page)
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

// =======================================================================================
// BB-C38 — FR-34's workspace fence, i.e. WB-R06's second reference
// =======================================================================================

/**
 * The one clause of FR-34 the former cases never had to cover, because the former pane
 * could not be pointed anywhere dangerous: routing only ever let a *previewable* kind into
 * it, so a reference out of the tree resolved to something it would refuse to render
 * anyway. A `file` tab renders ANY text file, so the same click is now a real read — and
 * FR-34 answers it with a silent no-op: a target may only land inside the tree the reader
 * already declared (the workspace, or the document's own directory when there is none).
 *
 * The escaping file really EXISTS at the path the document's own directory resolves to,
 * so nothing here passes by accident: without the fence the click would open it.
 */
test('BB-C38 clicking a path reference that resolves outside the workspace does nothing', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const ws = env.workspaces.a
  // ws-a is <home>/ws-a, so `../..` from <ws>/sub38 lands in <home> — outside the fence
  // under BOTH of FR-34's roots (the document's directory and the workspace root)
  const outside = path.join(env.home, 'outside-c38')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(
    path.join(outside, 'secret.ts'),
    ['const a = 1', '// C38_ESCAPED_MARK', 'const c = 3'].join('\n') + '\n'
  )
  write(
    ws,
    'sub38/c38.md',
    ['# C38', '', 'See line ../../outside-c38/secret.ts:2 for details.', '', 'marker-C38', ''].join(
      '\n'
    )
  )

  const dialogs: string[] = []
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })

  await treeFor(page)
  await openDoc(page, env, 'sub38/c38.md')

  await mdBody(page)
    .locator('a.md-fileref', { hasText: 'outside-c38/secret.ts:2' })
    .click({ timeout: 30_000 })
  await page.waitForTimeout(3000)

  // the tab never retargeted, the file's content never reached the screen, and the refusal
  // was silent — no dialog, no toast, no error placeholder
  await expect(artifactTitle(page)).toHaveText('sub38/c38.md')
  expect(await bodyText(page)).toContain('marker-C38')
  expect(await artifactBody(page).innerText()).not.toContain('C38_ESCAPED_MARK')
  expect(dialogs).toEqual([])
  await expect(page.locator('.toast')).toHaveCount(0)
  await expect(page.locator('.modal')).toHaveCount(0)
})

// =======================================================================================
// BB-C08 / BB-C29 — dollars that are not maths
// =======================================================================================

test('BB-C08 money amounts do not swallow the body text', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const ws = env.workspaces.a
  write(
    ws,
    'c08.md',
    ['# C08', '', 'Spent $100 this month, budget $200 next month.', ''].join('\n')
  )

  await treeFor(page)
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
    ['# C29', '', fence('bash', 'echo $HOME\ncp $1 $2'), '', 'Inline `$PATH` ends here.', ''].join(
      '\n'
    )
  )

  await treeFor(page)
  await openDoc(page, env, 'c29.md')

  const text = await renderedText(page, 'echo $HOME')
  expect(text).toContain('echo $HOME')
  expect(text).toContain('cp $1 $2')
  expect(text).toContain('$PATH')
  await expect(mdBody(page).locator('.md-code .katex')).toHaveCount(0)
  await expect(mdBody(page).locator('p code .katex')).toHaveCount(0)
})

// =======================================================================================
// BB-C09 … BB-C12 — code fences
// =======================================================================================

test('BB-C09 a code block in an unsupported language falls back to plain text but can still be copied', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const ws = env.workspaces.a
  const src = 'defmodule C09 do\n  def hello, do: :world\nend'
  write(ws, 'c09.md', ['# C09', '', fence('elixir', src), ''].join('\n'))

  await treeFor(page)
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

  await treeFor(page)
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

  await treeFor(page)
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

  await treeFor(page)
  await openDoc(page, env, 'c12.md')

  const block = mdBody(page).locator('.md-code')
  await expect(block).toHaveCount(1, { timeout: 30_000 })
  await expect(block.locator('.md-code-lang')).toHaveText('bash')
  await expect(block.locator('button.md-code-copy')).toHaveCount(1)
  expect((await block.locator('pre').innerText()).trim()).toBe('')
  expect(await bodyText(page)).toContain('following-body-C12')
})

// =======================================================================================
// BB-C13 / BB-C14 — nothing to outline
// =======================================================================================

test('BB-C13 opening an empty document does not error', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const ws = env.workspaces.a
  write(ws, 'c13.md', '')

  await treeFor(page)
  await openDoc(page, env, 'c13.md')

  await expect(mdBody(page)).toHaveCount(1, { timeout: 30_000 })
  await page.waitForTimeout(2000)
  expect((await bodyText(page)).trim()).toBe('')
  // FR-31 moved ≡ into the kind bar, where it is a fixed member of the header rather than
  // something that appears with the first heading — "no outline entry" is therefore read as
  // disabled now, not as absent. Both spellings mean the same thing to a user: unclickable.
  await expect(outlineToggle(page)).toBeDisabled()
  await expect(page.locator('.outline-list')).toHaveCount(0)
})

test('BB-C14 a document with no headings shows no outline toggle', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const ws = env.workspaces.a
  write(ws, 'c14.md', ['para-one-C14', '', 'para-two-C14', '', 'para-three-C14', ''].join('\n'))

  await treeFor(page)
  await openDoc(page, env, 'c14.md')

  await expect(mdBody(page)).toContainText('para-three-C14', { timeout: 30_000 })
  // see BB-C13: the ≡ is a permanent kind-bar control (FR-31), disabled when there is
  // nothing to outline
  await expect(outlineToggle(page)).toBeDisabled()
  await expect(page.locator('.outline-list')).toHaveCount(0)
})

// =======================================================================================
// BB-C15 / BB-C16 / BB-C35 — front matter
// =======================================================================================

test('BB-C15 invalid front matter is shown as a code block', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const ws = env.workspaces.a
  write(ws, 'c15.md', ['---', 'a: [1, 2', '---', '', 'body-C15', ''].join('\n'))

  await treeFor(page)
  await openDoc(page, env, 'c15.md')

  await expect(mdBody(page)).toContainText('body-C15', { timeout: 30_000 })
  await expect(mdBody(page).locator('pre')).toContainText('a: [1, 2')
  await expect(mdBody(page).locator('.md-frontmatter')).toHaveCount(0)
})

test('BB-C16 empty front matter does not produce an empty card', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const ws = env.workspaces.a
  write(ws, 'c16.md', ['---', '---', '', 'first-para-C16', '', 'second-para-C16', ''].join('\n'))

  await treeFor(page)
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

  await treeFor(page)
  await openDoc(page, env, 'c35.md')

  const card = mdBody(page).locator('.md-frontmatter')
  await expect(card).toHaveCount(1, { timeout: 30_000 })
  const keys = (await card.locator('.md-fm-key').allInnerTexts()).join('\n')
  const vals = (await card.locator('.md-fm-val').allInnerTexts()).join('\n')
  expect(keys).toContain('tags')
  expect(keys).toContain('owner')
  expect(vals).toContain('[a, b]')
  expect(vals).toContain('koh')
  // the list value stays one value — it is not exploded into list items
  await expect(card.locator('li')).toHaveCount(0)
})

// =======================================================================================
// BB-C17 / BB-C18 / BB-C37 — diagrams in awkward places
// =======================================================================================

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

  await treeFor(page)
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

  await treeFor(page)
  await openDoc(page, env, 'c18.md')

  // top → bottom: all 60 come up, none of them as an error card
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

  // bottom → top: the first two are still real diagrams, not emptied placeholders
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
    ['# C37', '', 'body-para-C37', '', fence('mermaid', `flowchart LR\n  ${chain}`), ''].join('\n')
  )

  await treeFor(page)
  await openDoc(page, env, 'c37.md')

  const para = mdBody(page).locator('p', { hasText: 'body-para-C37' })
  await expect(mdBody(page).locator('.mmd')).toHaveCount(1, { timeout: 30_000 })
  const widthBefore = await para.evaluate((el) => (el as HTMLElement).clientWidth)

  await expect(diagrams(page)).toHaveCount(1, { timeout: 180_000 })
  await page.waitForTimeout(1500)

  // the body paragraph is untouched by the oversized diagram
  expect(await para.evaluate((el) => (el as HTMLElement).clientWidth)).toBe(widthBefore)
  // the page itself does not scroll sideways …
  const pageOverflow = await (
    await scroller(page)
  ).evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(pageOverflow).toBeLessThanOrEqual(1)
  // … the diagram's own container does
  const box = await mdBody(page)
    .locator('.mmd')
    .evaluate((el) => ({
      overflowX: getComputedStyle(el).overflowX,
      over: el.scrollWidth - el.clientWidth
    }))
  expect(box.over).toBeGreaterThan(1)
  expect(['auto', 'scroll']).toContain(box.overflowX)
})

// =======================================================================================
// BB-C20 / BB-C25 — two tabs
// =======================================================================================

/**
 * The risk the case was written for is a COLLISION between two live renderers of the same
 * diagram source (mermaid mints ids in a module-global counter). After the merge the two
 * readings of "two tabs" diverge, so both are taken:
 *  ① two `file` tabs in ONE session, on two copies of the same document — both panes are
 *    mounted at once (the inactive one only hidden), which is the collision the case
 *    guards, and the original per-pane assertion carries over verbatim. A second tab on
 *    the SAME path cannot be made: FR-15 dedups a re-open onto the existing tab.
 *  ② the same file open in two SESSIONS. Only the session on screen keeps its artifacts
 *    mounted, so this half asserts that each renders in full in turn.
 */
test('BB-C20 the same document open in two tabs at once renders fully in both', async ({
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

  // ① session A opens both copies — two artifacts mounted side by side
  await rows.nth(0).click()
  await openDoc(page, env, 'c20.md')
  await scrollToBottom(page)
  await expect(diagrams(page)).toHaveCount(2, { timeout: 120_000 })
  await openDoc(page, env, 'c20-copy.md')
  await scrollToBottom(page)
  await expect(diagrams(page)).toHaveCount(2, { timeout: 120_000 })

  // Deliberately UNSCOPED, unlike `mdBody`: this is the one assertion that wants BOTH
  // mounted panes, the hidden one included — that both exist at once is the case. Polled
  // rather than read once: `evaluateAll` does not retry, so a one-shot read can catch the
  // second pane between mount and first paint and report a pane that is merely late as a
  // pane that rendered wrong.
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

  // ② session B opens the same file, and A still renders it in full on the way back
  await rows.nth(1).click()
  await openDoc(page, env, 'c20.md')
  await scrollToBottom(page)
  await expect(diagrams(page)).toHaveCount(2, { timeout: 120_000 })

  await rows.nth(0).click()
  // The switch UNMOUNTS the other session's artifacts and remounts these a tick later, so
  // the pane has to be back before anything scrolls it: `scroller()` resolves to the
  // visible `.md-body`, and with none in the DOM yet it hands back undefined and the first
  // scroll step throws. BB-C25's session round trip takes the same barrier.
  await expect(artifactTitle(page)).toHaveText('c20-copy.md', { timeout: 30_000 })
  await expect(mdBody(page)).toBeVisible({ timeout: 30_000 })
  await scrollToBottom(page)
  await expect(diagrams(page)).toHaveCount(2, { timeout: 120_000 })
  await expect(mdBody(page)).toContainText('marker-C20')
})

/**
 * "Switch away and back" has two readings after the merge, and they are NOT the same
 * mechanism, so the case takes both:
 *  ① a PANEL tab switch — the artifact stays mounted, hidden with `visibility` and never
 *    `display` (the reason NFR-03 gives: a subtree with no layout box cannot hold a scroll
 *    offset). This is where the original case's promise still lives, scroll included.
 *  ② a SESSION switch — only the session on screen has its artifacts mounted, so the pane
 *    is rebuilt on the way back and the diagrams re-render from scratch. The document is
 *    intact; the reading position is NOT restored, which the merge changed and no
 *    requirement re-promises (NFR-03 scopes its "session away and back" to a WEB tab's
 *    guest). Asserted as it behaves, with the scroll clause deliberately not carried over.
 */
test('BB-C25 switching away from a tab and back keeps the diagrams and the scroll position', async ({
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

  // park in the middle of the document
  const h = await scroller(page)
  const middle = await h.evaluate((el) => Math.floor((el.scrollHeight - el.clientHeight) / 2))
  await setScrollTop(page, middle)
  const before = await scrollTopOf(page)
  expect(before, 'the sample really did scroll').toBeGreaterThan(0)

  // ① away to the pinned `files` tab, linger, back to the artifact's own tab
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

  // ② away to another SESSION, linger, back. The tab is still on the strip and the
  // document renders in full again — it is rebuilt, so it comes back at the top.
  await startSessionIn(page, 'ws-b')
  await page.waitForTimeout(4000)
  await wsRows(page, 'ws-a').first().click()

  await expect(artifactTitle(page)).toHaveText('c25.md', { timeout: 30_000 })
  await scrollToBottom(page)
  await expect(diagrams(page)).toHaveCount(3, { timeout: 120_000 })
  const texts = await diagrams(page).evaluateAll((els) => els.map((e) => e.textContent ?? ''))
  expect(texts.join('|')).toContain('C25n1')
  expect(texts.join('|')).toContain('C25n2')
  expect(texts.join('|')).toContain('C25n3')
})

// =======================================================================================
// BB-C21 — the read-only checkbox
// =======================================================================================

test('BB-C21 clicking a task-list checkbox does not change the file on disk', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const ws = env.workspaces.a
  const file = write(ws, 'c21.md', ['# C21', '', '- [ ] todo one', ''].join('\n'))
  const before = fs.readFileSync(file)

  await treeFor(page)
  await openDoc(page, env, 'c21.md')

  const box = mdBody(page).locator('input[type=checkbox].md-task')
  await expect(box).toHaveCount(1, { timeout: 30_000 })
  // `force` because a disabled input is a real click target that must ignore the press
  await box.click({ force: true })
  await page.waitForTimeout(2000)

  expect(await box.isChecked()).toBe(false)
  expect(fs.readFileSync(file).equals(before)).toBe(true)
})

// =======================================================================================
// BB-C22 / BB-C27 / BB-C28 / BB-C31 — file references that DO resolve
// =======================================================================================

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

  await treeFor(page)
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

  await treeFor(page)
  await openDoc(page, env, 'sub27/c27.md')

  await mdBody(page).locator('a.md-fileref', { hasText: 'helper.ts:3' }).click({ timeout: 30_000 })

  // the kind bar carries the path, not a bare name — which is the whole point here: the
  // two candidates differ only by directory, so the title alone now settles the case
  await expect(artifactTitle(page)).toHaveText('sub27/helper.ts', { timeout: 30_000 })
  // the code view titles itself before it has finished highlighting ("Loading…"), so wait
  // for the content itself rather than snapshotting whatever is on screen at this instant
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

  await treeFor(page)
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

  await treeFor(page)
  await openDoc(page, env, 'c31.md')

  await mdBody(page)
    .locator('a.md-fileref', { hasText: 'sample.ts:12:5' })
    .click({ timeout: 30_000 })

  await expect(artifactTitle(page)).toHaveText('sample.ts', { timeout: 30_000 })
  await expect(artifactBody(page).getByText('L12_C31_MARK').first()).toBeInViewport({
    timeout: 20_000
  })
})

// =======================================================================================
// BB-C23 / BB-C24 / BB-C32 / BB-C33 — things that must NOT become file references
// =======================================================================================

test('BB-C23 a full-width colon is not treated as a path reference', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const ws = env.workspaces.a
  write(ws, 'c23.md', ['# C23', '', 'See the sample.ts：12 section', ''].join('\n'))

  await treeFor(page)
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

  await treeFor(page)
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
  const code = ['const c32 = 1', '// see src/main/index.ts:975', 'export const f = c32'].join('\n')
  write(ws, 'c32.md', ['# C32', '', fence('ts', code), ''].join('\n'))

  await treeFor(page)
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

  await treeFor(page)
  await openDoc(page, env, 'c33.md')

  const para = mdBody(page).locator('p', { hasText: 'localhost:3000' })
  await expect(para).toHaveCount(1, { timeout: 30_000 })
  // click the text: a file reference (if one was wrongly made) is what the case is
  // about, so click it when present; otherwise press the plain text at the line start,
  // which must be just as inert.
  const ref = para.locator('a.md-fileref')
  if ((await ref.count()) > 0) {
    await ref.first().click()
  } else {
    await para.click({ position: { x: 3, y: 3 } })
  }
  await page.waitForTimeout(3000)

  await expect(artifactTitle(page)).toHaveText('c33.md')
})

// =======================================================================================
// BB-C26 — the outline follows the file
// =======================================================================================

test('BB-C26 the outline updates when a heading is added to the file', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const ws = env.workspaces.a
  const filler = Array.from({ length: 12 }, (_, i) => `filler-body-C26-${i}`).join('\n\n')
  const base = [
    // no H1: the case is written about three level-2 headings, and a title would make the
    // outline four rows before anything is appended
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

  await treeFor(page)
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

// =======================================================================================
// BB-C34 — lower-case alerts
// =======================================================================================

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

  await treeFor(page)
  await openDoc(page, env, 'c34.md')

  const alerts = mdBody(page).locator('.md-alert')
  await expect(alerts).toHaveCount(2, { timeout: 30_000 })
  await expect(mdBody(page).locator('.md-alert-note')).toHaveCount(1)
  await expect(mdBody(page).locator('.md-alert-warning')).toHaveCount(1)
  await expect(mdBody(page).locator('.md-alert-icon')).toHaveCount(2)

  // each type carries its own colour
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

// =======================================================================================
// BB-C36 — the zoom view yields to a reload
// =======================================================================================

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

  await treeFor(page)
  await openDoc(page, env, 'c36.md')

  await expect(diagrams(page)).toHaveCount(1, { timeout: 120_000 })
  await diagrams(page).first().click()
  await expect(page.locator('.mmd-zoom')).toBeVisible({ timeout: 20_000 })

  fs.writeFileSync(file, doc('new-text-C36'))

  await expect(page.locator('.mmd-zoom')).toHaveCount(0, { timeout: 30_000 })
  await expect(mdBody(page)).toContainText('new-text-C36', { timeout: 30_000 })
})
