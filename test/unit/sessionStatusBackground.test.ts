import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { EventEmitter } from 'events'
import type { SessionInfo, SessionStatus } from '@shared/types'

const HOLD_MS = 400
const SILENCE_MS = 1500
const SCAN_MS = 250
const RESUME_MS = 300
const SERVER_AGE_MS = 1000
const TEAMMATE_QUIET_MS = 500
const PROCS_SCAN_MS = 100
const IDLE_MS = 2000
const IDLE_CLOSE_MS = 400
const TRUNCATION_SEEN_BY_500_MS_WATCH_TICK_PLUS_RECONCILE_MS = 1500

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
  process.env.KOLOFT_SERVER_AGE_MS = String(SERVER_AGE_MS)
  process.env.KOLOFT_TEAMMATE_QUIET_MS = String(TEAMMATE_QUIET_MS)
  process.env.KOLOFT_PROCS_SCAN_MS = String(PROCS_SCAN_MS)
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

// CC§8
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

// CC§8
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

// CC§8
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

function notifText(toolUseId: string, status: string): string {
  return (
    `<task-notification>\n<task-id>t_${toolUseId}</task-id>\n` +
    `<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n` +
    `<summary>done</summary>\n</task-notification>`
  )
}

// CC§8
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

// CC§8
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

// CC§2
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

// CC§8
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

function mainAssistantRec(cwd: string, atMs = Date.now(), sidechain = false): unknown {
  return {
    type: 'assistant',
    timestamp: new Date(atMs).toISOString(),
    isSidechain: sidechain,
    message: { role: 'assistant', content: [{ type: 'text', text: 'working…' }] },
    cwd
  }
}

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

