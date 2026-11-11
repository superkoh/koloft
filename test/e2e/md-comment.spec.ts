import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import {
  boundSessionId,
  centerTerm,
  runIn,
  startSessionIn,
  transcriptFile,
  waitBooted,
  wsRows
} from './helpers/p1'
import {
  PLAN_WORDS,
  artifactBody,
  browseRow,
  claudePrompts,
  commentOnPlan,
  expectOnePromptFromThePassage,
  openFileTab,
  openInBrowse,
  passageCommentButton,
  planPassagePaste,
  selectWords,
  showBrowse,
  writePlan
} from './helpers/workbench'
import type { E2EEnv } from './helpers/env'

async function claudeTranscriptOf(page: Page, env: E2EEnv): Promise<string> {
  const tabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
  await expect.poll(() => boundSessionId(page, tabId), { timeout: 30_000 }).toBeTruthy()
  return transcriptFile(env.home, env.workspaces.a, (await boundSessionId(page, tabId)) ?? '')
}

test.describe('✎ comment on a rendered Markdown file puts the passage in the session’s input box', () => {
  test('MD-C01: words selected in a Markdown file read in the Files panel, ✎ comment and a note put path:line, the file’s own line in a markdown fence and the words in the input box, the note typed after, unsent until Enter', async ({
    page,
    env
  }) => {
    const plan = writePlan(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    const transcript = await claudeTranscriptOf(page, env)
    await openInBrowse(page, plan)

    const note = 'MD-C01 make it 5 tries'
    await commentOnPlan(page, note)
    await expectOnePromptFromThePassage(() => claudePrompts(transcript), note)
  })

  test('MD-C02: in a Markdown file tab, lines added above the passage while it is open move the line the comment names, though the block itself is not redrawn', async ({
    page,
    env
  }) => {
    const plan = writePlan(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    const transcript = await claudeTranscriptOf(page, env)
    await openFileTab(page, env, plan)
    const body = artifactBody(page).locator('.md-body')
    await expect(body).toContainText(PLAN_WORDS, { timeout: 30_000 })
    await body
      .locator('li')
      .nth(1)
      .evaluate((li) => ((li as HTMLElement & { __kept?: boolean }).__kept = true))

    writePlan(env.workspaces.a, 'Added on top.\n\n')
    await expect(body).toContainText('Added on top.', { timeout: 30_000 })
    expect(
      await body
        .locator('li')
        .nth(1)
        .evaluate((li) => !!(li as HTMLElement & { __kept?: boolean }).__kept)
    ).toBe(true)

    const note = 'MD-C02 the line moved down two'
    await commentOnPlan(page, note)
    await expectOnePromptFromThePassage(() => claudePrompts(transcript), note, planPassagePaste(8))
  })

  test('MD-C04: a selection running through a code block names the lines from its first block to its last and quotes the words without the code block’s language label or Copy button', async ({
    page,
    env
  }) => {
    const doc = path.join(env.workspaces.a, 'docs', 'code.md')
    fs.mkdirSync(path.dirname(doc), { recursive: true })
    fs.writeFileSync(doc, 'Run this first:\n\n```ts\nconst tries = 3\n```\n\nThen wait.\n')
    await startSessionIn(page, 'ws-a')
    await claudeTranscriptOf(page, env)
    await openInBrowse(page, doc)

    await selectWords(page, 'this first', 'Then wait')
    const button = passageCommentButton(page)
    await expect(button).toBeEnabled({ timeout: 30_000 })
    await button.click()
    const head = artifactBody(page).locator('.cv-comment .cv-hunk-hd')
    await expect(head).toHaveText('docs/code.md:1-7 · “this first: const tries = 3 Then wait”')
  })

  test('MD-C03: ✎ comment is greyed in a workspace’s own Workbench, which has no session, and in a session waiting for an approval, and comes back once it is answered', async ({
    page,
    env
  }) => {
    const plan = writePlan(env.workspaces.a)
    await waitBooted(page)
    await openInBrowse(page, plan, true)
    await selectWords(page, PLAN_WORDS)
    const button = passageCommentButton(page)
    await expect(button).toBeDisabled({ timeout: 30_000 })
    await expect(button).toHaveAttribute('title', 'No running session to put it in')

    await startSessionIn(page, 'ws-a')
    await claudeTranscriptOf(page, env)
    await runIn(page, centerTerm(page), '/need-approval')
    await expect(wsRows(page, 'ws-a').first()).toHaveClass(/st-approval/, { timeout: 30_000 })
    await showBrowse(page)
    await browseRow(page, plan).click()
    await selectWords(page, PLAN_WORDS)
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute('title', /waiting for an approval/)

    await runIn(page, centerTerm(page), 'back to work')
    await expect(wsRows(page, 'ws-a').first()).not.toHaveClass(/st-approval/, { timeout: 30_000 })
    await selectWords(page, PLAN_WORDS)
    await expect(button).toBeEnabled({ timeout: 30_000 })
  })
})
