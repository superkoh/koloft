import { describe, it, expect } from 'vitest'
import {
  resolveBuckets,
  aggregateSessions,
  extractJsonlMeta,
  extractJsonlTail,
  filterOwned,
  hasHistory,
  planRescan,
  resolvePending,
  TITLE_MAX,
  type AggregateDeps,
  type Bucket,
  type SessionMeta,
  type RescanState
} from '../../src/main/sessionAggregate'
import { PENDING_SESSION_TITLE, PLACEHOLDER_SESSION_TITLE, type SessionRow } from '@shared/types'

const WS = '/Users/dev/proj'
const WT = '/Users/dev/proj/.claude/worktrees/bugfix'
const WS_SLUG = '-Users-dev-proj'
const WT_SLUG = '-Users-dev-proj--claude-worktrees-bugfix'
const NOW = Date.parse('2026-08-08T12:00:00.000Z')

function meta(m: Partial<SessionMeta>): SessionMeta {
  return {
    cwd: m.cwd ?? WS,
    timestamp: m.timestamp ?? '2026-08-08T11:00:00.000Z',
    aiTitle: m.aiTitle,
    summary: m.summary,
    firstUserText: m.firstUserText,
    commandArgsText: m.commandArgsText,
    commandNameText: m.commandNameText,
    worktreeState: m.worktreeState
  }
}

function aggDeps(o: Partial<AggregateDeps>): AggregateDeps {
  return {
    listJsonl: () => [],
    readMeta: () => meta({}),
    runningIds: new Set(),
    dirExists: () => true,
    now: () => NOW,
    ...o
  }
}

describe('resolveBuckets', () => {
  it('merges main + worktree buckets, deduping the porcelain main-checkout entry (T-AGG-01)', () => {
    const buckets = resolveBuckets(WS, {
      gitWorktreeList: () => [WS, WT],
      listProjectSlugs: () => [WS_SLUG, WT_SLUG, '-Users-dev-other'],
      readFirstCwd: () => null
    })
    expect(buckets).toEqual([
      { slug: WS_SLUG, dir: WS },
      { slug: WT_SLUG, dir: WT }
    ])
  })

  // CC§2
  it('resolves a truncated+suffixed slug via prefix match confirmed by first-cwd lookup (T-AGG-02)', () => {
    const longWt = '/Users/dev/proj/.claude/worktrees/sequential-baking-goblet'
    const truncated = '-Users-dev-proj--claude-worktrees-sequential-bak-ezjn6r'
    const buckets = resolveBuckets(WS, {
      gitWorktreeList: () => [WS, longWt],
      listProjectSlugs: () => [WS_SLUG, truncated],
      readFirstCwd: (slug) => (slug === truncated ? longWt : null)
    })
    expect(buckets).toContainEqual({ slug: truncated, dir: longWt })
  })

  it('rejects a neighbor repo slug sharing a prefix when first-cwd disagrees (T-AGG-02)', () => {
    const ws2 = '/Users/dev/koloft2'
    const neighbor = '-Users-dev-koloft'
    const buckets = resolveBuckets(ws2, {
      gitWorktreeList: () => [ws2],
      listProjectSlugs: () => [neighbor],
      readFirstCwd: (slug) => (slug === neighbor ? '/Users/dev/koloft' : null)
    })
    expect(buckets.map((b) => b.slug)).not.toContain(neighbor)
    expect(buckets).toEqual([{ slug: '-Users-dev-koloft2', dir: ws2 }])
  })
})

