import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  agyConversationOnceFirstTurnEnded,
  boundSessionId,
  centerTerm,
  newSessionInWith,
  runIn,
  startSessionIn,
  transcriptFile,
  waitBooted,
  wsRows
} from './helpers/p1'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  agyReady,
  killFakeRemote,
  launchWithRemote,
  remoteDir,
  remoteKey,
  type OtherAgentName
} from './helpers/remote'
import {
  PLAN_REL,
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
import { installAgentFor, seedSettings, type E2EEnv } from './helpers/env'

test.afterEach(({ env }) => killFakeRemote(env))

const ON_THE_MACHINE_WITHIN_MS = 60_000

interface ApprovalKeys {
  asks: string
  answers: string
  needsPermissionPrompts?: true
}

const LOCAL_APPROVAL: Record<OtherAgentName, ApprovalKeys> = {
  Codex: { asks: 'approve\r', answers: 'y' },
  Muse: { asks: '/approve\r', answers: 'y' },
  // AGY§10
  Antigravity: { asks: '/bash echo declined\r', answers: '\x1b', needsPermissionPrompts: true }
}

const REMOTE_APPROVAL: Record<OtherAgentName | 'Claude', ApprovalKeys> = {
  Claude: { asks: '/bash rm -rf build\r', answers: '1\r' },
  Codex: { asks: 'approve\r', answers: 'y' },
  Muse: { asks: '/approve\r', answers: 'y' },
  // AGY§29
  Antigravity: { asks: '/bash echo declined\r', answers: '4', needsPermissionPrompts: true }
}

function seedFor(env: E2EEnv, keys: ApprovalKeys): void {
  seedSettings(env, {
    hintsOff: true,
    ...(keys.needsPermissionPrompts ? { skipPermissions: false } : {})
  })
}

async function launchedHere(env: E2EEnv) {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  return { app, page }
}

const TABS_WAITING_FOR_AN_APPROVAL = [
  ...OTHER_AGENTS_ON_THE_MACHINE.map((agent) => ({
    kind: `a local ${agent.label}`,
    keys: LOCAL_APPROVAL[agent.label],
    open: async (env: E2EEnv) => {
      installAgentFor(env, agent.label, env.workspaces.a)
      seedFor(env, LOCAL_APPROVAL[agent.label])
      const plan = writePlan(env.workspaces.a)
      const { app, page } = await launchedHere(env)
      await newSessionInWith(page, 'ws-a', agent.label)
      if (agent.label === 'Antigravity') {
        await agyReady(page)
        await runIn(page, centerTerm(page), 'first words')
        await agyConversationOnceFirstTurnEnded(page)
      }
      return { app, page, wsName: 'ws-a', plan }
    }
  })),
  {
    kind: 'a remote (ssh) Claude Code',
    keys: REMOTE_APPROVAL.Claude,
    open: async (env: E2EEnv) => {
      seedFor(env, REMOTE_APPROVAL.Claude)
      const { app, page } = await launchWithRemote(env)
      writePlan(remoteDir(env))
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      return { app, page, wsName: REMOTE_WS_NAME, plan: `${remoteKey(env)}/${PLAN_REL}` }
    }
  },
  ...OTHER_AGENTS_ON_THE_MACHINE.map((agent) => ({
    kind: `a remote (ssh) ${agent.label}`,
    keys: REMOTE_APPROVAL[agent.label],
    open: async (env: E2EEnv) => {
      agent.install(env)
      seedFor(env, REMOTE_APPROVAL[agent.label])
      const { app, page } = await launchWithRemote(env)
      writePlan(remoteDir(env))
      await addRemoteWorkspace(page, env)
      await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
      await agent.bound?.(page)
      return { app, page, wsName: REMOTE_WS_NAME, plan: `${remoteKey(env)}/${PLAN_REL}` }
    }
  }))
]

function typeInto(page: Page, tabId: string, keys: string): Promise<void> {
  return page.evaluate(([id, k]) => window.api.terminal.write(id, k), [tabId, keys])
}

async function selectPlanWordsAfresh(page: Page): Promise<void> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await selectWords(page, PLAN_WORDS)
}

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

  for (const tab of TABS_WAITING_FOR_AN_APPROVAL)
    test(`MD-C03 in ${tab.kind} tab: ✎ comment is greyed while the session waits for an approval, and comes back once it is answered`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      const { app, page, wsName, plan } = await tab.open(env)
      try {
        const row = wsRows(page, wsName).first()
        await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: ON_THE_MACHINE_WITHIN_MS })
        const tabId = (await row.getAttribute('data-tab-id')) as string
        await openInBrowse(page, plan)
        await selectPlanWordsAfresh(page)
        const button = passageCommentButton(page)
        await expect(button).toBeEnabled({ timeout: 30_000 })

        await typeInto(page, tabId, tab.keys.asks)
        await expect(row).toHaveClass(/\bst-approval\b/, { timeout: ON_THE_MACHINE_WITHIN_MS })
        await selectPlanWordsAfresh(page)
        await expect(button).toBeDisabled()
        await expect(button).toHaveAttribute('title', /waiting for an approval/)

        await typeInto(page, tabId, tab.keys.answers)
        await expect(row).not.toHaveClass(/\bst-approval\b/, { timeout: ON_THE_MACHINE_WITHIN_MS })
        await selectPlanWordsAfresh(page)
        await expect(button).toBeEnabled({ timeout: 30_000 })
      } finally {
        await quitAndClose(app)
      }
    })
})
