import { describe, expect, it } from 'vitest'
import type { DirEntry, PreviewItem, SessionInfo } from '../../src/shared/types'
import {
  NO_MATCHES,
  ancestorDirs,
  buildSyn,
  changedDirsOf,
  deltaFor,
  hiddenTouchedUnder,
  hitDir,
  inRoot,
  initialExpansion,
  isOutsideEligible,
  isTasksPath,
  livePath,
  locFor,
  midTruncate,
  outsideFiles,
  persistableExpansion,
  relTo,
  scratchpadEntries,
  sessionIndex,
  truncationNotice
} from '../../src/renderer/src/browseModel'

const ROOT = '/w/proj'
const SCRATCH = '/tmp/claude-501/slug/sess-1/scratchpad'

function wrote(src: string, extra: Partial<PreviewItem> = {}): PreviewItem {
  return { src, label: src.slice(src.lastIndexOf('/') + 1), access: 'wrote', ...extra }
}

function session(files: PreviewItem[], extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    tabId: 't1',
    sessionId: 's1',
    title: 'x',
    cwd: ROOT,
    treeRoot: ROOT,
    jsonlPath: null,
    files,
    alive: true,
    updatedAt: 0,
    ...extra
  } as SessionInfo
}

describe('path helpers', () => {
  it('inRoot matches the root itself and descendants, never a sibling prefix', () => {
    expect(inRoot(ROOT, ROOT)).toBe(true)
    expect(inRoot(ROOT + '/a/b.ts', ROOT)).toBe(true)
    expect(inRoot('/w/proj-other/a.ts', ROOT)).toBe(false)
    expect(inRoot('/tmp/x.md', ROOT)).toBe(false)
  })

  it('relTo strips the root, and leaves outside paths absolute', () => {
    expect(relTo(ROOT + '/src/a.ts', ROOT)).toBe('src/a.ts')
    expect(relTo('/tmp/a.md', ROOT)).toBe('/tmp/a.md')
  })

  it('ancestorDirs walks the parent chain up to and including the root', () => {
    expect(ancestorDirs(ROOT + '/a/b/c.ts', ROOT)).toEqual([ROOT + '/a/b', ROOT + '/a', ROOT])
    expect(ancestorDirs(ROOT + '/c.ts', ROOT)).toEqual([ROOT])
  })

  it('midTruncate keeps head and tail', () => {
    expect(midTruncate('short', 26)).toBe('short')
    const out = midTruncate('a'.repeat(20) + '/' + 'b'.repeat(20), 11)
    expect(out).toHaveLength(11)
    expect(out.startsWith('aaaaa')).toBe(true)
    expect(out.endsWith('bbbbb')).toBe(true)
    expect(out).toContain('…')
  })

  it('locFor is project-relative inside, ~-abbreviated outside, empty at the root', () => {
    expect(locFor(ROOT + '/src/a.ts', ROOT, '/Users/k')).toBe('src')
    expect(locFor(ROOT + '/a.ts', ROOT, '/Users/k')).toBe('')
    expect(locFor('/Users/k/notes/a.md', ROOT, '/Users/k')).toBe('~/notes')
    expect(locFor('/tmp/a.md', ROOT, '/Users/k')).toBe('/tmp')
  })
})

describe('buildSyn', () => {
  it('synthesizes the implicit dirs and sorts dirs before files, case-insensitively', () => {
    const nodes = buildSyn(
      [ROOT + '/z.ts', ROOT + '/Src/b.ts', ROOT + '/src/a.ts', ROOT + '/a.ts'],
      ROOT
    )
    expect(nodes.map((n) => n.name)).toEqual(['Src', 'src', 'a.ts', 'z.ts'])
    const src = nodes.find((n) => n.name === 'src')
    expect(src?.isDir).toBe(true)
    expect(src?.path).toBe(ROOT + '/src')
    expect(src?.children.map((c) => c.name)).toEqual(['a.ts'])
  })

  it('drops paths outside the root and the root itself', () => {
    expect(buildSyn([ROOT, '/elsewhere/a.ts'], ROOT)).toEqual([])
  })

  it('merges two files that share an implicit directory', () => {
    const nodes = buildSyn([ROOT + '/a/b/one.ts', ROOT + '/a/b/two.ts'], ROOT)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].children[0].children.map((c) => c.name)).toEqual(['one.ts', 'two.ts'])
  })
})

describe('hiddenTouchedUnder — FR-47 force-reveal', () => {
  const entries: DirEntry[] = [
    { name: 'src', path: ROOT + '/src', isDir: true },
    { name: 'README.md', path: ROOT + '/README.md', isDir: false }
  ]

  it('keeps only writes whose first segment the listing does not show', () => {
    const touched = [
      ROOT + '/src/a.ts', // visible via `src`
      ROOT + '/dist/bundle.js', // HEAVY, hidden by listDir
      ROOT + '/.env' // gitignored
    ]
    expect(hiddenTouchedUnder(ROOT, entries, touched)).toEqual([
      ROOT + '/dist/bundle.js',
      ROOT + '/.env'
    ])
  })

  it('ignores writes that are not under this directory at all', () => {
    expect(hiddenTouchedUnder(ROOT + '/src', entries, [ROOT + '/other/x.ts'])).toEqual([])
  })
})

