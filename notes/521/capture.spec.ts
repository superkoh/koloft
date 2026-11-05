import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings } from './helpers/env'

const OUT = path.join(__dirname, '..', '..', 'notes', '521')
const SHOTS = path.join(__dirname, '..', '..', 'mockups', '521')

test.describe.configure({ mode: 'serial' })

test('capture the welcome cards with no agent on this Mac', async ({ env }) => {
  test.setTimeout(90_000)
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({ version: 6, workspaces: [], workbench: { defaultOpen: true }, members: [], panels: {} })
  )
  seedSettings(env, { onboardingSeen: false })
  env.launchEnv.KOLOFT_TEST_CLAUDE_PROBE = 'missing'
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const cards = page.locator('.wl-agents')
    await expect(cards).toContainText('Not on this Mac', { timeout: 30_000 })
    await page.waitForTimeout(1500)
    fs.writeFileSync(path.join(OUT, 'welcome-cards.dom.html'), await cards.evaluate((el) => el.outerHTML))
  } finally {
    await quitAndClose(app)
  }
})

const HINT =
  'This Mac has none of the agents Koloft runs yet. Pick one to install: a terminal opens and runs its official installer.'

function variantA(): string {
  const cards = ['Claude Code', 'Codex', 'Muse Code', 'Antigravity CLI']
    .map(
      (n) =>
        `<button class="choice"><span class="choice-t">${n}</span><span class="choice-d">Not on this Mac. Click to install.</span></button>`
    )
    .join('')
  return `<div class="quiet" style="max-width:520px">${HINT}</div><div class="ob-choices" style="max-width:620px">${cards}</div>`
}

test('capture the empty panel today and with each option', async ({ env }) => {
  test.setTimeout(90_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  env.launchEnv.KOLOFT_TEST_CLAUDE_PROBE = 'missing'
  const welcomeCards = fs
    .readFileSync(path.join(OUT, 'welcome-cards.dom.html'), 'utf8')
    .replace(/animation-delay:[^;"]*;?/g, '')
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.setViewportSize({ width: 1280, height: 800 })
    const empty = page.locator('.w-empty')
    await expect(empty).toContainText('Unavailable', { timeout: 30_000 })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(SHOTS, 'today.png') })

    const original = await empty.evaluate((el) => el.innerHTML)
    const swap = async (html: string, file: string): Promise<void> => {
      await empty.evaluate(
        (el, [orig, add]) => {
          el.innerHTML = orig
          el.querySelector('button[data-default]')?.remove()
          el.querySelector('p.field-hint')?.remove()
          el.insertAdjacentHTML('beforeend', add)
        },
        [original, html]
      )
      await page.waitForTimeout(1200)
      fs.writeFileSync(path.join(OUT, file + '.dom.html'), await empty.evaluate((el) => el.outerHTML))
      await page.screenshot({ path: path.join(SHOTS, file + '.png') })
    }
    await swap(variantA(), 'option-a')
    await swap(
      `<div class="quiet" style="max-width:520px">${HINT}</div><div style="--wl-sans:var(--font);--wl-muted:#a7a29b;--wl-ink:#f6f3ee;color:var(--wl-ink);zoom:0.78">${welcomeCards}</div>`,
      'option-b'
    )
  } finally {
    await quitAndClose(app)
  }
})
