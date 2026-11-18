import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { waitBooted } from './helpers/p1'

const STUCK_AFTER_MS = 1000
const MAIN_THREAD_HELD_MS = 15_000

function readOrEmpty(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

const count = (text: string, part: string): number => text.split(part).length - 1

test('an error nobody caught in the main process is written down and shown as a toast, and never opens the box that holds the whole app until someone clicks it', async ({
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
    setTimeout(() => {
      throw new Error('thrown in a timer by the test')
    }, 0)
  })
  await expect(page.locator('.toast-msg')).toContainText('thrown in a timer by the test')
  await expect
    .poll(() => readOrEmpty(path.join(env.userData, 'main-errors.log')))
    .toMatch(/Error: thrown in a timer by the test\n\s+at /)
  expect(await app.evaluate(() => (globalThis as { __errorBoxes?: number }).__errorBoxes)).toBe(0)
})

test('while the main thread is stuck, a line and a sample of what it is in are written at that moment, not once it is back, and a line follows when it takes work again', async ({
  env
}) => {
  env.launchEnv.KOLOFT_MAIN_STUCK_MS = String(STUCK_AFTER_MS)
  const app = await launchApp(env)
  try {
    await waitBooted(await app.firstWindow())
    const log = path.join(env.userData, 'main-stalls.log')
    const STUCK = 'and is still stuck'
    const BACK = 'main thread took work again after'
    await expect
      .poll(() => count(readOrEmpty(log), STUCK) === count(readOrEmpty(log), BACK))
      .toBe(true)
    const before = readOrEmpty(log).length
    const sinceHeld = (): string => readOrEmpty(log).slice(before)

    const held = app.evaluate((_electron, ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    }, MAIN_THREAD_HELD_MS)

    await expect
      .poll(sinceHeld, { timeout: MAIN_THREAD_HELD_MS })
      .toMatch(/what the main thread was in while stuck: .+\.txt\n/)
    const written = sinceHeld()
    expect(written).toContain(`no new work for ${STUCK_AFTER_MS} ms ${STUCK}`)
    expect(written).not.toContain(BACK)
    const sample = /while stuck: (.+\.txt)\n/.exec(written)![1]
    expect(fs.readFileSync(sample, 'utf8')).toContain('com.apple.main-thread')

    await held
    await expect.poll(sinceHeld).toMatch(/main thread took work again after \d+ ms\n/)
  } finally {
    await quitAndClose(app)
  }
})
