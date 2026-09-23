import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { EventEmitter } from 'events'
import type { SessionInfo, SessionStatus } from '@shared/types'

/*
 * Run-state vs background work (subagents / workflows / shells / monitors).
 *
 * Requirement under test: a Claude session with ANY live background task —
 * subagent, teammate, Workflow, cloud agent, background shell, Monitor — is
 * WORKING: a turn-end (Stop hook, or an Esc interrupt, which fires NO Stop)
 * must not flip the dot to 'waiting' (nor raise a turn-done notification
 * edge) until the background drains. Detection channels:
 *   - ledger: spawn acks (toolUseResult.status async_launched/teammate_spawned,
 *     backgroundTaskId, Monitor's taskId) minus delivered task-notifications
 *     (terminal statuses)
 *   - recency: subagent-transcript records' own timestamps
 * An Esc interrupt is written to the transcript as a user record whose text is
 * exactly "[Request interrupted by user(for tool use)?]" — it ends the turn
 * (no Stop hook will ever come), it is NOT a genuine new prompt.
 *
 * Timing knobs are shrunk via env BEFORE the dynamic import (same pattern as
 * $HOME): hold window 400ms, ledger-silence backstop 1500ms, subagent poll
 * 250ms, stop-settle margin 300ms — so the suite stays inside the fast PR gate
 * instead of sleeping against the production 5s/2s constants.
 */
const HOLD_MS = 400
const SILENCE_MS = 1500
const SCAN_MS = 250
const RESUME_MS = 300
const SERVER_AGE_MS = 1000
const TEAMMATE_QUIET_MS = 500
// 's timer chain, shrunk the same way: 'waiting' downgrades to 'idle' after
// IDLE_MS, and an idle session is auto-closed IDLE_CLOSE_MS later (a refusal
// postpones by another IDLE_CLOSE_MS).
const IDLE_MS = 2000
const IDLE_CLOSE_MS = 400

let SessionTracker: typeof import('../../src/main/sessionTracker').SessionTracker
let encodeCwd: typeof import('../../src/main/sessionTracker').encodeCwd
let home: string
let projectsRoot: string

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-bgstatus-home-'))
  process.env.HOME = home
  process.env.KOLOFT_STOP_HOLD_MS = String(HOLD_MS)
  process.env.KOLOFT_BG_SILENCE_MS = String(SILENCE_MS)
  process.env.KOLOFT_SUBAGENT_SCAN_MS = String(SCAN_MS)
  process.env.KOLOFT_RESUME_AFTER_STOP_MS = String(RESUME_MS)
  // typed-list judgement knobs (see 'run-state from the typed task list'): a
  // shell older than 1s reads as a server, a teammate quiet for 500ms as idle,
  // the staged OS view is re-read every 100ms
  process.env.KOLOFT_SERVER_AGE_MS = String(SERVER_AGE_MS)
  process.env.KOLOFT_TEAMMATE_QUIET_MS = String(TEAMMATE_QUIET_MS)
  process.env.KOLOFT_PROCS_SCAN_MS = '100'
  process.env.KOLOFT_IDLE_MS = String(IDLE_MS)
  process.env.KOLOFT_IDLE_CLOSE_MS = String(IDLE_CLOSE_MS)
  projectsRoot = path.join(home, '.claude', 'projects')
  ;({ SessionTracker, encodeCwd } = await import('../../src/main/sessionTracker'))
})

afterAll(() => {
  delete process.env.KOLOFT_STOP_HOLD_MS
  delete process.env.KOLOFT_BG_SILENCE_MS
  delete process.env.KOLOFT_SUBAGENT_SCAN_MS
  delete process.env.KOLOFT_RESUME_AFTER_STOP_MS
  delete process.env.KOLOFT_SERVER_AGE_MS
  delete process.env.KOLOFT_TEAMMATE_QUIET_MS
  delete process.env.KOLOFT_PROCS_SCAN_MS
  delete process.env.KOLOFT_IDLE_MS
  delete process.env.KOLOFT_IDLE_CLOSE_MS
  fs.rmSync(home, { recursive: true, force: true })
})

const trackers: InstanceType<typeof SessionTracker>[] = []
afterEach(() => {
  for (const t of trackers) for (const s of t.list()) t.untrack(s.tabId)
  trackers.length = 0
})

function newTracker(): InstanceType<typeof SessionTracker> {
  const t = new SessionTracker()
  trackers.push(t)
  return t
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function makeWorkspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(home, 'ws-')))
}

function jsonlPath(cwd: string, sessionId: string): string {
  const dir = path.join(projectsRoot, encodeCwd(cwd))
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, sessionId + '.jsonl')
}

function writeJsonl(cwd: string, sessionId: string, lines: unknown[]): string {
  const file = jsonlPath(cwd, sessionId)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

function appendJsonl(file: string, lines: unknown[]): void {
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

function writeSubagentJsonl(
  cwd: string,
  sessionId: string,
  name: string,
  lines: unknown[],
  subPath = ''
): void {
  const dir = path.join(projectsRoot, encodeCwd(cwd), sessionId, 'subagents', subPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** the tool_result user record acknowledging a background Agent/Workflow spawn,
 *  shaped like real transcripts (toolUseResult.status is the discriminator) */
function spawnRec(
  toolUseId: string,
  cwd: string,
  status: 'async_launched' | 'teammate_spawned' | 'remote_launched' = 'async_launched',
  extra: Record<string, unknown> = {}
): unknown {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    toolUseResult: { status, agentId: 'a' + toolUseId, ...extra },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Spawned successfully.' }]
    },
    cwd
  }
}

/** the tool_result user record acknowledging a SKILL launched into a background
 *  agent (`/code-review` and friends). Real shape, claude 2.1.227: the Skill
 *  tool's result carries `status:'forked'` + `background:true` + the agent id —
 *  no async_launched, no backgroundTaskId. The tool's other mode — a skill run
 *  in a subagent whose result is already the finished work — forks too, and
 *  real transcripts show it OMITTING the key entirely (not `background:false`),
 *  so `background = false` here drops it rather than setting it. */
function forkedSkillRec(
  toolUseId: string,
  cwd: string,
  background = true,
  commandName = 'code-review'
): unknown {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    toolUseResult: {
      success: true,
      commandName,
      status: 'forked',
      ...(background ? { background: true } : {}),
      agentId: 'a' + toolUseId,
      result: `Running in the background as @${commandName}`
    },
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Skill "${commandName}" launched (forked execution, running in the background).`
        }
      ]
    },
    cwd
  }
}

/** the tool_result user record acknowledging a BACKGROUND SHELL. Real shape:
 *  toolUseResult carries `backgroundTaskId`; a shell the model was blocked on
 *  additionally carries `timedOutAfterMs` (auto-backgrounded at its timeout)
 *  or `backgroundedByUser` (the user hit Ctrl+B). All variants ledger. */
function shellAckRec(toolUseId: string, cwd: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    toolUseResult: {
      stdout: '',
      stderr: '',
      interrupted: false,
      isImage: false,
      backgroundTaskId: 'b' + toolUseId,
      ...extra
    },
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Command running in background with ID: b${toolUseId}.`
        }
      ]
    },
    cwd
  }
}

/** the `<task-notification>` payload naming the spawning tool-use-id */
function notifText(toolUseId: string, status: string): string {
  return (
    `<task-notification>\n<task-id>t_${toolUseId}</task-id>\n` +
    `<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n` +
    `<summary>done</summary>\n</task-notification>`
  )
}

/** how CURRENT Claude Code delivers a task-notification: an attachment record
 *  (`queued_command` / commandMode 'task-notification'), NOT a user record */
function attachNotifRec(toolUseId: string, cwd: string, status = 'completed'): unknown {
  return {
    type: 'attachment',
    timestamp: new Date().toISOString(),
    attachment: {
      type: 'queued_command',
      prompt: notifText(toolUseId, status),
      commandMode: 'task-notification'
    },
    cwd
  }
}

/** the queue bookkeeping record written the moment a task reports — the same
 *  payload, delivered a beat before the attachment */
function queueNotifRec(
  toolUseId: string,
  operation: 'enqueue' | 'remove' = 'enqueue',
  status = 'completed'
): unknown {
  return {
    type: 'queue-operation',
    operation,
    timestamp: new Date().toISOString(),
    content: notifText(toolUseId, status)
  }
}

/** the user record Claude Code appends when the user Esc-interrupts a turn —
 *  real shape verified against live transcripts: a plain text block whose text
 *  is exactly the marker (variant "for tool use" when a tool was in flight).
 *  Crucially, NO Stop hook fires for an interrupted turn. */
function interruptRec(cwd: string, atMs = Date.now(), forToolUse = false): unknown {
  return {
    type: 'user',
    timestamp: new Date(atMs).toISOString(),
    isSidechain: false,
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: forToolUse
            ? '[Request interrupted by user for tool use]'
            : '[Request interrupted by user]'
        }
      ]
    },
    cwd
  }
}