describe('run-state vs background work: any live background task keeps the session working through a turn-end until it drains', () => {
  it('a live background spawn holds working through a turn-end (no waiting edge)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB1', cwd, initialLines(cwd))
    tracker.setStatus('tabB1', 'working')

    const edges: Array<{ prev?: SessionStatus; next: SessionStatus }> = []
    tracker.on('status', (e: { prev?: SessionStatus; next: SessionStatus }) => edges.push(e))

    appendJsonl(file, [spawnRec('toolu_bg1', cwd)])
    await tracker.reportTurnEnd('tabB1')

    expect(status(tracker, 'tabB1')).toBe('working')
    expect(edges.find((e) => e.next === 'waiting')).toBeUndefined()
  })

  it('a delivered task-notification drains the ledger; the next turn-end waits', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB2', cwd, initialLines(cwd))
    tracker.setStatus('tabB2', 'working')

    appendJsonl(file, [spawnRec('toolu_bg2', cwd)])
    await tracker.reportTurnEnd('tabB2')
    expect(status(tracker, 'tabB2')).toBe('working')

    appendJsonl(file, [notifRec('toolu_bg2', cwd)])
    await tracker.reportTurnEnd('tabB2')
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
    await sleep(HOLD_MS + 200)
    await tracker.reportTurnEnd('tabB4')
    expect(status(tracker, 'tabB4')).toBe('working')

    await waitFor(tracker, (s) => s.tabId === 'tabB4' && s.status === 'waiting', 8000)
  }, 12_000)

  it('fresh subagent growth promotes a resting dot (Koloft bound mid-run, ledger empty)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabB5', cwd, [...initialLines(cwd), spawnRec('toolu_old', cwd)])
    expect(status(tracker, 'tabB5')).toBe('waiting')

    await sleep(RESUME_MS + 300)
    writeSubagentJsonl(cwd, SID, 'agent-live.jsonl', [subagentRec(Date.now())])
    await waitFor(tracker, (s) => s.tabId === 'tabB5' && s.status === 'working', 8000)

    await waitFor(tracker, (s) => s.tabId === 'tabB5' && s.status === 'waiting', 8000)
  }, 20_000)

  it('a promoted hold outlives the recency window, so one long tool call neither flaps the dot nor fires a false turn-done', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabB19', cwd, [...initialLines(cwd), spawnRec('toolu_old', cwd)])
    expect(status(tracker, 'tabB19')).toBe('waiting')

    await sleep(RESUME_MS + 300)
    const promoted = new Promise<void>((resolve) =>
      tracker.on('status', (e: { tabId: string; next: SessionStatus }) => {
        if (e.tabId === 'tabB19' && e.next === 'working') resolve()
      })
    )
    const wroteAt = Date.now()
    writeSubagentJsonl(cwd, SID, 'agent-live.jsonl', [subagentRec(wroteAt)])
    await promoted

    await sleep(Math.max(0, wroteAt + HOLD_MS + 2 * SCAN_MS - Date.now()))
    expect(status(tracker, 'tabB19')).toBe('working')
  }, 12_000)

  it('stale subagent content never promotes (record time, not fold time)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    writeSubagentJsonl(cwd, SID, 'agent-done.jsonl', [subagentRec(Date.now() - 60_000)])
    await bindCaughtUp(tracker, 'tabB6', cwd, initialLines(cwd))
    expect(status(tracker, 'tabB6')).toBe('waiting')

    await sleep(SCAN_MS * 4 + 200)
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
    await sleep(SCAN_MS * 4 + 200)
    expect(status(tracker, 'tabB8')).toBe('approval')
  })

  it('a new genuine prompt supersedes a deferred turn-end (no mid-turn waiting)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB9', cwd, initialLines(cwd))
    tracker.setStatus('tabB9', 'working')

    appendJsonl(file, [spawnRec('toolu_sup', cwd)])
    await tracker.reportTurnEnd('tabB9')
    expect(status(tracker, 'tabB9')).toBe('working')

    appendJsonl(file, [
      { type: 'user', message: { role: 'user', content: 'and another thing' }, cwd }
    ])
    await sleep(SILENCE_MS + SCAN_MS * 4)
    expect(status(tracker, 'tabB9')).toBe('working')
  }, 10_000)

  it('a turn that ran a FOREGROUND subagent rests immediately at turn-end', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB10', cwd, initialLines(cwd))
    tracker.setStatus('tabB10', 'working')

    writeSubagentJsonl(cwd, SID, 'agent-sync.jsonl', [subagentRec(Date.now())])
    await sleep(SCAN_MS + 100)
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
    expect(status(tracker, 'tabB12')).toBe('working')

    fs.writeFileSync(file, JSON.stringify(initialLines(cwd)[0]) + '\n')
    await waitFor(tracker, (s) => s.tabId === 'tabB12' && s.status === 'waiting', 8000)
  }, 12_000)

  it('a live spawn ack inside the catch-up batch still enters the ledger', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    tracker.track('tabB13', cwd)
    const file = writeJsonl(cwd, SID, initialLines(cwd))
    tracker.bindSession('tabB13', file, SID, cwd)
    appendJsonl(file, [spawnRec('toolu_race', cwd)])
    await waitFor(tracker, (s) => s.tabId === 'tabB13' && s.title === 'do some work')
    tracker.setStatus('tabB13', 'working')
    await tracker.reportTurnEnd('tabB13')
    expect(status(tracker, 'tabB13')).toBe('working')
  })

  it('a Stop right after a granted approval still lands waiting (recovery must not eat it)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB14', cwd, initialLines(cwd))
    tracker.setStatus('tabB14', 'approval')

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

  it('a status listener that throws mid-parse cannot swallow the one Stop a turn gets', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB20', cwd, initialLines(cwd))
    tracker.setStatus('tabB20', 'approval')
    tracker.on('status', (e: { tabId: string; next: SessionStatus }) => {
      if (e.tabId === 'tabB20' && e.next === 'working') throw new Error('listener failed')
    })

    appendJsonl(file, [mainAssistantRec(cwd)])
    await tracker.reportTurnEnd('tabB20')
    expect(status(tracker, 'tabB20')).toBe('waiting')
  })

  it("the ending turn's own late-folded prompt record must NOT eat its Stop", async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB15', cwd, initialLines(cwd))
    tracker.setStatus('tabB15', 'working')

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
    expect(status(tracker, 'tabB16')).toBe('waiting')

    await sleep(RESUME_MS + 200)
    writeSubagentJsonl(cwd, SID, 'agent-live.jsonl', [subagentRec(Date.now())])
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
    expect(status(tracker, 'tabB17')).toBe('working')

    fs.writeFileSync(
      file,
      [...initialLines(cwd), ack].map((l) => JSON.stringify(l)).join('\n') + '\n'
    )
    await sleep(TRUNCATION_SEEN_BY_500_MS_WATCH_TICK_PLUS_RECONCILE_MS)
    expect(status(tracker, 'tabB17')).toBe('working')

    appendJsonl(file, [notifRec('toolu_keep', cwd)])
    await tracker.reportTurnEnd('tabB17')
    expect(status(tracker, 'tabB17')).toBe('waiting')
  }, 12_000)

  // CC§8
  it('a cloud agent (remote_launched) holds working — it has no local transcript', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabR1', cwd, initialLines(cwd))
    tracker.setStatus('tabR1', 'working')

    appendJsonl(file, [
      spawnRec('toolu_remote', cwd, 'remote_launched', { taskType: 'remote_agent' })
    ])
    await tracker.reportTurnEnd('tabR1')
    expect(status(tracker, 'tabR1')).toBe('working')

    appendJsonl(file, [attachNotifRec('toolu_remote', cwd)])
    await tracker.reportTurnEnd('tabR1')
    expect(status(tracker, 'tabR1')).toBe('waiting')
  })

  // CC§8
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

    await sleep(RESUME_MS + 300)
    writeSubagentJsonl(cwd, SID, 'agent-7.jsonl', [subagentRec(Date.now())], 'workflows/wf_deep')
    await waitFor(tracker, (s) => s.tabId === 'tabW2' && s.status === 'working', 8000)
  }, 12_000)

  it('a shell the model is BLOCKED on holds working (auto-backgrounded at its timeout)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabS1', cwd, initialLines(cwd))
    tracker.setStatus('tabS1', 'working')

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

  // CC§8
  it('a skill forked into the background holds working — its own wrap-up must not rest the dot', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabF1', cwd, initialLines(cwd))
    tracker.setStatus('tabF1', 'working')

    const edges: Array<{ prev?: SessionStatus; next: SessionStatus }> = []
    tracker.on('status', (e: { prev?: SessionStatus; next: SessionStatus }) => edges.push(e))

    writeSubagentJsonl(cwd, SID, 'agent-forked.jsonl', [subagentRec(Date.now() - 1000)])
    appendJsonl(file, [forkedSkillRec('toolu_fork', cwd), mainAssistantRec(cwd)])
    await tracker.reportTurnEnd('tabF1')

    expect(status(tracker, 'tabF1')).toBe('working')
    expect(edges.find((e) => e.next === 'waiting')).toBeUndefined()
  })

  it('a forked skill retires on its terminal task-notification', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabF2', cwd, initialLines(cwd))
    tracker.setStatus('tabF2', 'working')

    appendJsonl(file, [forkedSkillRec('toolu_fork2', cwd)])
    await tracker.reportTurnEnd('tabF2')
    expect(status(tracker, 'tabF2')).toBe('working')

    appendJsonl(file, [notifRec('toolu_fork2', cwd)])
    await tracker.reportTurnEnd('tabF2')
    expect(status(tracker, 'tabF2')).toBe('waiting')
  })

  // CC§8
  it('a fork with no background flag never enters the ledger (its result is already final)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabF3', cwd, initialLines(cwd))
    tracker.setStatus('tabF3', 'working')

    appendJsonl(file, [forkedSkillRec('toolu_sync_fork', cwd, false)])
    await tracker.reportTurnEnd('tabF3')
    expect(status(tracker, 'tabF3')).toBe('waiting')
  })

  // CC§8
  it("a background shell stopped via the UI retires on its 'stopped' notification", async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabS5', cwd, initialLines(cwd))
    tracker.setStatus('tabS5', 'working')

    appendJsonl(file, [shellAckRec('toolu_stopme', cwd)])
    await tracker.reportTurnEnd('tabS5')
    expect(status(tracker, 'tabS5')).toBe('working')

    appendJsonl(file, [queueNotifRec('toolu_stopme', 'enqueue', 'stopped')])
    await tracker.reportTurnEnd('tabS5')
    expect(status(tracker, 'tabS5')).toBe('waiting')
  })

  // CC§8
  it('every delivered-notification shape retires the ledger (attachment / queue-op / legacy)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabN1', cwd, initialLines(cwd))
    tracker.setStatus('tabN1', 'working')

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
      tracker.setStatus('tabN1', 'working')
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

  // CC§8
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

  // CC§2
  it('interleaved sidechain records read as background, not main-loop, activity', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabX1', cwd, initialLines(cwd))
    tracker.setStatus('tabX1', 'working')

    const now = Date.now()
    appendJsonl(file, [mainAssistantRec(cwd, now - 200), mainAssistantRec(cwd, now, true)])
    await tracker.reportTurnEnd('tabX1')
    expect(status(tracker, 'tabX1')).toBe('working')
  })

  // CC§2
  it("a subagent's own prompt in the main transcript is not the user's: a held turn still self-releases", async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabX2', cwd, initialLines(cwd))
    tracker.setStatus('tabX2', 'working')

    appendJsonl(file, [spawnRec('toolu_side', cwd)])
    await tracker.reportTurnEnd('tabX2')
    expect(status(tracker, 'tabX2')).toBe('working')

    appendJsonl(file, [
      {
        type: 'user',
        timestamp: new Date().toISOString(),
        isSidechain: true,
        message: { role: 'user', content: 'look through the logs' },
        cwd
      },
      mainAssistantRec(cwd, Date.now(), true)
    ])
    await waitFor(tracker, (s) => s.tabId === 'tabX2' && s.status === 'waiting', 8000)
  }, 12_000)

  it('a turn-end racing the watch-tick parse of its own spawn ack still holds', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabB18', cwd, initialLines(cwd))
    tracker.setStatus('tabB18', 'working')

    const first = tracker.reportTurnEnd('tabB18')
    appendJsonl(file, [spawnRec('toolu_coal', cwd)])
    const second = tracker.reportTurnEnd('tabB18')
    await Promise.all([first, second])
    expect(status(tracker, 'tabB18')).toBe('working')
  })
})

