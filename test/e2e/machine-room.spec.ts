import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  agySessionCalls,
  installAgy,
  installCodex,
  installMuse,
  museCalls,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import { fakeCodexLog, startCodex } from './helpers/codex'
import {
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  REMOTE_WS_NAME
} from './helpers/remote'
import {
  centerTerm,
  mainThreadPriority,
  newSessionInWith,
  openSessionTerminal,
  panelTerm,
  readCalls,
  runIn,
  startSessionIn,
  switchToRow,
  waitBooted,
  wsRows
} from './helpers/p1'

test.setTimeout(300_000)

// ADR-0042 PLATFORM§59
const GIVING_WAY = 4
const ABOVE_ITS_TOOLS = 46
const WHAT_ANY_OTHER_PROGRAM_GETS = 31
const TWO_READINGS_FIVE_SECONDS_APART_PLUS_ROOM_MS = 40_000
const ONE_READING_PLUS_ROOM_MS = 20_000

function memoryPressure(env: E2EEnv, pressure: 1 | 2 | 4): void {
  fs.writeFileSync(env.launchEnv.KOLOFT_TEST_MACHINE_FILE!, JSON.stringify({ pressure }))
}

const pressureRead = (env: E2EEnv, pressure: number): boolean =>
  fs.existsSync(path.join(env.userData, 'machine.log')) &&
  fs
    .readFileSync(path.join(env.userData, 'machine.log'), 'utf8')
    .includes(`memory pressure ${pressure}`)

let nextSleep = 0
const sleepsOfThisRun: number[] = []

function aSleepNoOtherTestRuns(): number {
  const seconds = 700_000 + (process.pid % 10_000) * 10 + nextSleep++
  sleepsOfThisRun.push(seconds)
  return seconds
}

function pidOfSleep(seconds: number): number | undefined {
  const line = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .find((l) => l.trim().endsWith(`sleep ${seconds}`))
  return line ? Number(line.trim().split(/\s+/)[0]) : undefined
}

function priorityOfSleep(seconds: number): number | undefined {
  const pid = pidOfSleep(seconds)
  return pid === undefined ? undefined : mainThreadPriority(pid)
}

function aToolThatStartsASecondOneOnAsking(
  env: E2EEnv,
  name: string
): { command: string; first: number; second: number; startTheSecond(): void } {
  const first = aSleepNoOtherTestRuns()
  const second = aSleepNoOtherTestRuns()
  const script = path.join(env.home, `tool-${name}.sh`)
  fs.writeFileSync(
    script,
    `sleep ${first} &\nwhile [ ! -e "$0.go" ]; do sleep 0.2; done\nsleep ${second} &\nwait\n`
  )
  return {
    command: `sh ${script}`,
    first,
    second,
    startTheSecond: () => fs.writeFileSync(`${script}.go`, '')
  }
}

const slowedMark = (row: Locator): Locator => row.locator('.ws-tab-parked', { hasText: /^slowed$/ })

async function tabIdOfTheRowOnScreen(page: Page): Promise<string> {
  return (await page.locator('.ws-tab.active').getAttribute('data-tab-id'))!
}

const rowOf = (page: Page, tabId: string): Locator =>
  page.locator(`.ws-tab[data-tab-id="${tabId}"]`)

test.afterEach(() => {
  for (const seconds of sleepsOfThisRun.splice(0)) {
    const pid = pidOfSleep(seconds)
    if (pid) process.kill(pid, 'SIGKILL')
  }
})