// CC§4
describe('resolveBuckets: orphaned worktree slugs (D2) — a worktree claude removed at exit keeps its sessions, adopted by prefix plus first-cwd', () => {
  const GONE = '/Users/dev/proj/.claude/worktrees/merged'
  const GONE_SLUG = '-Users-dev-proj--claude-worktrees-merged'

  it('buckets a slug whose worktree left `git worktree list`, dir = its recorded cwd', () => {
    const buckets = resolveBuckets(WS, {
      gitWorktreeList: () => [WS],
      listProjectSlugs: () => [WS_SLUG, GONE_SLUG],
      readFirstCwd: (s) => (s === GONE_SLUG ? GONE : null)
    })
    expect(buckets).toEqual([
      { slug: WS_SLUG, dir: WS },
      { slug: GONE_SLUG, dir: GONE }
    ])
  })

  it('finds live worktree sessions even when git is unavailable entirely, as in a packaged app launched without git on PATH (D4)', () => {
    const buckets = resolveBuckets(WS, {
      gitWorktreeList: () => [],
      listProjectSlugs: () => [WS_SLUG, WT_SLUG],
      readFirstCwd: (s) => (s === WT_SLUG ? WT : null)
    })
    expect(buckets).toEqual([
      { slug: WS_SLUG, dir: WS },
      { slug: WT_SLUG, dir: WT }
    ])
  })

  it('rejects a prefix-matching slug whose recorded cwd lies outside the worktree home', () => {
    const buckets = resolveBuckets(WS, {
      gitWorktreeList: () => [WS],
      listProjectSlugs: () => [WS_SLUG, GONE_SLUG],
      readFirstCwd: (s) => (s === GONE_SLUG ? '/Users/dev/elsewhere' : null)
    })
    expect(buckets).toEqual([{ slug: WS_SLUG, dir: WS }])
  })

  it('skips a slug with no readable first-cwd (empty slug dir)', () => {
    const buckets = resolveBuckets(WS, {
      gitWorktreeList: () => [WS],
      listProjectSlugs: () => [WS_SLUG, GONE_SLUG],
      readFirstCwd: () => null
    })
    expect(buckets).toEqual([{ slug: WS_SLUG, dir: WS }])
  })

  it('never duplicates a slug already claimed by a live worktree bucket', () => {
    const buckets = resolveBuckets(WS, {
      gitWorktreeList: () => [WS, WT],
      listProjectSlugs: () => [WS_SLUG, WT_SLUG],
      readFirstCwd: (s) => (s === WT_SLUG ? WT : null)
    })
    expect(buckets).toEqual([
      { slug: WS_SLUG, dir: WS },
      { slug: WT_SLUG, dir: WT }
    ])
  })

  it('skips a cwd nested deeper than one level under the worktree home (D5)', () => {
    const subSlug = '-Users-dev-proj--claude-worktrees-merged-sub'
    const buckets = resolveBuckets(WS, {
      gitWorktreeList: () => [WS],
      listProjectSlugs: () => [WS_SLUG, subSlug],
      readFirstCwd: (s) => (s === subSlug ? GONE + '/sub' : null)
    })
    expect(buckets).toEqual([{ slug: WS_SLUG, dir: WS }])
  })

  // CC§2
  it('adopts a truncated orphan slug once its recorded cwd confirms (V1 truncation)', () => {
    const longGone = '/Users/dev/proj/.claude/worktrees/sequential-baking-goblet'
    const truncated = '-Users-dev-proj--claude-worktrees-sequential-bak-ezjn6r'
    const buckets = resolveBuckets(WS, {
      gitWorktreeList: () => [WS],
      listProjectSlugs: () => [WS_SLUG, truncated],
      readFirstCwd: (s) => (s === truncated ? longGone : null)
    })
    expect(buckets).toContainEqual({ slug: truncated, dir: longGone })
  })

  it('adopts a slug whose truncation cut into the worktree-home prefix itself', () => {
    const longGone = '/Users/dev/proj/.claude/worktrees/deep'
    const midCut = '-Users-dev-proj--claude-wor-ab12cd'
    const buckets = resolveBuckets(WS, {
      gitWorktreeList: () => [WS],
      listProjectSlugs: () => [WS_SLUG, midCut],
      readFirstCwd: (s) => (s === midCut ? longGone : null)
    })
    expect(buckets).toContainEqual({ slug: midCut, dir: longGone })
  })
})