// CC§8
describe("run-state from the turn-end payload: the Stop hook's own task list outranks the inferred ledger, which stays for an older claude", () => {
  it('a reported live task holds working with NO ack in the transcript at all', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabP1', cwd, initialLines(cwd))
    tracker.setStatus('tabP1', 'working')

    const edges: Array<{ prev?: SessionStatus; next: SessionStatus }> = []
    tracker.on('status', (e: { prev?: SessionStatus; next: SessionStatus }) => edges.push(e))

    await tracker.reportTurnEnd('tabP1', [
      { id: 'a1', type: 'subagent' },
      { id: 'a2', type: 'subagent' }
    ])
    expect(status(tracker, 'tabP1')).toBe('working')
    expect(edges.find((e) => e.next === 'waiting')).toBeUndefined()
  })

  // CC§8
  it('a reported empty list rests the dot even while the inferred ledger still holds', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabP2', cwd, initialLines(cwd))
    tracker.setStatus('tabP2', 'working')

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
    await tracker.reportTurnEnd('tabP3')
    expect(status(tracker, 'tabP3')).toBe('working')
  })

  it('an empty ledger cannot release a payload-held turn-end early', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabP5', cwd, initialLines(cwd))
    tracker.setStatus('tabP5', 'working')

    await tracker.reportTurnEnd('tabP5', [{ id: 'a1', type: 'subagent' }])
    await sleep(HOLD_MS + SCAN_MS + 150)
    expect(status(tracker, 'tabP5')).toBe('working')
  }, 12_000)

  it('a reported hold still self-releases at the silence cap (tasks died silently)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabP6', cwd, initialLines(cwd))
    tracker.setStatus('tabP6', 'working')

    await tracker.reportTurnEnd('tabP6', [{ id: 'a1', type: 'subagent' }])
    await waitFor(tracker, (s) => s.tabId === 'tabP6' && s.status === 'waiting', 8000)
  }, 12_000)
})

