import { describe, expect, it } from 'vitest'
import type {
  BackendAvailability,
  DiscoveredFolder,
  SessionMethods,
  SessionRow
} from '../../src/shared/types'
import {
  ADOPTED_PER_FOLDER,
  FIRST_RUN_RECENT_MS,
  foldersToPin,
  rowsToAdopt
} from '../../src/shared/firstRun'
import {
  defaultAccountName,
  defaultAgent,
  lastUsedAgent,
  nextAgent,
  resumeTarget,
  tallyAgents
} from '../../src/renderer/src/welcomeModel'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

function folder(
  path: string,
  ago: number,
  agents: DiscoveredFolder['agents'] = {}
): DiscoveredFolder {
  return { path, sessions: 1, mtime: NOW - ago, agents }
}

function installed(...ids: BackendAvailability['id'][]): BackendAvailability[] {
  return (['claude', 'codex', 'muse', 'agy'] as const).map((id) => ({
    id,
    available: ids.includes(id)
  }))
}

function row(id: string, ago: number, extra: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    title: id,
    cwd: '/w',
    worktree: 'main',
    running: false,
    invalidCwd: false,
    mtime: NOW - ago,
    backendId: 'claude',
    host: 'local',
    ...extra
  }
}

describe('welcome: which folders a first run pins', () => {
  it('pins up to three folders used in the last two weeks, newest first', () => {
    const found = [
      folder('/a', 1 * DAY),
      folder('/b', 2 * DAY),
      folder('/c', 3 * DAY),
      folder('/d', 4 * DAY),
      folder('/old', 30 * DAY)
    ]
    expect(foldersToPin(found, NOW).map((f) => f.path)).toEqual(['/a', '/b', '/c'])
  })

  it('with nothing that recent it still pins the one folder used last', () => {
    const found = [folder('/x', 40 * DAY), folder('/y', 90 * DAY)]
    expect(foldersToPin(found, NOW).map((f) => f.path)).toEqual(['/x'])
  })

  it('with no history it pins nothing', () => {
    expect(foldersToPin([], NOW)).toEqual([])
  })
})

describe('welcome: which agent it starts with', () => {
  const found = [
    folder('/a', DAY, { claude: { sessions: 14, mtime: NOW - 5 * 3600_000 } }),
    folder('/b', DAY, {
      codex: { sessions: 7, mtime: NOW - 2 * 3600_000 },
      claude: { sessions: 2, mtime: NOW - 9 * DAY }
    })
  ]
  const allOn: SessionMethods = {
    defaultBackend: 'claude',
    enabled: { claude: true, codex: true, muse: true, agy: true }
  }

  it('is the installed agent used most recently, not the one used most', () => {
    expect(defaultAgent(tallyAgents(found), installed('claude', 'codex'), allOn)).toBe('codex')
  })

  it('skips an agent that is no longer on this Mac', () => {
    expect(defaultAgent(tallyAgents(found), installed('claude'), allOn)).toBe('claude')
  })

  it('with no history it is the first installed agent, and Claude Code on an empty Mac', () => {
    expect(defaultAgent({}, installed('muse', 'agy'), allOn)).toBe('muse')
    expect(defaultAgent({}, installed(), allOn)).toBe('claude')
  })

  it('with no history it is the default agent set in Settings ▸ Sessions when that one is installed', () => {
    const museFirst = { ...allOn, defaultBackend: 'muse' as const }
    expect(defaultAgent({}, installed('claude', 'muse'), museFirst)).toBe('muse')
  })

  it('leaves out an agent switched off in Settings ▸ Sessions: never the default, never marked last used, and Tab walks past it', () => {
    const codexOff = { ...allOn, enabled: { ...allOn.enabled, codex: false } }
    const tally = tallyAgents(found)
    expect(defaultAgent(tally, installed('claude', 'codex'), codexOff)).toBe('claude')
    expect(lastUsedAgent(tally, installed('claude', 'codex'), codexOff)).toBe('claude')
    expect(defaultAgent({}, installed('codex', 'muse'), codexOff)).toBe('muse')
    expect(nextAgent('claude', codexOff)).toBe('muse')
    expect(nextAgent('agy', codexOff)).toBe('claude')
  })

  it('counts each agent’s sessions and folders across all folders', () => {
    expect(tallyAgents(found)).toEqual({
      claude: { sessions: 16, mtime: NOW - 5 * 3600_000, folders: 2 },
      codex: { sessions: 7, mtime: NOW - 2 * 3600_000, folders: 1 }
    })
  })
})

describe('welcome: the account name nobody has to type', () => {
  it('is the agent’s name, with -2, -3 on a clash among that agent’s accounts only, in any letter case', () => {
    expect(defaultAccountName('codex', [])).toBe('Codex')
    expect(
      defaultAccountName('codex', [
        { name: 'Codex', kind: 'codex-home' },
        { name: 'Codex-2', kind: 'codex-home' },
        { name: 'Muse', kind: 'oauth' }
      ])
    ).toBe('Codex-3')
    expect(defaultAccountName('agy', [{ name: 'Codex', kind: 'codex-home' }])).toBe('Antigravity')
    expect(defaultAccountName('claude', [{ name: 'claude', kind: 'oauth' }])).toBe('Claude-2')
  })
})

describe('welcome: the terminal sessions it brings into the sidebar and the one it resumes', () => {
  it('adopts a folder’s newest recent sessions, never a stale or folderless one', () => {
    const rows = [
      row('gone', DAY, { invalidCwd: true }),
      ...Array.from({ length: ADOPTED_PER_FOLDER + 1 }, (_, i) => row('r' + i, (i + 1) * DAY)),
      row('old', FIRST_RUN_RECENT_MS + DAY)
    ]
    expect(rowsToAdopt(rows, NOW).map((r) => r.id)).toEqual(
      Array.from({ length: ADOPTED_PER_FOLDER }, (_, i) => 'r' + i)
    )
  })

  it('resumes the newest session, skipping one that may still run in a terminal', () => {
    const rows = [row('older', 3 * DAY), row('busy', 10_000), row('newest', 2 * 3600_000)]
    expect(resumeTarget(rows, NOW)?.id).toBe('newest')
    expect(resumeTarget([row('busy', 10_000)], NOW)).toBeUndefined()
  })
})