describe('aggregateSessions', () => {
  const twoBuckets: Bucket[] = [
    { slug: WS_SLUG, dir: WS },
    { slug: WT_SLUG, dir: WT }
  ]

  // CC§2
  it('merges rows from every bucket; worktree label from bucket dir, not the lagging gitBranch (T-AGG-01/04)', () => {
    const rows = aggregateSessions(
      twoBuckets,
      aggDeps({
        listJsonl: (slug) =>
          slug === WS_SLUG ? [{ id: 'm1', mtime: 2000 }] : [{ id: 'w1', mtime: 1000 }],
        readMeta: (_slug, id) =>
          (id === 'w1'
            ? { cwd: WT, timestamp: '2026-08-08T11:00:00.000Z', gitBranch: 'main' }
            : meta({})) as SessionMeta
      })
    )
    expect(rows.map((r) => r.id).sort()).toEqual(['m1', 'w1'])
    expect(rows.find((r) => r.id === 'm1')?.worktree).toBe('main')
    expect(rows.find((r) => r.id === 'w1')?.worktree).toBe('bugfix')
  })

  // CC§2
  it('one row per session id across buckets — the newest-written file wins over a leftover copy', () => {
    const rows = aggregateSessions(
      twoBuckets,
      aggDeps({
        listJsonl: (slug) =>
          slug === WS_SLUG ? [{ id: 's1', mtime: 1000 }] : [{ id: 's1', mtime: 5000 }],
        readMeta: (slug) =>
          meta({ cwd: slug === WS_SLUG ? WS : WT, timestamp: '2026-08-08T10:00:00.000Z' })
      })
    )
    expect(rows.map((r) => r.id)).toEqual(['s1'])
    expect(rows[0].mtime).toBe(5000)
    expect(rows[0].worktree).toBe('bugfix')
  })

  it('orders by creation time, newest first — running state and mtime never move a row (T-AGG-03)', () => {
    const created: Record<string, string> = {
      a: '2026-08-08T10:00:00.000Z',
      b: '2026-08-08T10:02:00.000Z',
      c: '2026-08-08T10:01:00.000Z'
    }
    const rows = aggregateSessions(
      [{ slug: WS_SLUG, dir: WS }],
      aggDeps({
        listJsonl: () => [
          { id: 'a', mtime: 9000 },
          { id: 'b', mtime: 2000 },
          { id: 'c', mtime: 1000 }
        ],
        readMeta: (_slug, id) => meta({ timestamp: created[id] }),
        runningIds: new Set(['c'])
      })
    )
    expect(rows.map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('title chain: aiTitle → summary → firstUserText truncated → relative time, matching the live tracker so a restart never demotes a title (T-AGG-03)', () => {
    const rows = aggregateSessions(
      [{ slug: WS_SLUG, dir: WS }],
      aggDeps({
        listJsonl: () => [
          { id: 'ai', mtime: 5000 },
          { id: 'sum', mtime: 4000 },
          { id: 'short', mtime: 3000 },
          { id: 'long', mtime: 2000 },
          { id: 'args', mtime: 1500 },
          { id: 'cmd', mtime: 1200 },
          { id: 'bare', mtime: 1000 }
        ],
        readMeta: (_slug, id) => {
          if (id === 'ai') return meta({ aiTitle: 'same title', summary: 'ignored too' })
          if (id === 'sum') return meta({ summary: 'Fix flaky test', firstUserText: 'ignored' })
          if (id === 'short')
            return meta({ firstUserText: 'short prompt', commandArgsText: 'opus' })
          if (id === 'long') return meta({ firstUserText: 'y'.repeat(TITLE_MAX + 10) })
          if (id === 'args') return meta({ commandArgsText: 'opus', commandNameText: '/model' })
          if (id === 'cmd') return meta({ commandNameText: '/release-dmg' })
          return meta({ timestamp: '2026-08-08T10:00:00.000Z' })
        }
      })
    )
    const byId = new Map(rows.map((r) => [r.id, r.title]))
    expect(byId.get('ai')).toBe('same title')
    expect(byId.get('sum')).toBe('Fix flaky test')
    expect(byId.get('short')).toBe('short prompt')
    expect(byId.get('long')).toBe('y'.repeat(TITLE_MAX) + '…')
    expect(byId.get('args')).toBe('opus')
    expect(byId.get('cmd')).toBe('/release-dmg')
    expect(byId.get('bare')).toBe('2h ago')
  })

  it('relative time formats Nd/Nh/Nm/Ns ago against injected now (T-AGG-03)', () => {
    const rows = aggregateSessions(
      [{ slug: WS_SLUG, dir: WS }],
      aggDeps({
        listJsonl: () => [
          { id: 'd', mtime: 4000 },
          { id: 'h', mtime: 3000 },
          { id: 'm', mtime: 2000 },
          { id: 's', mtime: 1000 }
        ],
        readMeta: (_slug, id) => {
          const ts = {
            d: '2026-08-06T12:00:00.000Z',
            h: '2026-08-08T09:00:00.000Z',
            m: '2026-08-08T11:55:00.000Z',
            s: '2026-08-08T11:59:30.000Z'
          }[id] as string
          return meta({ timestamp: ts })
        }
      })
    )
    expect(rows.map((r) => r.title)).toEqual(['30s ago', '5m ago', '3h ago', '2d ago'])
  })

  it('flags rows whose recorded cwd no longer exists (T-AGG-05)', () => {
    const gone = '/Users/dev/proj/.claude/worktrees/deleted'
    const rows = aggregateSessions(
      [{ slug: WS_SLUG, dir: WS }],
      aggDeps({
        listJsonl: () => [
          { id: 'ok', mtime: 2000 },
          { id: 'dead', mtime: 1000 }
        ],
        readMeta: (_slug, id) => meta({ cwd: id === 'dead' ? gone : WS }),
        dirExists: (p) => p !== gone
      })
    )
    expect(rows.find((r) => r.id === 'ok')?.invalidCwd).toBe(false)
    expect(rows.find((r) => r.id === 'dead')?.invalidCwd).toBe(true)
  })
})

describe('filterOwned (owned-only sidebar default: external claude runs in the same repo stay hidden until Koloft owns them)', () => {
  const row = (id: string, running: boolean): SessionRow => ({
    id,
    title: 't',
    worktree: 'main',
    cwd: WS,
    running,
    invalidCwd: false,
    mtime: 1
  })

  it('drops a cold row Koloft never drove', () => {
    expect(filterOwned([row('ext', false)], new Set(), new Set())).toEqual([])
  })

  it('keeps owned cold rows and every running row', () => {
    const rows = [row('live', true), row('mine', false)]
    expect(filterOwned(rows, new Set(['mine']), new Set(['live']))).toEqual(rows)
  })
})

describe('hasHistory (D9 greying data: the Restore item greys off exactly what filterOwned drops)', () => {
  const row = (id: string, running = false): SessionRow => ({
    id,
    title: 't',
    worktree: 'main',
    cwd: WS,
    running,
    invalidCwd: false,
    mtime: 1
  })

  it('is false for a workspace with no aggregation at all', () => {
    expect(hasHistory([], new Set(), new Set())).toBe(false)
  })

  it('is false when every row is owned or running', () => {
    expect(hasHistory([row('mine'), row('live', true)], new Set(['mine']), new Set(['live']))).toBe(
      false
    )
  })

  it('is true for a row that is neither owned nor running', () => {
    expect(hasHistory([row('mine'), row('gone')], new Set(['mine']), new Set())).toBe(true)
  })

  it('counts a session Koloft never drove — history is the unfiltered aggregation', () => {
    expect(hasHistory([row('ext')], new Set(), new Set())).toBe(true)
  })
})

describe('resolvePending', () => {
  const twoBuckets: Bucket[] = [
    { slug: WS_SLUG, dir: WS },
    { slug: WT_SLUG, dir: WT }
  ]
  const realRow = (id: string): SessionRow => ({
    id,
    title: 't',
    worktree: 'main',
    cwd: WS,
    running: true,
    invalidCwd: false,
    mtime: 1000
  })

  it('renders an unbound launch as a pending row keyed by its tab id', () => {
    const out = resolvePending(twoBuckets, [{ tabId: 'tab-1', cwd: WS }], [], NOW)
    expect(out.promoted).toEqual([])
    expect(out.rows).toEqual([
      {
        id: 'tab-1',
        title: PENDING_SESSION_TITLE,
        worktree: 'main',
        cwd: WS,
        running: false,
        invalidCwd: false,
        mtime: NOW,
        pending: true
      }
    ])
  })

  it('labels a not-yet-created worktree launch by its target name, not main, so a pull confirm never counts it under main', () => {
    const out = resolvePending(
      twoBuckets,
      [{ tabId: 'tab-w', cwd: WS, worktree: 'bugfix' }],
      [],
      NOW
    )
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).toMatchObject({ id: 'tab-w', worktree: 'bugfix', cwd: WS, pending: true })
  })

  it('lets the reported cwd win over the launch target once the hook binds', () => {
    const out = resolvePending(
      twoBuckets,
      [{ tabId: 'tab-w', cwd: WS, worktree: 'stale-name', reportedCwd: WT }],
      [],
      NOW
    )
    expect(out.rows[0]).toMatchObject({ worktree: 'bugfix', cwd: WT })
  })

  it('labels a worktree launch by its bucket dir, and ignores a cwd outside every bucket', () => {
    const out = resolvePending(
      twoBuckets,
      [
        { tabId: 'tab-wt', cwd: WT },
        { tabId: 'tab-elsewhere', cwd: '/Users/dev/other' }
      ],
      [],
      NOW
    )
    expect(out.rows.map((r) => [r.id, r.worktree])).toEqual([['tab-wt', 'bugfix']])
    expect(out.promoted).toEqual([])
  })

  // CC§2
  it('T-LIFE-01: a bound launch turns into a running placeholder row the moment the hook binds, since no jsonl exists before the first message', () => {
    const launches = [{ tabId: 'tab-1', cwd: WS, sessionId: 's1' }]
    const bound = resolvePending(twoBuckets, launches, [], NOW)
    expect(bound.promoted).toEqual([])
    expect(bound.rows).toEqual([
      {
        id: 's1',
        title: PLACEHOLDER_SESSION_TITLE,
        worktree: 'main',
        cwd: WS,
        running: true,
        invalidCwd: false,
        mtime: NOW
      }
    ])
  })

  it('drops the launch entirely once its jsonl actually shows up as a row', () => {
    const launches = [{ tabId: 'tab-1', cwd: WS, sessionId: 's1' }]
    const done = resolvePending(twoBuckets, launches, [realRow('s1')], NOW)
    expect(done.rows).toEqual([])
    expect(done.promoted).toEqual(['tab-1'])
  })

  it('relabels a bound launch by the worktree its hook reported', () => {
    const out = resolvePending(
      twoBuckets,
      [{ tabId: 'tab-1', cwd: WS, sessionId: 's1', reportedCwd: WT }],
      [],
      NOW
    )
    expect(out.rows).toEqual([
      {
        id: 's1',
        title: PLACEHOLDER_SESSION_TITLE,
        worktree: 'bugfix',
        cwd: WT,
        running: true,
        invalidCwd: false,
        mtime: NOW
      }
    ])
  })

  it('keeps the launch-cwd label when the reported cwd matches no bucket, so a checkout git has not listed yet never blinks out', () => {
    const out = resolvePending(
      twoBuckets,
      [{ tabId: 'tab-1', cwd: WS, sessionId: 's1', reportedCwd: WS + '/.claude/worktrees/fresh' }],
      [],
      NOW
    )
    expect(out.rows.map((r) => [r.worktree, r.cwd])).toEqual([['main', WS]])
  })

  it('never promotes a launch that belongs to another workspace', () => {
    const out = resolvePending(
      [{ slug: WS_SLUG, dir: WS }],
      [{ tabId: 'tab-x', cwd: '/Users/dev/other', sessionId: 's1' }],
      [realRow('s1')],
      NOW
    )
    expect(out).toEqual({ rows: [], promoted: [] })
  })
})

describe('extractJsonlMeta', () => {
  const summaryLine = '{"type":"summary","summary":"Fix parser","leafUuid":"leaf-1"}'
  const userLine = (text: string, extra = ''): string =>
    `{"type":"user","message":{"role":"user","content":${JSON.stringify(text)}}${extra},"cwd":"/ws","timestamp":"2026-08-08T09:00:00.000Z","sessionId":"sid"}`

  it('captures summary, first user text, and cwd/timestamp from the first line carrying them', () => {
    const meta = extractJsonlMeta([
      summaryLine,
      'not json {{{',
      '{"type":"user","isMeta":true,"message":{"role":"user","content":"skill preamble"},"cwd":"/first","timestamp":"2026-08-08T08:00:00.000Z"}',
      userLine('real prompt')
    ])
    expect(meta).toEqual({
      summary: 'Fix parser',
      firstUserText: 'real prompt',
      cwd: '/first',
      timestamp: '2026-08-08T08:00:00.000Z'
    })
  })

  it('reads array-form user content (first text block)', () => {
    const meta = extractJsonlMeta([
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"},{"type":"text","text":"array text"}]},"cwd":"/ws","timestamp":"2026-08-08T09:00:00.000Z"}'
    ])
    expect(meta.firstUserText).toBe('array text')
  })

  it('skips isMeta lines, argless command wrappers, and tool-result-only user lines for the title', () => {
    const meta = extractJsonlMeta([
      userLine('<command-message>clear</command-message><command-name>/clear</command-name>'),
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"out"}]},"cwd":"/ws","timestamp":"2026-08-08T09:01:00.000Z"}',
      userLine('the actual ask')
    ])
    expect(meta.firstUserText).toBe('the actual ask')
  })

  // CC§2
  it('an Esc-interrupt user record never claims firstUserText', () => {
    const meta = extractJsonlMeta([
      userLine('<command-name>/spec</command-name><command-args>build the feature</command-args>'),
      userLine('[Request interrupted by user]'),
      userLine('[Request interrupted by user for tool use]'),
      userLine('the actual ask')
    ])
    expect(meta.firstUserText).toBe('the actual ask')
    expect(meta.commandArgsText).toBe('build the feature')
  })

  it('an argless command fills commandNameText as the last text fallback, matching the live tracker title', () => {
    const meta = extractJsonlMeta([
      userLine(
        '<command-message>release-dmg</command-message><command-name>/release-dmg</command-name>'
      )
    ])
    expect(meta.commandNameText).toBe('/release-dmg')
    expect(meta.firstUserText).toBeUndefined()
  })

  it('a command wrapper WITH args fills commandArgsText, leaving firstUserText to the real ask', () => {
    const meta = extractJsonlMeta([
      userLine('<command-name>/model</command-name><command-args>opus</command-args>'),
      userLine('the actual ask')
    ])
    expect(meta.commandArgsText).toBe('opus')
    expect(meta.firstUserText).toBe('the actual ask')
  })

  it('returns {} when nothing usable appears', () => {
    expect(extractJsonlMeta([])).toEqual({})
    expect(extractJsonlMeta(['garbage', '{"type":"assistant"}'])).toEqual({})
  })

  // CC§2
  it('captures the first ai-title record, the one the live tracker titles rows from', () => {
    const meta = extractJsonlMeta([
      userLine('first prompt'),
      '{"type":"ai-title","aiTitle":"Review project vision"}',
      '{"type":"ai-title","aiTitle":"a later duplicate"}'
    ])
    expect(meta.aiTitle).toBe('Review project vision')
  })

  it('ignores an ai-title record with no usable string', () => {
    const meta = extractJsonlMeta(['{"type":"ai-title","aiTitle":""}', '{"type":"ai-title"}'])
    expect(meta.aiTitle).toBeUndefined()
  })

  it('stops pulling lines once every field is found (streaming contract)', () => {
    let pulled = 0
    function* gen(): Generator<string> {
      const all = [
        summaryLine,
        '{"type":"ai-title","aiTitle":"AI name"}',
        userLine('early prompt'),
        userLine('never needed')
      ]
      for (const l of all) {
        pulled++
        yield l
      }
    }
    const meta = extractJsonlMeta(gen())
    expect(meta.summary).toBe('Fix parser')
    expect(meta.aiTitle).toBe('AI name')
    expect(meta.firstUserText).toBe('early prompt')
    expect(pulled).toBe(3)
  })
})

