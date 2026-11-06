import fs from 'fs'
import path from 'path'
import type { CDPSession, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  centerTerm,
  gitInit,
  openWorktreeSession,
  runIn,
  sendShortcut,
  startSessionIn,
  terminalText,
  transcriptFile,
  waitBooted,
  waitForCalls,
  worktreeDialog,
  wsRows
} from './helpers/p1'
import { claudePrompts } from './helpers/workbench'

const PINYIN = 'nihao'
const HANZI = '你好'
const CHROMIUM_KEYCODE_OF_A_KEY_THE_INPUT_METHOD_TOOK = 229

// PLATFORM§18
async function composeThenPressEnter(page: Page, pinyin: string): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page)
  for (let i = 1; i <= pinyin.length; i++) {
    await cdp.send('Input.imeSetComposition', {
      text: pinyin.slice(0, i),
      selectionStart: i,
      selectionEnd: i
    })
  }
  const enter = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: CHROMIUM_KEYCODE_OF_A_KEY_THE_INPUT_METHOD_TOOK
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...enter })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
  return cdp
}

async function commit(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send('Input.insertText', { text })
}

async function commitWithKeysQueuedRightBehindIt(
  cdp: CDPSession,
  text: string,
  keys: { key: string; code: string; windowsVirtualKeyCode: number; text: string }[]
): Promise<void> {
  await Promise.all([
    commit(cdp, text),
    ...keys.flatMap((k) => [
      cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k }),
      cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined })
    ])
  ])
}

test.describe('Chinese input method: an Enter pressed while a word is still being composed picks the word and submits nothing', () => {
  test('in a session terminal, the Enter inside the composition sends nothing; the next Enter sends the line with the word', async ({
    page,
    env
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    const transcript = transcriptFile(env.home, env.workspaces.a, call.sessionId)

    await centerTerm(page).click()
    await page.keyboard.type('say ')
    const cdp = await composeThenPressEnter(page, PINYIN)
    await commit(cdp, HANZI)
    await page.keyboard.press('Enter')

    await expect
      .poll(() => claudePrompts(transcript), { timeout: 30_000 })
      .toContain(`say ${HANZI}`)
    expect(claudePrompts(transcript).filter((p) => p.startsWith('say'))).toEqual([`say ${HANZI}`])
  })

  test('in a session terminal, keys queued right behind the commit (a letter, then Enter) all reach the session, and the word is sent once', async ({
    page,
    env
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    const transcript = transcriptFile(env.home, env.workspaces.a, call.sessionId)

    await centerTerm(page).click()
    await page.keyboard.type('say ')
    const cdp = await composeThenPressEnter(page, PINYIN)
    await commitWithKeysQueuedRightBehindIt(cdp, HANZI, [
      { key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, text: 'x' },
      { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }
    ])

    await expect
      .poll(() => claudePrompts(transcript), { timeout: 30_000 })
      .toContain(`say ${HANZI}x`)
    expect(claudePrompts(transcript).filter((p) => p.startsWith('say'))).toEqual([`say ${HANZI}x`])
  })

  test('in ⌘P, the Enter inside the composition starts nothing; the next Enter starts the session with the word', async ({
    env
  }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)
    fs.writeFileSync(
      path.join(env.home, 'fake-claude-assist-reply'),
      JSON.stringify({ workspace: 1, worktree: 'main', title: 'IME', sure: true, why: 'ws-a' })
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:command-palette')
      const askBox = page.locator('.modal.palette').getByRole('textbox', { name: 'Ask or jump' })
      await expect(askBox).toBeFocused()
      await page.keyboard.type('say ')
      const cdp = await composeThenPressEnter(page, PINYIN)
      await expect(page.locator('.modal.palette')).toBeVisible()
      await commit(cdp, HANZI)
      await expect(askBox).toHaveValue(`say ${HANZI}`)
      await page.keyboard.press('Enter')

      const [call] = await waitForCalls(env, 1, 30_000)
      expect(call.argv[call.argv.indexOf('--') + 1]).toBe(`say ${HANZI}`)
    } finally {
      await quitAndClose(app)
    }
  })

  test('in an Inbox question card’s own-answer box, the Enter inside the composition sends nothing; the next Enter answers with the word', async ({
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const row = wsRows(page, 'ws-a').first()
    await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 15_000 })
    const tabId = (await row.getAttribute('data-tab-id')) as string
    await runIn(page, centerTerm(page), '/ask Which colour?|Red|Green')
    await expect(row).toHaveClass(/\bst-approval\b/, { timeout: 15_000 })
    await page.locator('.ibx-entry').click()
    const card = page.locator('.inbox-page .ibx-item.focus')
    const own = card.getByPlaceholder(/Type your own answer/)
    await own.click()
    const cdp = await composeThenPressEnter(page, PINYIN)
    await commit(cdp, HANZI)
    await expect(own).toHaveValue(HANZI)
    await expect(card.locator('.ibx-undo')).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect(card.locator('.ibx-undo')).toBeVisible()
    await expect.poll(() => terminalText(page, tabId), { timeout: 20_000 }).toContain(HANZI)
    expect(await terminalText(page, tabId)).not.toContain(PINYIN)
  })

  test('in the C8 New Worktree Session dialog, the Enter inside the composition creates nothing; the next Enter starts in the worktree with the whole name', async ({
    env
  }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'ws-a')
      const name = dlg.locator('input')
      await name.click()
      await name.fill('ime-')
      const cdp = await composeThenPressEnter(page, 'test')
      await expect(worktreeDialog(page)).toBeVisible()
      await commit(cdp, 'test')
      await expect(name).toHaveValue('ime-test')
      await page.keyboard.press('Enter')

      const [call] = await waitForCalls(env, 1, 30_000)
      expect(call.argv.join(' ')).toContain('-w ime-test')
    } finally {
      await quitAndClose(app)
    }
  })
})