/** the tool_result user record acknowledging a Monitor registration — real
 *  shape: toolUseResult is {taskId, timeoutMs, persistent}, no status field */
function monitorAckRec(toolUseId: string, cwd: string): unknown {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    toolUseResult: { taskId: 'm' + toolUseId, timeoutMs: 900_000, persistent: false },
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Monitor started (task m${toolUseId}…).`
        }
      ]
    },
    cwd
  }
}

/** an assistant record in the MAIN transcript at a given record time */
function mainAssistantRec(cwd: string, atMs = Date.now(), sidechain = false): unknown {
  return {
    type: 'assistant',
    timestamp: new Date(atMs).toISOString(),
    isSidechain: sidechain,
    message: { role: 'assistant', content: [{ type: 'text', text: 'working…' }] },
    cwd
  }
}

/** the delivered task-notification user record that terminates a background task */
function notifRec(
  toolUseId: string,
  cwd: string,
  status: 'completed' | 'failed' | 'killed' = 'completed'
): unknown {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content:
        `<task-notification>\n<task-id>t_${toolUseId}</task-id>\n` +
        `<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n` +
        `<summary>done</summary>\n</task-notification>`
    },
    cwd
  }
}

function subagentRec(atMs: number): unknown {
  return {
    type: 'assistant',
    timestamp: new Date(atMs).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'thinking…' }] }
  }
}

function initialLines(cwd: string): unknown[] {
  return [
    { type: 'user', message: { role: 'user', content: 'do some work' }, cwd },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
      cwd
    }
  ]
}

function status(tracker: InstanceType<typeof SessionTracker>, tabId: string): string | undefined {
  return tracker.list().find((s) => s.tabId === tabId)?.status
}

function waitFor(
  tracker: EventEmitter,
  pred: (s: SessionInfo) => boolean,
  timeoutMs = 10_000
): Promise<SessionInfo> {
  return new Promise((resolve, reject) => {
    const done = (s: SessionInfo): void => {
      clearTimeout(to)
      tracker.off('update', onUpdate)
      resolve(s)
    }
    const onUpdate = (list: SessionInfo[]): void => {
      const hit = list.find(pred)
      if (hit) done(hit)
    }
    const to = setTimeout(() => {
      tracker.off('update', onUpdate)
      reject(new Error('timed out waiting for session update'))
    }, timeoutMs)
    tracker.on('update', onUpdate)
    const cur = (tracker as unknown as { list(): SessionInfo[] }).list().find(pred)
    if (cur) done(cur)
  })
}

const SID = '22222222-2222-4222-8222-222222222222'

/** track + bind a session whose jsonl already holds `lines`, and wait until the
 *  catch-up parse completed (title derived from the genuine first prompt). */
async function bindCaughtUp(
  tracker: InstanceType<typeof SessionTracker>,
  tabId: string,
  cwd: string,
  lines: unknown[]
): Promise<string> {
  tracker.track(tabId, cwd)
  const file = writeJsonl(cwd, SID, lines)
  tracker.bindSession(tabId, file, SID, cwd)
  await waitFor(tracker, (s) => s.tabId === tabId && s.title === 'do some work')
  return file
}

describe('run-state vs background work', () => {
  it('a live background spawn holds working through a turn-end (no waiting edge)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB1', cwd, initialLines(cwd))
    tracker.setStatus('tabB1', 'working') // UserPromptSubmit

    const edges: Array<{ prev?: SessionStatus; next: SessionStatus }> = []
    tracker.on('status', (e: { prev?: SessionStatus; next: SessionStatus }) => edges.push(e))

    appendJsonl(file, [spawnRec('toolu_bg1', cwd)])
    await tracker.reportTurnEnd('tabB1') // Stop — parses the spawn ack first

    expect(status(tracker, 'tabB1')).toBe('working')
    expect(edges.find((e) => e.next === 'waiting')).toBeUndefined() // no false turn-done edge
  })

  it('a delivered task-notification drains the ledger; the next turn-end waits', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB2', cwd, initialLines(cwd))
    tracker.setStatus('tabB2', 'working')

    appendJsonl(file, [spawnRec('toolu_bg2', cwd)])
    await tracker.reportTurnEnd('tabB2')
    expect(status(tracker, 'tabB2')).toBe('working')

    // the delivered notification is a MAIN-transcript record, so it both drains
    // the ledger and advances lastMainActivityTs past the spawn ack — the very
    // next turn-end must rest immediately, with no quiescence tail
    appendJsonl(file, [notifRec('toolu_bg2', cwd)])
    await tracker.reportTurnEnd('tabB2') // the post-notification turn's Stop
    expect(status(tracker, 'tabB2')).toBe('waiting')
  })

  it('failed / killed notifications are terminal too (dead tasks cannot pin working)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB3', cwd, initialLines(cwd))
    tracker.setStatus('tabB3', 'working')

    appendJsonl(file, [spawnRec('toolu_k1', cwd), spawnRec('toolu_k2', cwd, 'teammate_spawned')])
    await tracker.reportTurnEnd('tabB3')
    expect(status(tracker, 'tabB3')).toBe('working')

    appendJsonl(file, [notifRec('toolu_k1', cwd, 'killed'), notifRec('toolu_k2', cwd, 'failed')])
    await tracker.reportTurnEnd('tabB3')
    expect(status(tracker, 'tabB3')).toBe('waiting')
  })

  it('a silent ledger holds past the recency window, then self-releases at the silence cap', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB4', cwd, initialLines(cwd))
    tracker.setStatus('tabB4', 'working')

    appendJsonl(file, [spawnRec('toolu_slow', cwd)])
    await sleep(HOLD_MS + 200) // recency alone has expired…
    await tracker.reportTurnEnd('tabB4')
    // …but the undrained ledger says the agent is mid-flight (e.g. a long quiet
    // tool call) — must still hold working
    expect(status(tracker, 'tabB4')).toBe('working')

    // no notification ever arrives (drifted ledger): the silence backstop must
    // release the deferred turn-end instead of pinning working forever. The
    // release lands on a subagent poll cycle.
    await waitFor(tracker, (s) => s.tabId === 'tabB4' && s.status === 'waiting', 8000)
  }, 12_000)

  it('fresh subagent growth promotes a resting dot (Koloft bound mid-run, ledger empty)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    // history already contains the spawn ack — a resumed/forked transcript. It must
    // NOT enter the ledger (its process died with the previous claude)…
    await bindCaughtUp(tracker, 'tabB5', cwd, [...initialLines(cwd), spawnRec('toolu_old', cwd)])
    expect(status(tracker, 'tabB5')).toBe('waiting') // seeded by bindSession

    // …but records a live agent writes NOW (past the stop-settle margin) are
    // unambiguous work — the dot must recover to working on a poll cycle.
    await sleep(RESUME_MS + 300) // stop-settle margin vs statusSince
    writeSubagentJsonl(cwd, SID, 'agent-live.jsonl', [subagentRec(Date.now())])
    await waitFor(tracker, (s) => s.tabId === 'tabB5' && s.status === 'working', 8000)

    // the promotion is background-held, not a real turn: if the agent then dies
    // silently (no notification, no Stop ever), quiescence must demote the dot
    // back to waiting instead of pinning 'working' forever
    await waitFor(tracker, (s) => s.tabId === 'tabB5' && s.status === 'waiting', 8000)
  }, 20_000)

  it('stale subagent content never promotes (record time, not fold time)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    // a finished agent's transcript from a minute ago is history, not activity
    writeSubagentJsonl(cwd, SID, 'agent-done.jsonl', [subagentRec(Date.now() - 60_000)])
    await bindCaughtUp(tracker, 'tabB6', cwd, initialLines(cwd))
    expect(status(tracker, 'tabB6')).toBe('waiting')

    await sleep(SCAN_MS * 4 + 200) // > one subagent scan cycle: the old file gets folded
    expect(status(tracker, 'tabB6')).toBe('waiting')
  })

  it('a plain turn with no background goes waiting immediately', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabB7', cwd, initialLines(cwd))
    tracker.setStatus('tabB7', 'working')
    await tracker.reportTurnEnd('tabB7')
    expect(status(tracker, 'tabB7')).toBe('waiting')
  })

  it('approval is never overridden by background growth', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabB8', cwd, initialLines(cwd))
    tracker.setStatus('tabB8', 'approval')

    await sleep(RESUME_MS + 300)
    writeSubagentJsonl(cwd, SID, 'agent-live.jsonl', [subagentRec(Date.now())])
    await sleep(SCAN_MS * 4 + 200) // > one scan cycle — growth was folded
    expect(status(tracker, 'tabB8')).toBe('approval')
  })

  it('a new genuine prompt supersedes a deferred turn-end (no mid-turn waiting)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB9', cwd, initialLines(cwd))
    tracker.setStatus('tabB9', 'working')

    appendJsonl(file, [spawnRec('toolu_sup', cwd)])
    await tracker.reportTurnEnd('tabB9') // deferred: waiting pends on the background
    expect(status(tracker, 'tabB9')).toBe('working')

    // the user starts a NEW turn; the pending turn-end is obsolete. Even once the
    // background goes silent past every window, the dot must NOT drop to waiting
    // mid-turn — only the new turn's own Stop may end it.
    appendJsonl(file, [
      { type: 'user', message: { role: 'user', content: 'and another thing' }, cwd }
    ])
    await sleep(SILENCE_MS + SCAN_MS * 4) // past the silence cap + a full poll cycle
    expect(status(tracker, 'tabB9')).toBe('working')
  }, 10_000)

  it('a turn that ran a FOREGROUND subagent rests immediately at turn-end', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB10', cwd, initialLines(cwd))
    tracker.setStatus('tabB10', 'working')

    // a sync Task subagent wrote moments ago — but its completion put a wrap-up
    // record in the MAIN transcript afterwards. That ordering means "foreground
    // finished", so the recency channel must NOT hold the turn-done for 10s.
    writeSubagentJsonl(cwd, SID, 'agent-sync.jsonl', [subagentRec(Date.now())])
    await sleep(SCAN_MS + 100) // make the next parse's rescan due, so the sub file
    // is folded during reportTurnEnd — its write is inside the recency window, and
    // ONLY the later main-transcript record may release the hold
    appendJsonl(file, [
      {
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] },
        cwd
      }
    ])
    await tracker.reportTurnEnd('tabB10')
    expect(status(tracker, 'tabB10')).toBe('waiting')
  })

  it('a prompt racing an in-flight turn-end wins (no stale waiting applied)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabB11', cwd, initialLines(cwd))
    tracker.setStatus('tabB11', 'working')

    // Stop's async decision is still parsing when the next turn's
    // UserPromptSubmit lands — the newer transition must not be clobbered by
    // the stale 'waiting' when the decision resolves
    const turnEnd = tracker.reportTurnEnd('tabB11')
    tracker.setStatus('tabB11', 'working')
    await turnEnd
    expect(status(tracker, 'tabB11')).toBe('working')
  })

  it('a transcript truncation mid-hold still lands the deferred waiting', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB12', cwd, initialLines(cwd))
    tracker.setStatus('tabB12', 'working')

    appendJsonl(file, [spawnRec('toolu_rot', cwd)])
    await tracker.reportTurnEnd('tabB12')
    expect(status(tracker, 'tabB12')).toBe('working') // held on the ledger

    // the jsonl shrinks (rotation/rewrite): parse state resets, but the held
    // turn-end must survive the reset — otherwise the dot stays 'working' and
    // the turn-done notification is silently dropped forever
    fs.writeFileSync(file, JSON.stringify(initialLines(cwd)[0]) + '\n')
    await waitFor(tracker, (s) => s.tabId === 'tabB12' && s.status === 'waiting', 8000)
  }, 12_000)

  it('a live spawn ack inside the catch-up batch still enters the ledger', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    tracker.track('tabB13', cwd)
    const file = writeJsonl(cwd, SID, initialLines(cwd))
    tracker.bindSession('tabB13', file, SID, cwd)
    // appended synchronously after bind, before the initial catch-up parse can
    // read: the ack lands INSIDE the catch-up batch yet is stamped after bindMs
    // — a spawn racing the bind must still count as live, else only the 10s
    // recency channel guards the task. (Historical acks are covered by tabB5;
    // future-skewed stamps are rejected — see the ts <= now cap.)
    appendJsonl(file, [spawnRec('toolu_race', cwd)])
    await waitFor(tracker, (s) => s.tabId === 'tabB13' && s.title === 'do some work')
    tracker.setStatus('tabB13', 'working')
    await tracker.reportTurnEnd('tabB13')
    expect(status(tracker, 'tabB13')).toBe('working') // ledger-held
  })

  it('a Stop right after a granted approval still lands waiting (recovery must not eat it)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB14', cwd, initialLines(cwd))
    tracker.setStatus('tabB14', 'approval')

    // the user grants; claude writes the turn's trailing output and fires Stop
    // in the same watch window. The awaited parse's approval→working recovery is
    // an internal transition — it must NOT stale the Stop, which has to land
    // 'waiting' (and its turn-done) rather than leave the dot lying 'working'.
    appendJsonl(file, [
      {
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'granted; done' }] },
        cwd
      }
    ])
    await tracker.reportTurnEnd('tabB14')
    expect(status(tracker, 'tabB14')).toBe('waiting')
  })

  it("the ending turn's own late-folded prompt record must NOT eat its Stop", async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB15', cwd, initialLines(cwd))
    tracker.setStatus('tabB15', 'working')

    // A short turn: its OWN prompt + output records are still unfolded when the
    // Stop arrives (everything fits in one watch tick), so the turn-end's parse
    // consumes them mid-decision. That is not newer-turn evidence — the Stop
    // must still land 'waiting' (and its turn-done), not be discarded.
    appendJsonl(file, [
      {
        type: 'user',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'the very turn this Stop ends' },
        cwd
      },
      {
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        cwd
      }
    ])
    await tracker.reportTurnEnd('tabB15')
    expect(status(tracker, 'tabB15')).toBe('waiting')
  })

  it('an idle nudge while resting cannot block the background promotion', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabB16', cwd, initialLines(cwd))
    expect(status(tracker, 'tabB16')).toBe('waiting') // resting, background about to write

    await sleep(RESUME_MS + 200)
    writeSubagentJsonl(cwd, SID, 'agent-live.jsonl', [subagentRec(Date.now())])
    // the TUI's idle nudge routes into reportTurnEnd while the dot rests: it may
    // defer (background is busy), but the deferred flag must not block the
    // waiting→working promotion for the rest of the background phase
    await tracker.reportTurnEnd('tabB16')
    await waitFor(tracker, (s) => s.tabId === 'tabB16' && s.status === 'working', 8000)
  }, 12_000)

  it('a truncation mid-hold re-ledgers live spawn acks (no degraded 10s hold)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB17', cwd, initialLines(cwd))
    tracker.setStatus('tabB17', 'working')

    const ack = spawnRec('toolu_keep', cwd)
    const padding = {
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2000) }] },
      cwd
    }
    appendJsonl(file, [ack, padding])
    await tracker.reportTurnEnd('tabB17')
    expect(status(tracker, 'tabB17')).toBe('working') // ledger-held

    // the file is rewritten SHORTER but still contains the live ack: the reset
    // must preserve bindMs so the re-read re-ledgers it — degrading to the 10s
    // recency channel would land a premature waiting on the next quiet spell
    fs.writeFileSync(
      file,
      [...initialLines(cwd), ack].map((l) => JSON.stringify(l)).join('\n') + '\n'
    )
    await sleep(1500) // truncation detected (500ms watch tick) + reconcile cycles
    expect(status(tracker, 'tabB17')).toBe('working') // still ledger-held

    appendJsonl(file, [notifRec('toolu_keep', cwd)])
    await tracker.reportTurnEnd('tabB17')
    expect(status(tracker, 'tabB17')).toBe('waiting')
  }, 12_000)

  /*
   * One case per FORM of background work Claude Code can leave running past a
   * turn-end. Ack shapes verified against real transcripts and the CLI's own
   * result schemas (claude 2.1.222):
   *   background subagent  Agent run_in_background   status async_launched
   *   teammate             Agent name/team_name      status teammate_spawned
   *   workflow             Workflow                  status async_launched
   *                                                  (+ taskType local_workflow)
   *   cloud agent          Agent isolation:'remote'  status remote_launched
   *   background shell     Bash run_in_background    backgroundTaskId
   *   monitor              Monitor                   taskId + timeoutMs
   *   forked skill         Skill (background)        status forked + background
   * EVERY form holds 'working' — any live background task means the session is
   * working (product decision); each delivers a terminal
   * <task-notification> that retires it from the ledger.
   */
  it('a cloud agent (remote_launched) holds working — it has no local transcript', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabR1', cwd, initialLines(cwd))
    tracker.setStatus('tabR1', 'working')

    // a remote agent runs on CC's infrastructure: nothing under subagents/ ever
    // grows, so the LEDGER is the only channel holding this session working
    appendJsonl(file, [
      spawnRec('toolu_remote', cwd, 'remote_launched', { taskType: 'remote_agent' })
    ])
    await tracker.reportTurnEnd('tabR1')
    expect(status(tracker, 'tabR1')).toBe('working')

    appendJsonl(file, [attachNotifRec('toolu_remote', cwd)])
    await tracker.reportTurnEnd('tabR1')
    expect(status(tracker, 'tabR1')).toBe('waiting')
  })

  it('a Workflow run holds working, and its nested agent transcripts keep it fresh', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabW1', cwd, initialLines(cwd))
    tracker.setStatus('tabW1', 'working')

    appendJsonl(file, [
      spawnRec('toolu_wf', cwd, 'async_launched', {
        taskType: 'local_workflow',
        runId: 'wf_abc123',
        workflowName: 'review-changes'
      })
    ])
    await tracker.reportTurnEnd('tabW1')
    expect(status(tracker, 'tabW1')).toBe('working')

    // a workflow's agents write to subagents/workflows/<runId>/, one level
    // deeper than a plain subagent — the recency channel must see them, else a
    // workflow outliving the ledger's silence cap would rest mid-run
    await sleep(HOLD_MS + 100)
    writeSubagentJsonl(cwd, SID, 'agent-1.jsonl', [subagentRec(Date.now())], 'workflows/wf_abc123')
    await sleep(SCAN_MS * 3)
    await tracker.reportTurnEnd('tabW1')
    expect(status(tracker, 'tabW1')).toBe('working')
  }, 10_000)

  it('a workflow agent deep under subagents/ promotes a resting dot', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabW2', cwd, initialLines(cwd))
    expect(status(tracker, 'tabW2')).toBe('waiting')

    // Koloft bound mid-workflow (restart / new tab on a live session): no ack to
    // ledger, so only the nested transcript's growth can recover the dot
    await sleep(RESUME_MS + 300)
    writeSubagentJsonl(cwd, SID, 'agent-7.jsonl', [subagentRec(Date.now())], 'workflows/wf_deep')
    await waitFor(tracker, (s) => s.tabId === 'tabW2' && s.status === 'working', 8000)
  }, 12_000)

  it('a shell the model is BLOCKED on holds working (auto-backgrounded at its timeout)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabS1', cwd, initialLines(cwd))
    tracker.setStatus('tabS1', 'working')

    // the model ran a long build synchronously; it hit the tool timeout and was
    // moved to the background. The model is parked until the notification, so
    // the turn is NOT over.
    appendJsonl(file, [shellAckRec('toolu_build', cwd, { timedOutAfterMs: 120_000 })])
    await tracker.reportTurnEnd('tabS1')
    expect(status(tracker, 'tabS1')).toBe('working')

    appendJsonl(file, [queueNotifRec('toolu_build')])
    await tracker.reportTurnEnd('tabS1')
    expect(status(tracker, 'tabS1')).toBe('waiting')
  })

  it('a shell the USER parked with Ctrl+B holds working too', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabS2', cwd, initialLines(cwd))
    tracker.setStatus('tabS2', 'working')

    appendJsonl(file, [shellAckRec('toolu_ctrlb', cwd, { backgroundedByUser: true })])
    await tracker.reportTurnEnd('tabS2')
    expect(status(tracker, 'tabS2')).toBe('working')
  })

  it('a plain run_in_background shell holds working until its exit notification', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabS3', cwd, initialLines(cwd))
    tracker.setStatus('tabS3', 'working')

    // any live background task means the session is working — a plain
    // run_in_background shell included: its exit re-invokes the model via a
    // terminal <task-notification>, which is also what retires the hold
    appendJsonl(file, [shellAckRec('toolu_devserver', cwd)])
    await tracker.reportTurnEnd('tabS3')
    expect(status(tracker, 'tabS3')).toBe('working')

    appendJsonl(file, [queueNotifRec('toolu_devserver')])
    await tracker.reportTurnEnd('tabS3')
    expect(status(tracker, 'tabS3')).toBe('waiting')
  })

  it('a Monitor task holds working until its notification', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabS4', cwd, initialLines(cwd))
    tracker.setStatus('tabS4', 'working')

    appendJsonl(file, [monitorAckRec('toolu_mon', cwd)])
    await tracker.reportTurnEnd('tabS4')
    expect(status(tracker, 'tabS4')).toBe('working')

    appendJsonl(file, [attachNotifRec('toolu_mon', cwd)])
    await tracker.reportTurnEnd('tabS4')
    expect(status(tracker, 'tabS4')).toBe('waiting')
  })

  it('a skill forked into the background holds working — its own wrap-up must not rest the dot', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabF1', cwd, initialLines(cwd))
    tracker.setStatus('tabF1', 'working')

    const edges: Array<{ prev?: SessionStatus; next: SessionStatus }> = []
    tracker.on('status', (e: { prev?: SessionStatus; next: SessionStatus }) => edges.push(e))

    // Real shape of `/code-review` launched in the background: the forked agent
    // starts writing its transcript at once, and the main loop then writes ONE
    // wrap-up line ("kicked it off") before its Stop. That ordering is why the
    // ledger has to carry this: with lastMain newer than lastBg, the recency
    // channel — which exists to let a FOREGROUND subagent's trailing writes rest
    // immediately — correctly votes "not background", and the ack is the only
    // remaining evidence that a task is running.
    writeSubagentJsonl(cwd, SID, 'agent-forked.jsonl', [subagentRec(Date.now() - 1000)])
    appendJsonl(file, [forkedSkillRec('toolu_fork', cwd), mainAssistantRec(cwd)])
    await tracker.reportTurnEnd('tabF1')

    expect(status(tracker, 'tabF1')).toBe('working')
    expect(edges.find((e) => e.next === 'waiting')).toBeUndefined() // no false turn-done edge
  })

  it('a forked skill retires on its terminal task-notification', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabF2', cwd, initialLines(cwd))
    tracker.setStatus('tabF2', 'working')

    appendJsonl(file, [forkedSkillRec('toolu_fork2', cwd)])
    await tracker.reportTurnEnd('tabF2')
    expect(status(tracker, 'tabF2')).toBe('working')

    // unlike a teammate, a forked skill DOES report back through the notification
    // channel (verified on real transcripts), naming its spawning tool-use-id
    appendJsonl(file, [notifRec('toolu_fork2', cwd)])
    await tracker.reportTurnEnd('tabF2')
    expect(status(tracker, 'tabF2')).toBe('waiting')
  })

  it('a fork with no background flag never enters the ledger (its result is already final)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabF3', cwd, initialLines(cwd))
    tracker.setStatus('tabF3', 'working')

    // a skill that runs in a subagent and returns the finished result has nothing
    // left running — and no notification will ever come for it, so ledgering it
    // would pin the dot until the silence cap on a turn that is genuinely over.
    // Its real shape omits `background` (verified, claude 2.1.220), so the
    // predicate must key on the flag being present and true — a `!== false`
    // reading of the same field would ledger exactly this record.
    appendJsonl(file, [forkedSkillRec('toolu_sync_fork', cwd, false)])
    await tracker.reportTurnEnd('tabF3')
    expect(status(tracker, 'tabF3')).toBe('waiting')
  })

  it("a background shell stopped via the UI retires on its 'stopped' notification", async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabS5', cwd, initialLines(cwd))
    tracker.setStatus('tabS5', 'working')

    appendJsonl(file, [shellAckRec('toolu_stopme', cwd)])
    await tracker.reportTurnEnd('tabS5')
    expect(status(tracker, 'tabS5')).toBe('working')

    // real transcripts deliver <status>stopped</status> for a task killed via
    // the UI / Monitor timeout / agent teardown — terminal, must retire
    appendJsonl(file, [queueNotifRec('toolu_stopme', 'enqueue', 'stopped')])
    await tracker.reportTurnEnd('tabS5')
    expect(status(tracker, 'tabS5')).toBe('waiting')
  })

  it('every delivered-notification shape retires the ledger (attachment / queue-op / legacy)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabN1', cwd, initialLines(cwd))
    tracker.setStatus('tabN1', 'working')

    // Current Claude Code delivers a task-notification as an `attachment`
    // record (and queues it as a `queue-operation`) — NOT as the pre-2.1.18x
    // user record with origin.kind. Reading only the legacy shape leaves every
    // ledger entry undrained until the 10-minute silence backstop, which both
    // lies on the dot and delays the turn-done notification by that long.
    for (const [id, notif] of [
      ['toolu_n_attach', attachNotifRec('toolu_n_attach', cwd)],
      ['toolu_n_queue', queueNotifRec('toolu_n_queue')],
      ['toolu_n_legacy', notifRec('toolu_n_legacy', cwd)]
    ] as Array<[string, unknown]>) {
      appendJsonl(file, [spawnRec(id, cwd)])
      await tracker.reportTurnEnd('tabN1')
      expect(status(tracker, 'tabN1')).toBe('working')

      appendJsonl(file, [notif])
      await tracker.reportTurnEnd('tabN1')
      expect(status(tracker, 'tabN1')).toBe('waiting')
      tracker.setStatus('tabN1', 'working') // next round's turn
    }
  }, 15_000)

  it('a NON-terminal task-notification does not retire a live task', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabN2', cwd, initialLines(cwd))
    tracker.setStatus('tabN2', 'working')

    appendJsonl(file, [spawnRec('toolu_prog', cwd)])
    await tracker.reportTurnEnd('tabN2')
    expect(status(tracker, 'tabN2')).toBe('working')

    // a long-lived task reports progress under the same tool-use-id; it is
    // still running, so the hold must survive
    appendJsonl(file, [attachNotifRec('toolu_prog', cwd, 'running')])
    await tracker.reportTurnEnd('tabN2')
    expect(status(tracker, 'tabN2')).toBe('working')
  })

  it('a notification quoted inside ordinary tool output cannot retire a task', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabN3', cwd, initialLines(cwd))
    tracker.setStatus('tabN3', 'working')

    appendJsonl(file, [spawnRec('toolu_quoted', cwd)])
    await tracker.reportTurnEnd('tabN3')
    expect(status(tracker, 'tabN3')).toBe('working')

    // a session grepping its own transcript echoes the notification text back
    // as a plain Bash tool_result — matching on text alone would rest the dot
    // while the agent is still running
    appendJsonl(file, [
      {
        type: 'user',
        timestamp: new Date().toISOString(),
        toolUseResult: { stdout: notifText('toolu_quoted', 'completed'), stderr: '' },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_grep',
              content: notifText('toolu_quoted', 'completed')
            }
          ]
        },
        cwd
      }
    ])
    await tracker.reportTurnEnd('tabN3')
    expect(status(tracker, 'tabN3')).toBe('working')
  })

  it('the wrap-up turn after a drain raises exactly one turn-done', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabD1', cwd, initialLines(cwd))
    tracker.setStatus('tabD1', 'working')

    const edges: Array<{ prev?: SessionStatus; next: SessionStatus }> = []
    tracker.on('status', (e: { prev?: SessionStatus; next: SessionStatus }) => edges.push(e))

    appendJsonl(file, [spawnRec('toolu_wrap', cwd)])
    await tracker.reportTurnEnd('tabD1')
    expect(status(tracker, 'tabD1')).toBe('working')

    // The terminal notification RE-INVOKES the model: a wrap-up turn follows
    // and ends with its own Stop. Resting the moment the ledger empties would
    // fire a turn-done mid-wrap-up, then flap back to working and fire a
    // second one when the real Stop lands.
    appendJsonl(file, [attachNotifRec('toolu_wrap', cwd)])
    const until = Date.now() + HOLD_MS * 2
    while (Date.now() < until) {
      appendJsonl(file, [mainAssistantRec(cwd)])
      await sleep(Math.max(20, Math.floor(HOLD_MS / 4)))
    }
    expect(status(tracker, 'tabD1')).toBe('working')

    await tracker.reportTurnEnd('tabD1')
    expect(status(tracker, 'tabD1')).toBe('waiting')
    expect(edges.filter((e) => e.next === 'waiting')).toHaveLength(1)
  }, 10_000)

  it('interleaved sidechain records read as background, not main-loop, activity', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabX1', cwd, initialLines(cwd))
    tracker.setStatus('tabX1', 'working')

    // Some CC versions interleave a subagent's turns into the MAIN jsonl as
    // isSidechain records instead of a separate subagents/ file. Counting
    // those as main-loop activity defeats the recency channel's whole test
    // (last background write NEWER than the last main-loop write), so a live
    // agent would look like a finished foreground one and rest the dot.
    const now = Date.now()
    appendJsonl(file, [
      mainAssistantRec(cwd, now - 200),
      mainAssistantRec(cwd, now, true) // the background agent, still writing
    ])
    await tracker.reportTurnEnd('tabX1')
    expect(status(tracker, 'tabX1')).toBe('working')
  })

  it('a turn-end racing the watch-tick parse of its own spawn ack still holds', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB18', cwd, initialLines(cwd))
    tracker.setStatus('tabB18', 'working')

    // first turn-end starts a parse; the ack lands while it is in flight; the
    // second turn-end must await the COALESCED run (parseAgain re-read included)
    // — an instant no-op resolve would decide on stale state and apply a false
    // waiting. Pins the parsePromise semantic against regression.
    const first = tracker.reportTurnEnd('tabB18')
    appendJsonl(file, [spawnRec('toolu_coal', cwd)])
    const second = tracker.reportTurnEnd('tabB18')
    await Promise.all([first, second])
    expect(status(tracker, 'tabB18')).toBe('working')
  })
})

/*
 * Esc interrupts. Claude Code fires NO Stop hook for an interrupted turn — the
 * only evidence the turn ended is the transcript's interrupt record. Reading
 * that record as a genuine user prompt (its text looks like one) is doubly
 * wrong: it pins 'working' forever (no Stop will ever come), and from
 * 'approval' it actively PROMOTES the dot to working via the stale-recovery
 * path. The record is turn-end evidence, gated on background work exactly like
 * a Stop.
 */
/*
 * Claude Code's own answer, read instead of reconstructed.
 *
 * The Stop hook's payload enumerates what is STILL RUNNING at the exact moment
 * the turn ends (`background_tasks`, verified on real claude 2.1.228: covers
 * background subagents, teammates, shells, Monitors, and tasks nested one agent
 * deep). When the hook reports that list, it is AUTHORITATIVE — it comes from
 * the process that owns the tasks, so it outranks every ack/notification the
 * tracker infers from the transcript. The inferred ledger stays only as the
 * fallback for a claude too old to send the field.
 */
describe('run-state from the turn-end payload', () => {
  it('a reported live task holds working with NO ack in the transcript at all', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabP1', cwd, initialLines(cwd))
    tracker.setStatus('tabP1', 'working')

    const edges: Array<{ prev?: SessionStatus; next: SessionStatus }> = []
    tracker.on('status', (e: { prev?: SessionStatus; next: SessionStatus }) => edges.push(e))

    // no spawn ack was parsed — this is exactly the case an unknown ack shape
    // produces, and the payload alone must carry it
    await tracker.reportTurnEnd('tabP1', [
      { id: 'a1', type: 'subagent' },
      { id: 'a2', type: 'subagent' }
    ])
    expect(status(tracker, 'tabP1')).toBe('working')
    expect(edges.find((e) => e.next === 'waiting')).toBeUndefined()
  })

  it('a reported empty list rests the dot even while the inferred ledger still holds', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabP2', cwd, initialLines(cwd))
    tracker.setStatus('tabP2', 'working')

    // a teammate's ack: the ledger will hold this forever (a teammate is never
    // named by a task-notification), and only the payload can retire it
    appendJsonl(file, [spawnRec('toolu_mate', cwd, 'teammate_spawned')])
    await tracker.reportTurnEnd('tabP2', [])
    expect(status(tracker, 'tabP2')).toBe('waiting')
  })

  it('no reported list falls back to the inferred ledger', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabP3', cwd, initialLines(cwd))
    tracker.setStatus('tabP3', 'working')

    appendJsonl(file, [spawnRec('toolu_old', cwd)])
    await tracker.reportTurnEnd('tabP3') // an older claude sends no list
    expect(status(tracker, 'tabP3')).toBe('working')
  })

  it('an empty ledger cannot release a payload-held turn-end early', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabP5', cwd, initialLines(cwd))
    tracker.setStatus('tabP5', 'working')

    // Held by the payload with nothing in the ledger — the ledger-driven release
    // path must not read that emptiness as "the background drained". Nothing is
    // appended here on purpose: the subagent poll already runs a parse (and thus
    // the release check) every scan interval, so a wrongly-released dot shows up
    // as 'waiting' without any transcript growth to promote it back.
    await tracker.reportTurnEnd('tabP5', [{ id: 'a1', type: 'subagent' }])
    await sleep(HOLD_MS + SCAN_MS + 150) // past the ledger's release window…
    expect(status(tracker, 'tabP5')).toBe('working') // …but well inside the silence cap
  }, 12_000)

  it('a reported hold still self-releases at the silence cap (tasks died silently)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabP6', cwd, initialLines(cwd))
    tracker.setStatus('tabP6', 'working')

    // the drift backstop: a reported task that dies without ever re-invoking the
    // model produces no later turn-end, so nothing would ever land 'waiting'
    await tracker.reportTurnEnd('tabP6', [{ id: 'a1', type: 'subagent' }])
    await waitFor(tracker, (s) => s.tabId === 'tabP6' && s.status === 'waiting', 8000)
  }, 12_000)
})

describe('Esc interrupt as turn-end', () => {
  it('an interrupt mid-turn lands waiting (no Stop hook ever fires)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabI1', cwd, initialLines(cwd))
    tracker.setStatus('tabI1', 'working')

    appendJsonl(file, [interruptRec(cwd)])
    await waitFor(tracker, (s) => s.tabId === 'tabI1' && s.status === 'waiting', 8000)
  }, 12_000)

  it('an interrupt at a permission prompt lands waiting, never working', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabI2', cwd, initialLines(cwd))
    tracker.setStatus('tabI2', 'approval')

    const edges: Array<{ prev?: SessionStatus; next: SessionStatus }> = []
    tracker.on('status', (e: { prev?: SessionStatus; next: SessionStatus }) => edges.push(e))

    // Esc rejects the pending tool: the "for tool use" variant. Misreading it
    // as a prompt would flip approval → working — and stick there forever.
    appendJsonl(file, [interruptRec(cwd, Date.now(), true)])
    await waitFor(tracker, (s) => s.tabId === 'tabI2' && s.status === 'waiting', 8000)
    expect(edges.some((e) => e.next === 'working')).toBe(false)
  }, 12_000)

  it('an interrupt with live background tasks holds working until the drain', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabI3', cwd, initialLines(cwd))
    tracker.setStatus('tabI3', 'working')

    // Esc aborts the MAIN loop only — background tasks keep running, so the
    // session is still working (any live background task ⇒ working)
    appendJsonl(file, [spawnRec('toolu_esc_bg', cwd), interruptRec(cwd)])
    await sleep(SCAN_MS * 4 + 200) // several parse cycles fold both records
    expect(status(tracker, 'tabI3')).toBe('working')

    // the task's terminal notification drains the ledger; the deferred
    // turn-end must then land without any further hook event
    appendJsonl(file, [attachNotifRec('toolu_esc_bg', cwd)])
    await waitFor(tracker, (s) => s.tabId === 'tabI3' && s.status === 'waiting', 8000)
  }, 12_000)

  it('an interrupt followed by a queued prompt in the same batch stays working', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabI4', cwd, initialLines(cwd))
    tracker.setStatus('tabI4', 'working')

    const edges: Array<{ prev?: SessionStatus; next: SessionStatus }> = []
    tracker.on('status', (e: { prev?: SessionStatus; next: SessionStatus }) => edges.push(e))

    // Esc + an immediately typed new prompt can fold in ONE watch tick: the
    // later prompt supersedes the interrupt — no waiting flap, no false
    // turn-done edge
    appendJsonl(file, [
      interruptRec(cwd),
      {
        type: 'user',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'try again' },
        cwd
      }
    ])
    await sleep(SCAN_MS * 4 + 200)
    expect(status(tracker, 'tabI4')).toBe('working')
    expect(edges.some((e) => e.next === 'waiting')).toBe(false)
  }, 10_000)

  it('a hook transition newer than the interrupt record outranks it', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabI5', cwd, initialLines(cwd))

    // the interrupt was written moments ago; the NEXT turn's UserPromptSubmit
    // hook has already set 'working' by the time the record folds (hook beats
    // the 500ms watch tick). The stale interrupt must not demote the new turn.
    appendJsonl(file, [interruptRec(cwd, Date.now() - 100)])
    tracker.setStatus('tabI5', 'working')
    await sleep(SCAN_MS * 4 + 200)
    expect(status(tracker, 'tabI5')).toBe('working')
  }, 10_000)

  it('a historical interrupt in the catch-up replay drives nothing', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    // a transcript whose LAST record is an old interrupt (the user Esc'd, then
    // closed the tab; now resumes): replay must not fire a phantom turn-end —
    // the seeded waiting stands, and no extra waiting edge is emitted
    const tracker2 = tracker
    const old = interruptRec(cwd, Date.now() - 60_000)
    await bindCaughtUp(tracker2, 'tabI6', cwd, [...initialLines(cwd), old])
    expect(status(tracker2, 'tabI6')).toBe('waiting')

    tracker2.setStatus('tabI6', 'working') // the resumed session's next turn
    await sleep(SCAN_MS * 3 + 200)
    expect(status(tracker2, 'tabI6')).toBe('working')
  }, 10_000)
})

/*
 * Run-state from Claude Code's TYPED task list (hooks.ts `bgl`, claude >=
 * 2.1.228 sends it at every turn-end). Requirement: "in flight" to Claude Code
 * is not "working" to the user — a Monitor waits, a dev server just runs, an
 * idle teammate is still reported 'running' — so each task is judged by what
 * it is, and what is parked shows as a badge (SessionInfo.parked) instead of
 * pinning the dot. The OS view of the tool shells (taskProcs) is staged.
 */
type StagedShell = { ageMs?: number; listening?: boolean }

/** Stage what the OS would show under this tab's claude: which task output files
 *  are still held by a tool shell (and how old / listening they are). */
function stageProcs(
  tracker: InstanceType<typeof SessionTracker>,
  shells: Record<string, StagedShell>
): void {
  tracker.pidOf = () => 4242
  tracker.inspect = async () => ({
    shells: new Map(
      Object.entries(shells).map(([id, s]) => [
        id,
        { pid: 1, ageMs: s.ageMs ?? 0, listening: !!s.listening }
      ])
    )
  })
}

/** the assistant record calling Bash / Monitor — the command the parked badge shows */
function commandUseRec(toolUseId: string, cwd: string, command: string, name = 'Bash'): unknown {
  return {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name, input: { command } }]
    },
    cwd
  }
}

/** a teammate's transcript + the sibling meta file that says it is one */
function writeTeammateJsonl(
  cwd: string,
  sessionId: string,
  agentId: string,
  lines: unknown[]
): string {
  const dir = path.join(projectsRoot, encodeCwd(cwd), sessionId, 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: 'worker', name: agentId, taskKind: 'in_process_teammate' })
  )
  const file = path.join(dir, `agent-${agentId}.jsonl`)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

function parked(tracker: InstanceType<typeof SessionTracker>, tabId: string): unknown {
  return tracker.list().find((s) => s.tabId === tabId)?.parked
}

describe('run-state from the typed task list', () => {
  it('parses the hook list; an empty string is an empty list, no string is no list', async () => {
    const { parseReportedTasks } = await import('../../src/main/sessionTracker')
    expect(parseReportedTasks('b0167powo:shell,t6fdjbjat:teammate')).toEqual([
      { id: 'b0167powo', type: 'shell' },
      { id: 't6fdjbjat', type: 'teammate' }
    ])
    expect(parseReportedTasks('')).toEqual([])
    expect(parseReportedTasks(undefined)).toBeUndefined()
    expect(parseReportedTasks(3)).toBeUndefined()
  })

  it('a reported Monitor is parked, not work: the turn-end lands waiting', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabL1', cwd, initialLines(cwd))
    tracker.setStatus('tabL1', 'working')
    // the report calls a Monitor a plain 'shell'; only its ack in the transcript
    // ({taskId, timeoutMs}) says what it is — and the Monitor call's command is
    // what the badge shows
    appendJsonl(file, [
      commandUseRec('toolu_mon', cwd, 'tail -f /tmp/bot.log', 'Monitor'),
      monitorAckRec('toolu_mon', cwd)
    ])
    await tracker.reportTurnEnd('tabL1', [{ id: 'mtoolu_mon', type: 'shell' }])
    expect(status(tracker, 'tabL1')).toBe('waiting')
    expect(parked(tracker, 'tabL1')).toEqual([{ kind: 'monitor', label: 'tail -f /tmp/bot.log' }])
  })

  it('a reported shell holds working while a tool shell holds its output file, and rests once it is gone', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabL2', cwd, initialLines(cwd))
    tracker.setStatus('tabL2', 'working')
    appendJsonl(file, [commandUseRec('toolu_sh', cwd, 'npm test'), shellAckRec('toolu_sh', cwd)])
    stageProcs(tracker, { btoolu_sh: { ageMs: 0 } })
    await tracker.reportTurnEnd('tabL2', [{ id: 'btoolu_sh', type: 'shell' }])
    expect(status(tracker, 'tabL2')).toBe('working')
    expect(parked(tracker, 'tabL2')).toBeUndefined()
    // the process exits: nothing holds the output file any more. No Stop, no
    // notification needed — the next OS view says so, and the hold lands
    stageProcs(tracker, {})
    await waitFor(tracker, (s) => s.tabId === 'tabL2' && s.status === 'waiting', 6000)
  }, 10_000)

  it('a reported shell that listens on a port is a server: parked, and the turn-end lands', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabL3', cwd, initialLines(cwd))
    tracker.setStatus('tabL3', 'working')
    appendJsonl(file, [
      commandUseRec('toolu_srv', cwd, 'python3 -m http.server 4179'),
      shellAckRec('toolu_srv', cwd)
    ])
    stageProcs(tracker, { btoolu_srv: { listening: true } })
    await tracker.reportTurnEnd('tabL3', [{ id: 'btoolu_srv', type: 'shell' }])
    expect(status(tracker, 'tabL3')).toBe('waiting')
    expect(parked(tracker, 'tabL3')).toEqual([
      { kind: 'server', label: 'python3 -m http.server 4179', ageMs: 0 }
    ])
  })

  it('a reported shell older than the server age is a server too, whatever it listens on', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabL4', cwd, initialLines(cwd))
    tracker.setStatus('tabL4', 'working')
    appendJsonl(file, [
      commandUseRec('toolu_old', cwd, 'bun listen.ts'),
      shellAckRec('toolu_old', cwd)
    ])
    stageProcs(tracker, { btoolu_old: { ageMs: SERVER_AGE_MS * 5 } })
    await tracker.reportTurnEnd('tabL4', [{ id: 'btoolu_old', type: 'shell' }])
    expect(status(tracker, 'tabL4')).toBe('waiting')
    expect((parked(tracker, 'tabL4') as { kind: string }[])[0].kind).toBe('server')
  })

  it('a reported shell is trusted when the OS cannot be asked (no pid wired)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabL5', cwd, initialLines(cwd))
    tracker.setStatus('tabL5', 'working')
    await tracker.reportTurnEnd('tabL5', [{ id: 'bunknown', type: 'shell' }])
    expect(status(tracker, 'tabL5')).toBe('working')
  })

  it("a remote session's reported shell is trusted: this Mac cannot see the machine", async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    // the same shape as tabL3 above, only the claude runs on another machine: its
    // tool shells are over there, so the local process table finds none of them and
    // judging by it would end every remote turn the moment a shell was reported
    tracker.track('tabL5R', cwd, {
      host: 'devbox',
      projectsRoot,
      tmuxName: 'k-' + SID
    })
    const file = writeJsonl(cwd, SID, initialLines(cwd))
    tracker.bindSession('tabL5R', file, SID, cwd)
    await waitFor(tracker, (s) => s.tabId === 'tabL5R' && s.title === 'do some work')
    stageProcs(tracker, {}) // a pid IS wired, and the OS sees nothing
    tracker.setStatus('tabL5R', 'working')
    await tracker.reportTurnEnd('tabL5R', [{ id: 'bremote', type: 'shell' }])
    expect(status(tracker, 'tabL5R')).toBe('working')
  })

  it('teammates work while a transcript of theirs grows, and are parked idle once quiet', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabL6', cwd, initialLines(cwd))
    stageProcs(tracker, {})
    // a teammate transcript growing right now (folded by the subagent poll)
    writeTeammateJsonl(cwd, SID, 'tm1', [subagentRec(Date.now())])
    await sleep(SCAN_MS + 150)
    tracker.setStatus('tabL6', 'working')
    await tracker.reportTurnEnd('tabL6', [
      { id: 'ttm1', type: 'teammate' },
      { id: 'ttm2', type: 'teammate' }
    ])
    expect(status(tracker, 'tabL6')).toBe('working')
    // …then nothing for longer than the quiet window: both are idle between
    // messages. Claude Code still reports them 'running'; the badge says idle.
    await waitFor(tracker, (s) => s.tabId === 'tabL6' && s.status === 'waiting', 6000)
    expect(parked(tracker, 'tabL6')).toEqual([{ kind: 'teammate', label: '2 idle' }])
  }, 10_000)

  it('a tool call in flight (a shell the list does not name) holds a quiet teammate as working', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabL18', cwd, initialLines(cwd))
    // a tool shell holding an output file the report does not name: some agent is
    // inside a command right now — the one liveness a long silent call leaves no
    // transcript trace of (the teammate here never writes a byte)
    stageProcs(tracker, { bfg: { ageMs: 0 } })
    tracker.setStatus('tabL18', 'working')
    await tracker.reportTurnEnd('tabL18', [{ id: 'ttm1', type: 'teammate' }])
    expect(status(tracker, 'tabL18')).toBe('working')
    await sleep(TEAMMATE_QUIET_MS + SCAN_MS + 100)
    expect(status(tracker, 'tabL18')).toBe('working') // quiet past the window, still held
    // the call returns: nothing in flight, the teammate is idle
    stageProcs(tracker, {})
    await waitFor(tracker, (s) => s.tabId === 'tabL18' && s.status === 'waiting', 6000)
    expect(parked(tracker, 'tabL18')).toEqual([{ kind: 'teammate', label: '1 idle' }])
  }, 10_000)

  it('a fresh teammate spawn counts as activity before its transcript exists', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabL7', cwd, initialLines(cwd))
    stageProcs(tracker, {})
    tracker.setStatus('tabL7', 'working')
    appendJsonl(file, [spawnRec('toolu_tm', cwd, 'teammate_spawned')])
    await tracker.reportTurnEnd('tabL7', [{ id: 'tnew', type: 'teammate' }])
    expect(status(tracker, 'tabL7')).toBe('working')
  })

  it('a subagent or a cloud session on the list holds working until the next report drops it', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabL8', cwd, initialLines(cwd))
    stageProcs(tracker, {})
    tracker.setStatus('tabL8', 'working')
    await tracker.reportTurnEnd('tabL8', [{ id: 'a1', type: 'subagent' }])
    expect(status(tracker, 'tabL8')).toBe('working')
    await tracker.reportTurnEnd('tabL8', [])
    expect(status(tracker, 'tabL8')).toBe('waiting')
    // a cloud session has nothing local to observe: held exactly like an agent
    tracker.setStatus('tabL8', 'working')
    await tracker.reportTurnEnd('tabL8', [{ id: 'c1', type: 'cloud-session' }])
    expect(status(tracker, 'tabL8')).toBe('working')
    await tracker.reportTurnEnd('tabL8', [])
    expect(status(tracker, 'tabL8')).toBe('waiting')
  })

  it('housekeeping task types (dream, auto-mode scan, MCP watchers) are neither work nor a badge', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabL9', cwd, initialLines(cwd))
    tracker.setStatus('tabL9', 'working')
    await tracker.reportTurnEnd('tabL9', [
      { id: 'd1', type: 'dream' },
      { id: 's1', type: 'auto-mode-scan' },
      { id: 'w1', type: 'monitor' }
    ])
    expect(status(tracker, 'tabL9')).toBe('waiting')
    expect(parked(tracker, 'tabL9')).toBeUndefined()
  })

  it('an idle nudge re-judges the reported list rather than the ledger (live shell, empty ledger)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabL10', cwd, initialLines(cwd))
    tracker.setStatus('tabL10', 'working')
    // spawned before the bind: the ledger never saw an ack — the nudge used to
    // read that emptiness as "nothing running" and rest the dot under a live task
    stageProcs(tracker, { bpre: { ageMs: 0 } })
    await tracker.reportTurnEnd('tabL10', [{ id: 'bpre', type: 'shell' }])
    expect(status(tracker, 'tabL10')).toBe('working')
    await tracker.reportTurnEnd('tabL10') // "Claude is waiting for your input": no payload
    expect(status(tracker, 'tabL10')).toBe('working')
  })

  it('an idle nudge cannot be held by a ledger entry the list has judged idle', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabL11', cwd, initialLines(cwd))
    stageProcs(tracker, {})
    tracker.setStatus('tabL11', 'working')
    // a teammate ack sits in the ledger forever (no notification ever names it).
    // The spawn itself counts as teammate activity from the moment it is FOLDED
    // (not appended), so wait for the fold first, then for the quiet window
    appendJsonl(file, [spawnRec('toolu_mate', cwd, 'teammate_spawned')])
    await sleep(SCAN_MS + 150)
    await sleep(TEAMMATE_QUIET_MS + 100)
    await tracker.reportTurnEnd('tabL11', [{ id: 'tmate', type: 'teammate' }])
    expect(status(tracker, 'tabL11')).toBe('waiting')
    tracker.setStatus('tabL11', 'working') // a hook transition, then the nudge
    await tracker.reportTurnEnd('tabL11')
    expect(status(tracker, 'tabL11')).toBe('waiting')
  })

  it('a terminal task-notification retires its task from the reported list', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabL12', cwd, initialLines(cwd))
    stageProcs(tracker, {})
    tracker.setStatus('tabL12', 'working')
    await tracker.reportTurnEnd('tabL12', [{ id: 't_x1', type: 'subagent' }])
    expect(status(tracker, 'tabL12')).toBe('working')
    // the notification names the task id the list is keyed by; with nothing
    // left on the list the held turn-end lands without another Stop (the
    // model was interrupted, say, so none is coming)
    appendJsonl(file, [attachNotifRec('x1', cwd)])
    await waitFor(tracker, (s) => s.tabId === 'tabL12' && s.status === 'waiting', 6000)
  }, 10_000)

  it('a spawn acked after the report joins the list, so an Esc is judged on it', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabL13', cwd, initialLines(cwd))
    stageProcs(tracker, {})
    tracker.setStatus('tabL13', 'working')
    await tracker.reportTurnEnd('tabL13', [])
    expect(status(tracker, 'tabL13')).toBe('waiting')
    tracker.setStatus('tabL13', 'working') // next prompt
    stageProcs(tracker, { btoolu_esc: { ageMs: 0 } })
    appendJsonl(file, [
      commandUseRec('toolu_esc', cwd, 'npm run build'),
      shellAckRec('toolu_esc', cwd),
      interruptRec(cwd)
    ])
    await sleep(SCAN_MS + 200)
    expect(status(tracker, 'tabL13')).toBe('working') // the interrupted turn's own shell holds
    stageProcs(tracker, {})
    await waitFor(tracker, (s) => s.tabId === 'tabL13' && s.status === 'waiting', 6000)
  }, 10_000)

  it('a session boundary (/clear, /resume) drops the previous list and its badge', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabL14', cwd, initialLines(cwd))
    tracker.setStatus('tabL14', 'working')
    stageProcs(tracker, { bsrv: { listening: true } })
    await tracker.reportTurnEnd('tabL14', [{ id: 'bsrv', type: 'shell' }])
    expect(parked(tracker, 'tabL14')).toBeDefined()
    tracker.bindSession('tabL14', file, SID, cwd, '', '', 'clear')
    expect(parked(tracker, 'tabL14')).toBeUndefined()
    expect(status(tracker, 'tabL14')).toBe('waiting')
  })

  it("an Esc judges the shells of the interrupted turn on a FRESH OS view, not the previous turn's", async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabL15', cwd, initialLines(cwd))
    tracker.setStatus('tabL15', 'working')
    // turn 1 leaves a real snapshot behind: one shell, alive, then reported gone
    stageProcs(tracker, { bold: { ageMs: 0 } })
    await tracker.reportTurnEnd('tabL15', [{ id: 'bold', type: 'shell' }])
    expect(status(tracker, 'tabL15')).toBe('working')
    await tracker.reportTurnEnd('tabL15', [])
    expect(status(tracker, 'tabL15')).toBe('waiting')
    // turn 2 starts a NEW shell and is Esc'd. No snapshot is taken while a turn
    // runs, so the one on record still shows turn 1's world — judging on it
    // would read the new shell as already dead and rest the dot under it
    tracker.setStatus('tabL15', 'working')
    stageProcs(tracker, { btoolu_new: { ageMs: 0 } })
    appendJsonl(file, [
      commandUseRec('toolu_new', cwd, 'npm run e2e'),
      shellAckRec('toolu_new', cwd),
      interruptRec(cwd)
    ])
    await sleep(SCAN_MS + 200)
    expect(status(tracker, 'tabL15')).toBe('working')
    stageProcs(tracker, {})
    await waitFor(tracker, (s) => s.tabId === 'tabL15' && s.status === 'waiting', 6000)
  }, 10_000)
})

/*
 * closing an idle session by itself. Requirement: a session whose dot has
 * been 'idle' long enough is closed to give its ~250 MB back, but only when every
 * reason to keep it is gone — and every one of those reasons is read FRESH at the
 * moment of closing, half an hour after the dot last moved. A reason that is still
 * there only postpones the attempt. The tracker just announces the verdict
 * ('auto-close'); index.ts does the killing.
 */

/** Everything outside the tracker says "go ahead": a pid is wired, the OS view is
 *  empty, nobody is looking at this tab, nothing is unsaved. Each case below puts
 *  exactly ONE reason back. */
function stageAllClear(tracker: InstanceType<typeof SessionTracker>): void {
  stageProcs(tracker, {})
  tracker.activeTabId = () => null
  tracker.heldTabs = () => new Set<string>()
  tracker.needsUser = () => false
}

function recordAutoCloses(tracker: EventEmitter): string[] {
  const seen: string[] = []
  tracker.on('auto-close', ({ tabId }: { tabId: string }) => seen.push(tabId))
  return seen
}

/** bind a session, let its dot fall to 'idle', and hand back the auto-close log */
async function idleSession(
  tracker: InstanceType<typeof SessionTracker>,
  tabId: string,
  cwd: string
): Promise<string[]> {
  const closes = recordAutoCloses(tracker)
  await bindCaughtUp(tracker, tabId, cwd, initialLines(cwd))
  await waitFor(tracker, (s) => s.tabId === tabId && s.status === 'idle', 5000)
  return closes
}

/** Wait for the close rather than sleeping exactly as long as it should take: the
 *  suite runs 30 files at once, and a timer that fires late is not a wrong answer. */
async function waitForClose(closes: string[], tabId: string): Promise<void> {
  const until = Date.now() + 8000
  while (!closes.includes(tabId) && Date.now() < until) await sleep(25)
  expect(closes).toContain(tabId)
}

/** Nothing closed, with two whole close windows allowed to pass. */
async function expectStays(closes: string[]): Promise<void> {
  await sleep(IDLE_CLOSE_MS * 2 + 300)
  expect(closes).toEqual([])
}

describe('auto-closing an idle session', () => {
  it('closes an idle session nothing is holding — once', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    const closes = await idleSession(tracker, 'tabA1', cwd)
    await waitForClose(closes, 'tabA1')
    await sleep(IDLE_CLOSE_MS + 300)
    expect(closes).toEqual(['tabA1']) // and not again: a close is not re-armed
  }, 15_000)

  it('never closes a session that has never said anything (no status at all)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    const closes = recordAutoCloses(tracker)
    tracker.track('tabA2', cwd) // a claude that started but was never typed into
    await sleep(IDLE_MS + IDLE_CLOSE_MS * 2 + 300)
    expect(closes).toEqual([])
  }, 10_000)

  it('never closes the tab the user is looking at', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    tracker.activeTabId = () => 'tabA3'
    const closes = await idleSession(tracker, 'tabA3', cwd)
    await expectStays(closes)
  }, 10_000)

  it('never closes a remote session (this Mac cannot see that machine)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    const closes = recordAutoCloses(tracker)
    tracker.track('tabA4', cwd, { host: 'devbox', projectsRoot, tmuxName: 'k-' + SID })
    const file = writeJsonl(cwd, SID, initialLines(cwd))
    tracker.bindSession('tabA4', file, SID, cwd)
    await waitFor(tracker, (s) => s.tabId === 'tabA4' && s.status === 'idle', 5000)
    await expectStays(closes)
  }, 10_000)

  it('never closes a session holding something parked (a Monitor badge)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    const closes = recordAutoCloses(tracker)
    const file = await bindCaughtUp(tracker, 'tabA5', cwd, initialLines(cwd))
    tracker.setStatus('tabA5', 'working')
    appendJsonl(file, [
      commandUseRec('toolu_mon', cwd, 'tail -f /tmp/bot.log', 'Monitor'),
      monitorAckRec('toolu_mon', cwd)
    ])
    await tracker.reportTurnEnd('tabA5', [{ id: 'mtoolu_mon', type: 'shell' }])
    await waitFor(tracker, (s) => s.tabId === 'tabA5' && s.status === 'idle', 5000)
    await expectStays(closes)
    expect(parked(tracker, 'tabA5')).toBeDefined() // the badge is the reason
  }, 10_000)

  it('holds a tab with an unsaved edit at the first window, and closes it at the next', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    let dirty = new Set(['tabA6'])
    tracker.heldTabs = () => dirty
    const closes = await idleSession(tracker, 'tabA6', cwd)
    await expectStays(closes)

    dirty = new Set<string>() // the user saved: the next window has no reason left
    await waitForClose(closes, 'tabA6')
  }, 15_000)

  it('never closes a tab with a "needs you" mark you have not seen, and closes it once seen', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    let unseen = true // a finished turn you were not looking at when it landed
    tracker.needsUser = () => unseen
    const closes = await idleSession(tracker, 'tabA12', cwd)
    await expectStays(closes)

    unseen = false // you looked: the mark is gone and nothing is left to keep it
    await waitForClose(closes, 'tabA12')
  }, 15_000)

  // typing lands hundreds of ms before the hook that would move the dot off 'idle',
  // so the keystroke itself has to restart the clock
  it('restarts the clock while it is being typed into, and closes once that stops', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    const closes = await idleSession(tracker, 'tabA7', cwd)
    const typing = setInterval(() => tracker.noteActivity('tabA7'), IDLE_CLOSE_MS / 2)
    await expectStays(closes)
    clearInterval(typing)
    await waitForClose(closes, 'tabA7')
  }, 15_000)

  it('never closes a session whose claude still holds a live tool shell', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    const closes = await idleSession(tracker, 'tabA8', cwd)
    stageProcs(tracker, { bbg: { ageMs: 0 } }) // a background command nobody reported
    await expectStays(closes)
  }, 10_000)

  it('never closes a session the process table cannot be read for', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    const closes = await idleSession(tracker, 'tabA9', cwd)
    tracker.inspect = async () => null // ps/lsof failed: "cannot tell" is not "quiet"
    await expectStays(closes)
  }, 10_000)

  // reading the process table takes a beat; activity landing inside that beat has to
  // win, even though the look itself comes back saying "nothing is running"
  it('refuses when it is typed into while the process table is still being read', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    let finishLook: () => void = () => {}
    let lookStarted: () => void = () => {}
    const looking = new Promise<void>((r) => (lookStarted = r))
    tracker.inspect = async () => {
      lookStarted()
      await new Promise<void>((r) => (finishLook = r))
      return { shells: new Map() }
    }
    const closes = await idleSession(tracker, 'tabA11', cwd)
    await looking
    tracker.noteActivity('tabA11')
    finishLook()
    await expectStays(closes)
  }, 10_000)

  it('drops the pending close the moment the session goes back to work', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    const closes = await idleSession(tracker, 'tabA10', cwd)
    tracker.setStatus('tabA10', 'working') // the user typed a new prompt
    await expectStays(closes)
  }, 10_000)
})