// CC§2
describe('worktree-state binding (D11): the binding, not the bucket, names the worktree of a root-slug row', () => {
  const WT_STATE = {
    originalCwd: WS,
    worktreePath: WT,
    worktreeName: 'bugfix',
    worktreeBranch: 'worktree-bugfix',
    originalHeadCommit: 'a1b2c3d4'
  }
  const worktreeStateLine = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      type: 'worktree-state',
      worktreeSession: {
        originalCwd: WS,
        preEnterOriginalCwd: WS,
        worktreePath: WT,
        worktreeName: 'bugfix',
        worktreeBranch: 'worktree-bugfix',
        originalBranch: 'main',
        originalHeadCommit: 'a1b2c3d4',
        sessionId: 'inherited-from-predecessor',
        ...over
      }
    })
  const msgLine =
    '{"type":"user","message":{"role":"user","content":"real prompt"},"cwd":"/ws","timestamp":"2026-08-08T09:00:00.000Z"}'

  it('captures the nested binding from a real-shape line', () => {
    expect(extractJsonlMeta([worktreeStateLine(), msgLine]).worktreeState).toEqual(WT_STATE)
  })

  it('drops a worktreeSession missing fields or carrying wrong types, without crashing', () => {
    expect(extractJsonlMeta([worktreeStateLine({ worktreeName: undefined })]).worktreeState).toBe(
      undefined
    )
    expect(extractJsonlMeta([worktreeStateLine({ originalHeadCommit: 42 })]).worktreeState).toBe(
      undefined
    )
    expect(
      extractJsonlMeta(['{"type":"worktree-state","worktreeSession":null}', msgLine]).worktreeState
    ).toBe(undefined)
    expect(extractJsonlMeta(['{"type":"worktree-state"}']).worktreeState).toBe(undefined)
  })

  it('keeps the first binding when a later line rebinds', () => {
    const meta = extractJsonlMeta([
      worktreeStateLine(),
      worktreeStateLine({ worktreeName: 'later', worktreePath: WS + '/.claude/worktrees/later' })
    ])
    expect(meta.worktreeState?.worktreeName).toBe('bugfix')
  })

  // CC§2 CC§4
  it('the tail says where the session is now: the last binding wins, an emptied one means it left', () => {
    const later = worktreeStateLine({
      worktreeName: 'later',
      worktreePath: WS + '/.claude/worktrees/later'
    })
    expect(extractJsonlTail([worktreeStateLine(), later]).worktreeState?.worktreeName).toBe('later')
    expect(
      extractJsonlTail([
        later,
        '{"type":"relocated","sessionId":"s","relocatedCwd":"/ws"}',
        '{"type":"worktree-state","worktreeSession":null,"sessionId":"s"}'
      ])
    ).toEqual({ worktreeState: null, relocatedCwd: '/ws' })
  })

  it('does not extend the early break, so a binding past it is not read: most transcripts have none, and waiting for one would read every file whole', () => {
    const meta = extractJsonlMeta([
      '{"type":"summary","summary":"Fix parser"}',
      '{"type":"ai-title","aiTitle":"AI name"}',
      msgLine,
      worktreeStateLine()
    ])
    expect(meta.summary).toBe('Fix parser')
    expect(meta.firstUserText).toBe('real prompt')
    expect(meta.worktreeState).toBe(undefined)
  })

  it('labels a root-bucket row by the binding name and carries the binding onto the row', () => {
    const rows = aggregateSessions(
      [{ slug: WS_SLUG, dir: WS }],
      aggDeps({
        listJsonl: () => [{ id: 'w1', mtime: 1000 }],
        readMeta: () => meta({ worktreeState: WT_STATE })
      })
    )
    expect(rows[0].worktree).toBe('bugfix')
    expect(rows[0].worktreeState).toEqual(WT_STATE)
  })

  // CC§2
  it("never keys the row off worktreeSession.sessionId, which can be a predecessor's id", () => {
    const boundMeta = extractJsonlMeta([worktreeStateLine({ sessionId: 'someone-else' })])
    const rows = aggregateSessions(
      [{ slug: WS_SLUG, dir: WS }],
      aggDeps({
        listJsonl: () => [{ id: 'file-id', mtime: 1000 }],
        readMeta: () => meta(boundMeta)
      })
    )
    expect(rows.map((r) => r.id)).toEqual(['file-id'])
    expect(rows[0].worktreeState).toEqual(WT_STATE)
  })

  it('leaves pre-v3 labeling untouched when no binding exists (regression)', () => {
    const rows = aggregateSessions(
      [
        { slug: WS_SLUG, dir: WS },
        { slug: WT_SLUG, dir: WT }
      ],
      aggDeps({
        listJsonl: (slug) =>
          slug === WS_SLUG ? [{ id: 'm1', mtime: 2000 }] : [{ id: 'w1', mtime: 1000 }],
        readMeta: (_slug, id) => meta({ cwd: id === 'w1' ? WT : WS })
      })
    )
    expect(rows.map((r) => [r.id, r.worktree])).toEqual([
      ['m1', 'main'],
      ['w1', 'bugfix']
    ])
    expect(rows.every((r) => r.worktreeState === undefined)).toBe(true)
  })

  it('does not let a binding mask a dead cwd', () => {
    const rows = aggregateSessions(
      [{ slug: WS_SLUG, dir: WS }],
      aggDeps({
        listJsonl: () => [{ id: 'w1', mtime: 1000 }],
        readMeta: () => meta({ cwd: WT, worktreeState: WT_STATE }),
        dirExists: (p) => p !== WT
      })
    )
    expect(rows[0].invalidCwd).toBe(true)
  })
})