test('at warning nothing is slowed; once memory stays critical the tools of the session nobody looks at give way, its agent and its Workbench shell do not, clicking its row lifts it for good, and leaving critical lifts the rest', async ({
  env
}) => {
  seedSettings(env, { hintsOff: true })
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)

    await startSessionIn(page, 'ws-a')
    const away = await tabIdOfTheRowOnScreen(page)
    const awayTool = aToolThatStartsASecondOneOnAsking(env, 'away')
    await runIn(page, centerTerm(page), `/run ${awayTool.command}`)
    await expect.poll(() => priorityOfSleep(awayTool.first)).toBe(WHAT_ANY_OTHER_PROGRAM_GETS)
    const ownersOwnCommand = aSleepNoOtherTestRuns()
    await openSessionTerminal(app, page)
    await runIn(page, panelTerm(page), `sleep ${ownersOwnCommand}`)
    await expect.poll(() => priorityOfSleep(ownersOwnCommand)).toBe(WHAT_ANY_OTHER_PROGRAM_GETS)

    await startSessionIn(page, 'ws-b')
    const watched = await tabIdOfTheRowOnScreen(page)
    const watchedTool = aToolThatStartsASecondOneOnAsking(env, 'watched')
    await runIn(page, centerTerm(page), `/run ${watchedTool.command}`)
    await expect.poll(() => priorityOfSleep(watchedTool.first)).toBe(WHAT_ANY_OTHER_PROGRAM_GETS)
    const agents = readCalls(env).map((c) => c.pid)
    expect(agents.map(mainThreadPriority)).toEqual([ABOVE_ITS_TOOLS, ABOVE_ITS_TOOLS])

    memoryPressure(env, 2)
    await expect.poll(() => pressureRead(env, 2), { timeout: ONE_READING_PLUS_ROOM_MS }).toBe(true)
    expect(priorityOfSleep(awayTool.first)).toBe(WHAT_ANY_OTHER_PROGRAM_GETS)
    await expect(slowedMark(rowOf(page, away))).toHaveCount(0)

    memoryPressure(env, 4)
    await expect(slowedMark(rowOf(page, away))).toBeVisible({
      timeout: TWO_READINGS_FIVE_SECONDS_APART_PLUS_ROOM_MS
    })
    expect(priorityOfSleep(awayTool.first)).toBe(GIVING_WAY)
    expect(priorityOfSleep(watchedTool.first)).toBe(WHAT_ANY_OTHER_PROGRAM_GETS)
    expect(priorityOfSleep(ownersOwnCommand)).toBe(WHAT_ANY_OTHER_PROGRAM_GETS)
    expect(agents.map(mainThreadPriority)).toEqual([ABOVE_ITS_TOOLS, ABOVE_ITS_TOOLS])
    await expect(slowedMark(rowOf(page, watched))).toHaveCount(0)

    awayTool.startTheSecond()
    await expect
      .poll(() => priorityOfSleep(awayTool.second), { timeout: ONE_READING_PLUS_ROOM_MS })
      .toBe(GIVING_WAY)

    await switchToRow(page, rowOf(page, away))
    await expect(slowedMark(rowOf(page, away))).toHaveCount(0)
    await expect
      .poll(() => [priorityOfSleep(awayTool.first), priorityOfSleep(awayTool.second)])
      .toEqual([WHAT_ANY_OTHER_PROGRAM_GETS, WHAT_ANY_OTHER_PROGRAM_GETS])

    await expect(slowedMark(rowOf(page, watched))).toBeVisible({
      timeout: ONE_READING_PLUS_ROOM_MS
    })
    expect(priorityOfSleep(watchedTool.first)).toBe(GIVING_WAY)

    await switchToRow(page, rowOf(page, watched))
    await expect(slowedMark(rowOf(page, watched))).toHaveCount(0)
    await expect.poll(() => priorityOfSleep(watchedTool.first)).toBe(WHAT_ANY_OTHER_PROGRAM_GETS)
    await switchToRow(page, rowOf(page, away))
    await page.waitForTimeout(ONE_READING_PLUS_ROOM_MS)
    await expect(page.locator('.ws-tab-parked', { hasText: /^slowed$/ })).toHaveCount(0)
    expect([watchedTool.first, awayTool.first].map(priorityOfSleep)).toEqual([
      WHAT_ANY_OTHER_PROGRAM_GETS,
      WHAT_ANY_OTHER_PROGRAM_GETS
    ])

    memoryPressure(env, 1)
    await expect
      .poll(() => page.evaluate(() => window.api.machine.now().then((s) => s?.critical)), {
        timeout: ONE_READING_PLUS_ROOM_MS
      })
      .toBe(false)
  } finally {
    await quitAndClose(app)
  }
})