// CC§2
describe('Esc interrupt as turn-end: no Stop ever fires, so the interrupt record ends the turn, gated on background work like a Stop', () => {
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

    appendJsonl(file, [interruptRec(cwd, Date.now(), true)])
    await waitFor(tracker, (s) => s.tabId === 'tabI2' && s.status === 'waiting', 8000)
    expect(edges.some((e) => e.next === 'working')).toBe(false)
  }, 12_000)

  it('an interrupt with live background tasks holds working until the drain', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabI3', cwd, initialLines(cwd))
    tracker.setStatus('tabI3', 'working')

    appendJsonl(file, [spawnRec('toolu_esc_bg', cwd), interruptRec(cwd)])
    await sleep(SCAN_MS * 4 + 200)
    expect(status(tracker, 'tabI3')).toBe('working')

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

    appendJsonl(file, [interruptRec(cwd, Date.now() - 100)])
    tracker.setStatus('tabI5', 'working')
    await sleep(SCAN_MS * 4 + 200)
    expect(status(tracker, 'tabI5')).toBe('working')
  }, 10_000)

  it('a historical interrupt in the catch-up replay drives nothing', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const tracker2 = tracker
    const old = interruptRec(cwd, Date.now() - 60_000)
    await bindCaughtUp(tracker2, 'tabI6', cwd, [...initialLines(cwd), old])
    expect(status(tracker2, 'tabI6')).toBe('waiting')

    tracker2.setStatus('tabI6', 'working')
    await sleep(SCAN_MS * 3 + 200)
    expect(status(tracker2, 'tabI6')).toBe('working')
  }, 10_000)
})