describe('planRescan', () => {
  const state: RescanState = {
    bucketDirs: [WS, WT],
    workspaceSlugs: [WS_SLUG]
  }

  it('trigger (a): startup and workspace-add always rescan', () => {
    expect(planRescan({ kind: 'startup' }, state)).toBe('rescan')
    expect(planRescan({ kind: 'workspace-add' }, state)).toBe('rescan')
  })

  it('trigger (b): session-start cwd outside known buckets rescans, known cwd does not', () => {
    expect(
      planRescan({ kind: 'session-start', cwd: '/Users/dev/proj/.claude/worktrees/new1' }, state)
    ).toBe('rescan')
    expect(planRescan({ kind: 'session-start', cwd: WS }, state)).toBe('none')
    expect(planRescan({ kind: 'session-start', cwd: WT }, state)).toBe('none')
  })

  it('trigger (c): new projects dir name prefix-matching a workspace slug rescans', () => {
    expect(
      planRescan({ kind: 'projects-dir-added', dirName: `${WS_SLUG}--claude-worktrees-x` }, state)
    ).toBe('rescan')
    expect(planRescan({ kind: 'projects-dir-added', dirName: '-Users-dev-pr-abc123' }, state)).toBe(
      'rescan'
    )
    expect(planRescan({ kind: 'projects-dir-added', dirName: '-Users-dev-unrelated' }, state)).toBe(
      'none'
    )
  })
})