test('the tools of a Codex, a Muse and an Antigravity session nobody looks at give way too, their agent programs and the Codex server do not, and all are lifted when memory leaves critical', async ({
  env
}) => {
  installCodex(env)
  installMuse(env)
  installAgy(env)
  trustInMuse(env, env.workspaces.a)
  trustInAgy(env, env.workspaces.a)
  seedSettings(env, { hintsOff: true })
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)

    const codex = await startCodex(page, env)
    const codexTab = await tabIdOfTheRowOnScreen(page)
    const codexServer = fakeCodexLog<{ pid: number; tabId: string | null }>(
      env,
      'fake-codex-server-calls.jsonl'
    ).findLast((server) => server.tabId)!
    const codexTool = aSleepNoOtherTestRuns()
    await runIn(page, centerTerm(page), `/sh sleep ${codexTool}`)

    await newSessionInWith(page, 'ws-a', 'Muse')
    await expect.poll(() => museCalls(env).length).toBe(1)
    await expect(page.locator('.ws-tab.active')).toHaveClass(/st-waiting/, { timeout: 30_000 })
    const museTab = await tabIdOfTheRowOnScreen(page)
    const museTool = aSleepNoOtherTestRuns()
    await runIn(page, centerTerm(page), `/sh sleep ${museTool}`)

    await newSessionInWith(page, 'ws-a', 'Antigravity')
    await expect.poll(() => agySessionCalls(env).length).toBe(1)
    await expect(page.locator('.ws-tab.active')).toHaveClass(/st-waiting/, { timeout: 30_000 })
    const agyTab = await tabIdOfTheRowOnScreen(page)
    const agyTool = aSleepNoOtherTestRuns()
    await runIn(page, centerTerm(page), `!sleep ${agyTool}`)

    const tools = [codexTool, museTool, agyTool]
    await expect
      .poll(() => tools.map(priorityOfSleep))
      .toEqual(tools.map(() => WHAT_ANY_OTHER_PROGRAM_GETS))

    await startSessionIn(page, 'ws-b')
    memoryPressure(env, 4)
    for (const tab of [codexTab, museTab, agyTab])
      await expect(slowedMark(rowOf(page, tab))).toBeVisible({
        timeout: TWO_READINGS_FIVE_SECONDS_APART_PLUS_ROOM_MS
      })
    expect(tools.map(priorityOfSleep)).toEqual(tools.map(() => GIVING_WAY))
    expect({
      codex: mainThreadPriority(codex.pid),
      muse: mainThreadPriority(museCalls(env)[0].pid),
      agy: mainThreadPriority(agySessionCalls(env)[0].pid),
      codexServer: mainThreadPriority(codexServer.pid)
    }).toEqual({
      codex: ABOVE_ITS_TOOLS,
      muse: ABOVE_ITS_TOOLS,
      agy: ABOVE_ITS_TOOLS,
      codexServer: WHAT_ANY_OTHER_PROGRAM_GETS
    })

    memoryPressure(env, 1)
    await expect(page.locator('.ws-tab-parked', { hasText: /^slowed$/ })).toHaveCount(0, {
      timeout: ONE_READING_PLUS_ROOM_MS
    })
    await expect
      .poll(() => tools.map(priorityOfSleep))
      .toEqual(tools.map(() => WHAT_ANY_OTHER_PROGRAM_GETS))
  } finally {
    await quitAndClose(app)
  }
})

test.describe('a session on another machine', () => {
  test.afterEach(({ env }) => killFakeRemote(env))

  test('is never slowed and never marked: its tools run on the machine, out of reach of this Mac, while a session here beside it is slowed', async ({
    env
  }) => {
    seedSettings(env, { hintsOff: true })
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await switchToRow(page, wsRows(page, REMOTE_WS_NAME).first())
      const there = await tabIdOfTheRowOnScreen(page)
      const toolThere = aSleepNoOtherTestRuns()
      await runIn(page, centerTerm(page), `/run sleep ${toolThere}`)
      await expect
        .poll(() => priorityOfSleep(toolThere), { timeout: 30_000 })
        .toBe(WHAT_ANY_OTHER_PROGRAM_GETS)

      await startSessionIn(page, 'ws-a')
      const here = await tabIdOfTheRowOnScreen(page)
      const toolHere = aSleepNoOtherTestRuns()
      await runIn(page, centerTerm(page), `/run sleep ${toolHere}`)
      await expect.poll(() => priorityOfSleep(toolHere)).toBe(WHAT_ANY_OTHER_PROGRAM_GETS)

      await startSessionIn(page, 'ws-b')
      memoryPressure(env, 4)
      await expect(slowedMark(rowOf(page, here))).toBeVisible({
        timeout: TWO_READINGS_FIVE_SECONDS_APART_PLUS_ROOM_MS
      })
      expect(priorityOfSleep(toolHere)).toBe(GIVING_WAY)
      await expect(slowedMark(rowOf(page, there))).toHaveCount(0)
      expect(priorityOfSleep(toolThere)).toBe(WHAT_ANY_OTHER_PROGRAM_GETS)
    } finally {
      await quitAndClose(app)
    }
  })
})
