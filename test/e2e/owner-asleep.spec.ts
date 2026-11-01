import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  newSessionInWith,
  startSessionIn,
  transcriptFile,
  waitForCalls,
  wsRows,
  type ClaudeCall
} from './helpers/p1'
import { installCodex, type E2EEnv } from './helpers/env'
import { fakeCodexLog } from './helpers/codex'
import { OWNER_ASLEEP_ANSWER } from '../../src/main/ownerAsleep'
import { OWNER_ASLEEP_FILE, OWNER_ASLEEP_PUSH } from '../../src/main/hooks'

const KOLOFT_ANSWERS_AND_THE_TURN_ENDS_MS = 20_000
const THE_BUTLER_STARTS_AND_READS_IT_MS = 60_000

function transcriptText(env: E2EEnv, call: ClaudeCall): string {
  const file = transcriptFile(env.home, call.cwd, call.sessionId)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function peerMessages(env: E2EEnv): string {
  const file = path.join(env.home, 'fake-claude-peer.jsonl')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

async function tabOf(page: Page, sessionId: string): Promise<string> {
  const all = await page.evaluate(() => window.api.sessions.list())
  return all.find((s) => s.sessionId === sessionId)!.tabId
}

const asJson = (text: string): string => JSON.stringify(text).slice(1, -1)

interface WireFrame {
  direction: string
  frame: { method?: string; result?: { answers?: unknown } }
}

const codexWire = (env: E2EEnv): WireFrame[] =>
  fakeCodexLog<WireFrame>(env, 'fake-codex-wire.jsonl')

function codexAsked(env: E2EEnv): number {
  return codexWire(env).filter(
    (w) => w.direction === 'server' && w.frame.method === 'item/tool/requestUserInput'
  ).length
}

function codexAnswers(env: E2EEnv): unknown[] {
  return codexWire(env)
    .filter((w) => w.direction === 'client' && w.frame.result?.answers)
    .map((w) => w.frame.result)
}

test.describe('owner asleep', () => {
  test('the sidebar switch puts the owner to sleep: a session’s question is answered for them with "choose your own recommendation", its approval is allowed, its turn is pushed once to go on by itself, and the owner pressing Enter in a terminal wakes them, takes the mark away and hands the butler what happened', async ({
    env,
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    const call = (await waitForCalls(env, 1))[0]
    const tab = await tabOf(page, call.sessionId)
    const type = (line: string): Promise<void> =>
      page.evaluate(([id, l]) => window.api.terminal.write(id, l + '\r'), [tab, line])
    const marker = path.join(env.userData, 'hook-sessions', OWNER_ASLEEP_FILE)
    const transcript = (): string => transcriptText(env, call)

    await type('/later /ask Which colour?|Red|Green')
    const asleep = page.locator('.tb-ico[aria-label="Owner asleep"]')
    await asleep.click()
    await expect(asleep).toHaveClass(/\bon\b/)
    await expect.poll(() => fs.existsSync(marker)).toBe(true)

    fs.writeFileSync(path.join(env.home, 'go-later'), '')
    await expect
      .poll(transcript, { timeout: KOLOFT_ANSWERS_AND_THE_TURN_ENDS_MS })
      .toContain(`Picked: ${asJson(OWNER_ASLEEP_ANSWER)}`)
    await expect
      .poll(transcript, { timeout: KOLOFT_ANSWERS_AND_THE_TURN_ENDS_MS })
      .toContain(`Stop said: ${asJson(OWNER_ASLEEP_PUSH)}`)

    await type('')
    await expect(asleep).not.toHaveClass(/\bon\b/)
    await expect.poll(() => fs.existsSync(marker)).toBe(false)
    await expect
      .poll(() => peerMessages(env), { timeout: THE_BUTLER_STARTS_AND_READS_IT_MS })
      .toContain('The owner was asleep for')
    expect(peerMessages(env)).toContain('Koloft told it to choose its own recommendation and go on')
  })

  test('a Codex question already showing when the owner falls asleep is answered by its keys with the words "choose your own recommendation"', async ({
    env
  }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await newSessionInWith(page, 'ws-a', 'Codex')
      await expect(wsRows(page, 'ws-a')).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const tab = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.backendId === 'codex'
      )!.tabId
      await page.evaluate((id) => window.api.terminal.write(id, 'please ask me\r'), tab)
      await expect(wsRows(page, 'ws-a')).toHaveClass(/\bst-approval\b/)
      expect(codexAsked(env)).toBe(1)

      await page.locator('.tb-ico[aria-label="Owner asleep"]').click()
      await expect
        .poll(() => codexAnswers(env), { timeout: KOLOFT_ANSWERS_AND_THE_TURN_ENDS_MS })
        .toEqual([
          {
            answers: {
              colour: { answers: ['None of the above', `user_note: ${OWNER_ASLEEP_ANSWER}`] }
            }
          }
        ])
    } finally {
      await quitAndClose(app)
    }
  })

  test('a command a session asks to run while the owner is asleep is allowed for them, and it runs', async ({
    env,
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    const call = (await waitForCalls(env, 1))[0]
    const tab = await tabOf(page, call.sessionId)
    await page.evaluate((id) => window.api.terminal.write(id, '/later /bash npm publish\r'), tab)
    const asleep = page.locator('.tb-ico[aria-label="Owner asleep"]')
    await asleep.click()
    await expect(asleep).toHaveClass(/\bon\b/)

    fs.writeFileSync(path.join(env.home, 'go-later'), '')
    await expect
      .poll(() => transcriptText(env, call), { timeout: KOLOFT_ANSWERS_AND_THE_TURN_ENDS_MS })
      .toContain('Ran: npm publish')
  })
})