describe('FR-46 — tasks/ is never exposed', () => {
  it('matches the scratchpad sibling and a tasks dir inside the scratchpad', () => {
    expect(isTasksPath('/tmp/claude-501/slug/sess-1/tasks', SCRATCH)).toBe(true)
    expect(isTasksPath('/tmp/claude-501/slug/sess-1/tasks/agent.jsonl', SCRATCH)).toBe(true)
    expect(isTasksPath(SCRATCH + '/tasks', SCRATCH)).toBe(true)
    expect(isTasksPath(SCRATCH + '/tasks/deep/a.md', SCRATCH)).toBe(true)
  })

  it('leaves ordinary scratchpad files and lookalike names alone', () => {
    expect(isTasksPath(SCRATCH + '/notes.md', SCRATCH)).toBe(false)
    expect(isTasksPath(SCRATCH + '/tasks-of-mine.md', SCRATCH)).toBe(false)
    expect(isTasksPath('/w/proj/tasks/a.ts', SCRATCH)).toBe(false)
  })

  it('is inert before the session binds a transcript', () => {
    expect(isTasksPath(SCRATCH + '/tasks/a.md', undefined)).toBe(false)
  })

  it('scratchpadEntries drops the tasks node from the listing', () => {
    const entries: DirEntry[] = [
      { name: 'tasks', path: SCRATCH + '/tasks', isDir: true },
      { name: 'plan.md', path: SCRATCH + '/plan.md', isDir: false }
    ]
    expect(scratchpadEntries(entries, SCRATCH).map((e) => e.name)).toEqual(['plan.md'])
    expect(scratchpadEntries(undefined, SCRATCH)).toEqual([])
  })
})

describe('FR-46 — ↗ Outside', () => {
  const allPresent = new Set<string>()

  it('A7 allowlist: md / html / images only', () => {
    expect(isOutsideEligible('/tmp/a.md')).toBe(true)
    expect(isOutsideEligible('/tmp/a.markdown')).toBe(true)
    expect(isOutsideEligible('/tmp/a.html')).toBe(true)
    expect(isOutsideEligible('/tmp/a.htm')).toBe(true)
    expect(isOutsideEligible('/tmp/a.png')).toBe(true)
    expect(isOutsideEligible('/tmp/a.svg')).toBe(true)
    expect(isOutsideEligible('/tmp/a.ts')).toBe(false)
    expect(isOutsideEligible('/tmp/a.pdf')).toBe(false)
    expect(isOutsideEligible('/tmp/a')).toBe(false)
  })

  it('filters by kind, tasks/ and the scratchpad listing at once', () => {
    const out = outsideFiles({
      candidates: [
        wrote('/tmp/notes/a.md'),
        wrote('/tmp/notes/b.ts'),
        wrote(SCRATCH + '/plan.md'),
        wrote('/tmp/claude-501/slug/sess-1/tasks/sub.md')
      ],
      scratchpadDir: SCRATCH,
      scratchListed: new Set([SCRATCH + '/plan.md']),
      missingDirs: allPresent
    })
    expect(out.map((f) => f.src)).toEqual(['/tmp/notes/a.md'])
  })

  it('keeps a scratchpad file the Scratchpad node cannot list — else it is reachable from nowhere', () => {
    const out = outsideFiles({
      candidates: [wrote(SCRATCH + '/dist/report.md')],
      scratchpadDir: SCRATCH,
      scratchListed: new Set(),
      missingDirs: allPresent
    })
    expect(out.map((f) => f.src)).toEqual([SCRATCH + '/dist/report.md'])
  })

  it('a parent directory probed and found gone drops the entry (missing dir hides the node)', () => {
    const input = {
      candidates: [wrote('/tmp/notes/a.md')],
      scratchpadDir: SCRATCH,
      scratchListed: new Set<string>()
    }
    // probed, gone → the whole node empties out
    expect(outsideFiles({ ...input, missingDirs: new Set(['/tmp/notes']) })).toEqual([])
    // probed, present → shown
    expect(outsideFiles({ ...input, missingDirs: allPresent })).toHaveLength(1)
    // a SIBLING directory being gone says nothing about this one
    expect(outsideFiles({ ...input, missingDirs: new Set(['/tmp/other']) })).toHaveLength(1)
  })

  it('an unprobed directory keeps its files — the node must not flicker out on first paint', () => {
    expect(
      outsideFiles({
        candidates: [wrote('/tmp/notes/a.md')],
        scratchpadDir: SCRATCH,
        scratchListed: new Set(),
        missingDirs: new Set()
      })
    ).toHaveLength(1)
  })

  it('existence is a DIRECTORY question, so a gitignored external write still shows', () => {
    // the regression this shape exists to prevent: deriving existence from `listDir`'s
    // membership would run `git check-ignore` and silently drop this file, losing the very
    // artifact ↗ Outside is there to keep reachable
    expect(
      outsideFiles({
        candidates: [wrote('/repo/ignored/note.md')],
        scratchpadDir: SCRATCH,
        scratchListed: new Set(),
        missingDirs: allPresent
      }).map((f) => f.src)
    ).toEqual(['/repo/ignored/note.md'])
  })
})

