import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { waitBooted } from './helpers/p1'

const STUCK_AFTER_MS = 1000
const MAIN_THREAD_HELD_MS = 15_000
const NEXT_ASK_AFTER_A_SAMPLE_MS = 12 * STUCK_AFTER_MS

function readOrEmpty(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function filesIn(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name)) : []
}

test('errors nobody caught in the main process are written down and shown as one toast, and never open the box that holds the whole app until someone clicks it', async ({
  app,
  page,
  env
}) => {
  await waitBooted(page)
  await app.evaluate(({ dialog }) => {
    const seen = globalThis as { __errorBoxes?: number }
    seen.__errorBoxes = 0
    dialog.showErrorBox = () => {
      seen.__errorBoxes!++
    }
    for (const which of ['first', 'second'])
      setTimeout(() => {
        throw new Error(`${which} error thrown in a timer by the test`)
      }, 0)
    void Promise.reject(new Error('promise rejected by the test with nobody handling it'))
  })
  const toasts = page.locator('.toast-msg', { hasText: 'error thrown in a timer by the test' })
  await expect(toasts).toContainText('first error thrown in a timer by the test')
  await expect
    .poll(() => readOrEmpty(path.join(env.userData, 'main-errors.log')))
    .toMatch(/Error: first error thrown[^]+\n\s+at [^]+Error: second error thrown/)
  await expect
    .poll(() => readOrEmpty(path.join(env.userData, 'main-errors.log')))
    .toContain('promise rejected by the test with nobody handling it')
  await expect(toasts).toHaveCount(1)
  expect(await app.evaluate(() => (globalThis as { __errorBoxes?: number }).__errorBoxes)).toBe(0)
})

test('while the main thread is stuck, a sample of what it is in is saved at that moment, not once it is back, and the stall log names it, with how long the main thread was gone, once it takes work again', async ({
  env
}) => {
  env.launchEnv.KOLOFT_MAIN_STUCK_MS = String(STUCK_AFTER_MS)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    const samplesDir = path.join(env.userData, 'main-stuck')
    const log = path.join(env.userData, 'main-stalls.log')
    const fromStartup = new Set(filesIn(samplesDir))
    if (fromStartup.size) await page.waitForTimeout(NEXT_ASK_AFTER_A_SAMPLE_MS)
    const sampleOfTheHold = (): string =>
      filesIn(samplesDir)
        .filter((file) => !fromStartup.has(file))
        .find((file) => readOrEmpty(file).includes('com.apple.main-thread')) ?? ''

    let back = false
    const held = app
      .evaluate((_electron, ms) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
      }, MAIN_THREAD_HELD_MS)
      .then(() => (back = true))

    await expect.poll(sampleOfTheHold, { timeout: MAIN_THREAD_HELD_MS }).not.toBe('')
    const sample = sampleOfTheHold()
    expect(back).toBe(false)

    await held
    const lineNamingTheSample = (): string =>
      readOrEmpty(log)
        .split('\n')
        .find((line) => line.includes(sample)) ?? ''
    await expect.poll(lineNamingTheSample).not.toBe('')
    const goneForMs = Math.max(...(lineNamingTheSample().match(/\d+(?= ms)/g) ?? []).map(Number))
    expect(goneForMs).toBeGreaterThan(MAIN_THREAD_HELD_MS - 2 * STUCK_AFTER_MS)
  } finally {
    await quitAndClose(app)
  }
})