type StagedShell = { ageMs?: number; listening?: boolean }

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

// CC§8
describe('run-state from the typed task list: each task judged by what it is, and what is parked shows as a badge, not the dot', () => {
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
    tracker.track('tabL5R', cwd, {
      host: 'devbox',
      projectsRoot,
      tmuxName: 'k-' + SID
    })
    const file = writeJsonl(cwd, SID, initialLines(cwd))
    tracker.bindSession('tabL5R', file, SID, cwd)
    await waitFor(tracker, (s) => s.tabId === 'tabL5R' && s.title === 'do some work')
    stageProcs(tracker, {})
    tracker.setStatus('tabL5R', 'working')
    await tracker.reportTurnEnd('tabL5R', [{ id: 'bremote', type: 'shell' }])
    expect(status(tracker, 'tabL5R')).toBe('working')
  })

  it('teammates work while a transcript of theirs grows, and are parked idle once quiet', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabL6', cwd, initialLines(cwd))
    stageProcs(tracker, {})
    writeTeammateJsonl(cwd, SID, 'tm1', [subagentRec(Date.now())])
    await sleep(SCAN_MS + 150)
    tracker.setStatus('tabL6', 'working')
    await tracker.reportTurnEnd('tabL6', [
      { id: 'ttm1', type: 'teammate' },
      { id: 'ttm2', type: 'teammate' }
    ])
    expect(status(tracker, 'tabL6')).toBe('working')
    await waitFor(tracker, (s) => s.tabId === 'tabL6' && s.status === 'waiting', 6000)
    expect(parked(tracker, 'tabL6')).toEqual([{ kind: 'teammate', label: '2 idle' }])
  }, 10_000)

  it('a tool call in flight (a shell the list does not name) holds a quiet teammate as working', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    await bindCaughtUp(tracker, 'tabL18', cwd, initialLines(cwd))
    stageProcs(tracker, { bfg: { ageMs: 0 } })
    tracker.setStatus('tabL18', 'working')
    await tracker.reportTurnEnd('tabL18', [{ id: 'ttm1', type: 'teammate' }])
    expect(status(tracker, 'tabL18')).toBe('working')
    await sleep(TEAMMATE_QUIET_MS + SCAN_MS + 100)
    expect(status(tracker, 'tabL18')).toBe('working')
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
    stageProcs(tracker, { bpre: { ageMs: 0 } })
    await tracker.reportTurnEnd('tabL10', [{ id: 'bpre', type: 'shell' }])
    expect(status(tracker, 'tabL10')).toBe('working')
    await tracker.reportTurnEnd('tabL10')
    expect(status(tracker, 'tabL10')).toBe('working')
  })

  it('an idle nudge cannot be held by a ledger entry the list has judged idle', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    const file = await bindCaughtUp(tracker, 'tabL11', cwd, initialLines(cwd))
    stageProcs(tracker, {})
    tracker.setStatus('tabL11', 'working')
    appendJsonl(file, [spawnRec('toolu_mate', cwd, 'teammate_spawned')])
    await sleep(SCAN_MS + 150)
    await sleep(TEAMMATE_QUIET_MS + 100)
    await tracker.reportTurnEnd('tabL11', [{ id: 'tmate', type: 'teammate' }])
    expect(status(tracker, 'tabL11')).toBe('waiting')
    tracker.setStatus('tabL11', 'working')
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
    tracker.setStatus('tabL13', 'working')
    stageProcs(tracker, { btoolu_esc: { ageMs: 0 } })
    appendJsonl(file, [
      commandUseRec('toolu_esc', cwd, 'npm run build'),
      shellAckRec('toolu_esc', cwd),
      interruptRec(cwd)
    ])
    await sleep(SCAN_MS + 200)
    expect(status(tracker, 'tabL13')).toBe('working')
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
    stageProcs(tracker, { bold: { ageMs: 0 } })
    await tracker.reportTurnEnd('tabL15', [{ id: 'bold', type: 'shell' }])
    expect(status(tracker, 'tabL15')).toBe('working')
    await tracker.reportTurnEnd('tabL15', [])
    expect(status(tracker, 'tabL15')).toBe('waiting')
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

async function waitForClose(closes: string[], tabId: string): Promise<void> {
  const until = Date.now() + 8000
  while (!closes.includes(tabId) && Date.now() < until) await sleep(25)
  expect(closes).toContain(tabId)
}

async function expectStays(closes: string[]): Promise<void> {
  await sleep(IDLE_CLOSE_MS * 2 + 300)
  expect(closes).toEqual([])
}

// CC§12
describe('auto-closing an idle session: every reason to keep it is read fresh at close time, and one still there only postpones', () => {
  it('closes an idle session nothing is holding — once', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    const closes = await idleSession(tracker, 'tabA1', cwd)
    await waitForClose(closes, 'tabA1')
    await sleep(IDLE_CLOSE_MS + 300)
    expect(closes).toEqual(['tabA1'])
  }, 15_000)

  it('never closes a session that has never said anything (no status at all)', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    const closes = recordAutoCloses(tracker)
    tracker.track('tabA2', cwd)
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
    expect(parked(tracker, 'tabA5')).toBeDefined()
  }, 10_000)

  it('holds a tab with an unsaved edit at the first window, and closes it at the next', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    let dirty = new Set(['tabA6'])
    tracker.heldTabs = () => dirty
    const closes = await idleSession(tracker, 'tabA6', cwd)
    await expectStays(closes)

    dirty = new Set<string>()
    await waitForClose(closes, 'tabA6')
  }, 15_000)

  it('never closes a tab with a "needs you" mark you have not seen, and closes it once seen', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    let unseen = true
    tracker.needsUser = () => unseen
    const closes = await idleSession(tracker, 'tabA12', cwd)
    await expectStays(closes)

    unseen = false
    await waitForClose(closes, 'tabA12')
  }, 15_000)

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
    stageProcs(tracker, { bbg: { ageMs: 0 } })
    await expectStays(closes)
  }, 10_000)

  it('never closes a session the process table cannot be read for', async () => {
    const cwd = makeWorkspace()
    const tracker = newTracker()
    stageAllClear(tracker)
    const closes = await idleSession(tracker, 'tabA9', cwd)
    tracker.inspect = async () => null
    await expectStays(closes)
  }, 10_000)

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
    tracker.setStatus('tabA10', 'working')
    await expectStays(closes)
  }, 10_000)
})