describe('sessionIndex — FR-47 decoration inputs', () => {
  it('counts writes only, splits in/out of root, and aggregates per directory', () => {
    const idx = sessionIndex(
      session([
        wrote(ROOT + '/src/a.ts', { added: 3, removed: 1 }),
        wrote(ROOT + '/src/b.ts'),
        { src: ROOT + '/src/read-only.ts', label: 'read-only.ts', access: 'read' },
        wrote('/tmp/notes/x.md'),
        wrote(ROOT)
      ]),
      ROOT
    )
    expect([...idx.wrote.keys()]).toEqual([
      ROOT + '/src/a.ts',
      ROOT + '/src/b.ts',
      '/tmp/notes/x.md',
      ROOT
    ])
    expect(idx.touchedInProject).toEqual([ROOT + '/src/a.ts', ROOT + '/src/b.ts'])
    expect(idx.touchedDirCount.get(ROOT + '/src')).toBe(2)
    expect(idx.touchedDirCount.get(ROOT)).toBe(2)
    expect(idx.outsideCandidates.map((f) => f.src)).toEqual(['/tmp/notes/x.md'])
  })

  it('is empty for no session', () => {
    const idx = sessionIndex(null, ROOT)
    expect(idx.touchedInProject).toEqual([])
    expect(idx.outsideCandidates).toEqual([])
  })
})

describe('changedDirsOf', () => {
  it('collects the ancestors of every in-root changed file', () => {
    const dirs = changedDirsOf(
      { [ROOT + '/a/b.ts']: 'modified', '/elsewhere/c.ts': 'modified' },
      ROOT
    )
    expect([...dirs].sort()).toEqual([ROOT, ROOT + '/a'])
  })
})

describe('deltaFor — FR-47 ±N', () => {
  it('prefers numstat over the session estimate', () => {
    expect(
      deltaFor(
        ROOT + '/a.ts',
        { [ROOT + '/a.ts']: { added: 9, removed: 2 } },
        wrote(ROOT + '/a.ts', { added: 1, removed: 1 })
      )
    ).toEqual({ added: 9, removed: 2 })
  })

  it('falls back to the session estimate for files git cannot diff', () => {
    expect(deltaFor(ROOT + '/a.ts', {}, wrote(ROOT + '/a.ts', { added: 4, removed: 0 }))).toEqual({
      added: 4,
      removed: 0
    })
  })

  it('is zero when neither source knows anything', () => {
    expect(deltaFor(ROOT + '/a.ts', {}, undefined)).toEqual({ added: 0, removed: 0 })
  })
})

describe('livePath — the being-written pulse', () => {
  it('follows lastWritten, and only while the session works', () => {
    const files = [wrote(ROOT + '/a.ts')]
    expect(livePath(session(files, { status: 'working', lastWritten: ROOT + '/a.ts' }))).toBe(
      ROOT + '/a.ts'
    )
    expect(
      livePath(session(files, { status: 'idle', lastWritten: ROOT + '/a.ts' }))
    ).toBeUndefined()
    expect(livePath(null)).toBeUndefined()
  })

  it('never follows lastTouched, which also moves on reads', () => {
    expect(
      livePath(session([], { status: 'working', lastTouched: ROOT + '/read.ts' }))
    ).toBeUndefined()
  })
})

describe('FR-45 — search result shaping', () => {
  it('has one no-match string for both modes', () => {
    expect(NO_MATCHES).toBe('No matches')
  })

  it('names the count it is actually showing in the truncation notice', () => {
    expect(truncationNotice(300)).toBe('Showing the first 300 — narrow the query.')
  })

  it('hitDir is the relative directory, empty at the search root', () => {
    expect(hitDir('src/components/a.tsx')).toBe('src/components')
    expect(hitDir('a.tsx')).toBe('')
  })
})

describe('FR-47 — persisted expansion', () => {
  it('persists in-project directories only', () => {
    expect(persistableExpansion([ROOT, ROOT + '/src', SCRATCH, SCRATCH + '/sub'], ROOT)).toEqual([
      ROOT,
      ROOT + '/src'
    ])
  })

  it('always starts with the root expanded, saved list or not', () => {
    expect([...initialExpansion(null, ROOT)]).toEqual([ROOT])
    expect([...initialExpansion([], ROOT)]).toEqual([ROOT])
    expect([...initialExpansion([ROOT + '/src'], ROOT)]).toEqual([ROOT + '/src', ROOT])
  })
})
