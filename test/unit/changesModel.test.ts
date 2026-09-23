import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import type { GitNumstatMap, GitStatusMap, SessionInfo } from '../../src/shared/types'
import {
  BIG_DIFF_LINES,
  CHANGES_MSG,
  HIGHLIGHT_LEAD_IN,
  baseArg,
  baseUnresolved,
  buildEntries,
  classifyKind,
  emptyStreamMessage,
  groupByDir,
  isBigDiff,
  mergeSections,
  nearViewport,
  passesFilters,
  sectionsByPath,
  splitAggregateDiff,
  splitHunks,
  stableEntries,
  totalDelta,
  writtenPaths,
  type ChangeEntry,
  type DiffSection
} from '../../src/renderer/src/components/changesModel'
import { DEFAULT_FILTERS, type ChangeFilters } from '../../src/renderer/src/components/filesModel'

const NUL_BYTES_GIT_CALLS_BINARY = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x41])
const LINES_FOR_TWO_SEPARATE_HUNKS = 20

let repo: string
let aggregate: string
let base: string

const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i + 1}`)

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-cv-')))
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
  git('config', 'user.email', 't@t.com')
  git('config', 'user.name', 't')

  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(
    path.join(repo, 'src/mod.ts'),
    lines(LINES_FOR_TWO_SEPARATE_HUNKS).join('\n') + '\n'
  )
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'delete me\n')
  fs.writeFileSync(path.join(repo, 'sp ace.txt'), 'spaced\n')
  fs.writeFileSync(path.join(repo, 'old-name.ts'), 'export const x = 1\nexport const y = 2\n')
  fs.writeFileSync(path.join(repo, 'logo.bin'), NUL_BYTES_GIT_CALLS_BINARY)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  base = git('rev-parse', 'HEAD').trim()

  const edited = lines(LINES_FOR_TWO_SEPARATE_HUNKS)
  edited[1] = 'TWO'
  edited[18] = 'NINETEEN'
  fs.writeFileSync(path.join(repo, 'src/mod.ts'), edited.join('\n') + '\n')
  fs.rmSync(path.join(repo, 'gone.txt'))
  fs.writeFileSync(path.join(repo, 'sp ace.txt'), 'spaced twice\n')
  fs.writeFileSync(path.join(repo, 'logo.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x42]))
  fs.writeFileSync(path.join(repo, 'notes.md'), '# added\n')
  git('mv', 'old-name.ts', 'new-name.ts')
  fs.appendFileSync(path.join(repo, 'new-name.ts'), 'export const z = 3\n')
  git('add', '-A')
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'never in git diff\n')

  aggregate = git('diff', base, '--')
})
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }))

const byRel = (rel: string): DiffSection => {
  const hit = splitAggregateDiff(aggregate).find((s) => s.rel === rel)
  if (!hit) throw new Error(`no section for ${rel} in:\n${aggregate}`)
  return hit
}

describe('splitAggregateDiff over a real `git diff`', () => {
  it('cuts one section per changed file and names each one', () => {
    const rels = splitAggregateDiff(aggregate)
      .map((s) => s.rel)
      .sort()
    expect(rels).toEqual([
      'gone.txt',
      'logo.bin',
      'new-name.ts',
      'notes.md',
      'sp ace.txt',
      'src/mod.ts'
    ])
  })

  it('names a deleted file, which has no `+++` line at all', () => {
    const s = byRel('gone.txt')
    expect(s.text).toContain('+++ /dev/null')
    expect(s.text).toContain('-delete me')
  })

  it('names a file whose path contains a space', () => {
    expect(byRel('sp ace.txt').text).toContain('+spaced twice')
  })

  it('flags the binary file and only the binary file', () => {
    expect(byRel('logo.bin').binary).toBe(true)
    expect(
      splitAggregateDiff(aggregate)
        .filter((s) => s.binary)
        .map((s) => s.rel)
    ).toEqual(['logo.bin'])
  })

  it('pairs a rename with its source and keeps the small edit, not a whole-file add', () => {
    const s = byRel('new-name.ts')
    expect(s.renameFrom).toBe('old-name.ts')
    expect(s.text).not.toContain('new file mode')
    expect(s.text.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))).toEqual([
      '+export const z = 3'
    ])
  })

  it('carries every changed hunk of a multi-hunk file', () => {
    const hunks = splitHunks(byRel('src/mod.ts').text)
    expect(hunks).toHaveLength(2)
    expect(hunks[0].header).toMatch(/^@@ -1,\d+ \+1,\d+ @@/)
    expect(hunks[0].text.startsWith(hunks[0].header)).toBe(true)
    expect(hunks[0].text).toContain('+TWO')
    expect(hunks[1].text).toContain('+NINETEEN')
    expect(hunks[0].text).not.toContain('+NINETEEN')
  })
})

describe('isBigDiff', () => {
  it('folds past the line bound and not below it', () => {
    const line = '+' + 'x'.repeat(40) + '\n'
    expect(isBigDiff(line.repeat(BIG_DIFF_LINES - 5))).toBe(false)
    expect(isBigDiff(line.repeat(BIG_DIFF_LINES + 5))).toBe(true)
  })
})

describe('splitAggregateDiff on shapes git only produces occasionally', () => {
  it('does not mistake diff text inside a hunk for a new section', () => {
    const sections = splitAggregateDiff(
      [
        'diff --git a/patch.md b/patch.md',
        'index 111..222 100644',
        '--- a/patch.md',
        '+++ b/patch.md',
        '@@ -1,2 +1,3 @@',
        ' prose',
        '+diff --git a/evil.ts b/evil.ts',
        '+++ b/evil.ts',
        '-old prose',
        ''
      ].join('\n')
    )
    expect(sections.map((s) => s.rel)).toEqual(['patch.md'])
  })

  it('falls back to the `diff --git` header when a section has no ---/+++ (mode change)', () => {
    const [s] = splitAggregateDiff(
      ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n')
    )
    expect(s.rel).toBe('run.sh')
    expect(splitHunks(s.text)).toEqual([])
  })

  it('keeps the partial tail of a truncated aggregate rather than dropping it', () => {
    const cut = aggregate.slice(0, aggregate.indexOf('@@', aggregate.indexOf('diff --git')) + 40)
    const sections = splitAggregateDiff(cut)
    expect(sections.length).toBeGreaterThan(0)
  })
})

describe('sectionsByPath', () => {
  const sections = (): DiffSection[] => splitAggregateDiff(aggregate)

  it('joins repo-relative section paths onto the absolute paths git status reported', () => {
    const paths = [`${repo}/src/mod.ts`, `${repo}/logo.bin`]
    const map = sectionsByPath(sections(), paths, repo)
    expect(Object.keys(map).sort()).toEqual(paths.sort())
    expect(map[`${repo}/src/mod.ts`].rel).toBe('src/mod.ts')
  })

  it('keeps two files apart when one path is the other with the session root folded in', () => {
    const s = (rel: string): DiffSection => ({
      rel,
      text: `diff --git a/${rel} b/${rel}`,
      binary: false,
      renameFrom: null
    })
    const paths = ['/repo/a/x.ts', '/repo/z/a/x.ts']
    const map = sectionsByPath([s('a/x.ts'), s('z/a/x.ts')], paths, '/repo')
    expect(map['/repo/a/x.ts']?.rel).toBe('a/x.ts')
    expect(map['/repo/z/a/x.ts']?.rel).toBe('z/a/x.ts')
  })

  it('drops a section for a file the status map does not list', () => {
    expect(Object.keys(sectionsByPath(sections(), [`${repo}/src/mod.ts`], repo))).toEqual([
      `${repo}/src/mod.ts`
    ])
  })
})

describe('mergeSections keeps identity for what did not move (FR-58)', () => {
  const s = (text: string): DiffSection => ({ rel: 'a.ts', text, binary: false, renameFrom: null })

  it('returns the previous map itself when nothing changed', () => {
    const prev = { '/w/a.ts': s('one') }
    expect(mergeSections(prev, { '/w/a.ts': s('one') })).toBe(prev)
  })

  it('replaces only the file whose diff moved, reusing the rest', () => {
    const a = s('one')
    const b = { ...s('two'), rel: 'b.ts' }
    const prev = { '/w/a.ts': a, '/w/b.ts': b }
    const next = mergeSections(prev, { '/w/a.ts': s('one'), '/w/b.ts': { ...b, text: 'CHANGED' } })
    expect(next['/w/a.ts']).toBe(a)
    expect(next['/w/b.ts']).not.toBe(b)
    expect(next['/w/b.ts'].text).toBe('CHANGED')
  })

  it('drops a file that left the change set', () => {
    const prev = { '/w/a.ts': s('one'), '/w/b.ts': s('two') }
    expect(Object.keys(mergeSections(prev, { '/w/a.ts': s('one') }))).toEqual(['/w/a.ts'])
  })
})

const ROOT = '/w'
const bin: DiffSection = { rel: 'logo.png', text: '', binary: true, renameFrom: null }

function entries(
  git: GitStatusMap,
  numstat: GitNumstatMap = {},
  sections: Record<string, DiffSection> = {},
  written: string[] = []
): ChangeEntry[] {
  return buildEntries({ git, numstat, root: ROOT, written: new Set(written), sections })
}

describe('buildEntries', () => {
  it('classifies the four special states, and only those, off status + diff (FR-41)', () => {
    const list = entries(
      {
        '/w/a.ts': 'modified',
        '/w/b.ts': 'renamed',
        '/w/c.ts': 'deleted',
        '/w/d.ts': 'conflict',
        '/w/logo.png': 'modified',
        '/w/new.ts': 'untracked'
      },
      {},
      { '/w/logo.png': bin }
    )
    expect(Object.fromEntries(list.map((e) => [e.rel, e.kind]))).toEqual({
      'a.ts': 'text',
      'b.ts': 'renamed',
      'c.ts': 'deleted',
      'd.ts': 'conflict',
      'logo.png': 'binary',
      'new.ts': 'text'
    })
  })

  it('leaves untracked and binary files without a ±N, and keeps everyone else’s (FR-43)', () => {
    const list = entries(
      { '/w/a.ts': 'modified', '/w/new.ts': 'untracked', '/w/logo.png': 'modified' },
      {
        '/w/a.ts': { added: 4, removed: 1 },
        '/w/new.ts': { added: 9, removed: 0 },
        '/w/logo.png': { added: 7, removed: 7 }
      },
      { '/w/logo.png': bin }
    )
    expect(list.find((e) => e.rel === 'a.ts')?.delta).toEqual({ added: 4, removed: 1 })
    expect(list.find((e) => e.rel === 'new.ts')?.delta).toBeNull()
    expect(list.find((e) => e.rel === 'logo.png')?.delta).toBeNull()
  })

  it('sorts by directory then name — root files first — and splits dir from basename', () => {
    const list = entries({
      '/w/src/z.ts': 'modified',
      '/w/a.ts': 'modified',
      '/w/src/a.ts': 'modified',
      '/w/zeta.md': 'modified',
      '/w/docs/x.md': 'modified'
    })
    expect(list.map((e) => e.rel)).toEqual(['a.ts', 'zeta.md', 'docs/x.md', 'src/a.ts', 'src/z.ts'])
    expect(list[3]).toMatchObject({ dir: 'src/', name: 'a.ts' })
  })

  it('marks the files this session wrote (FR-40 ownership)', () => {
    const list = entries({ '/w/a.ts': 'modified', '/w/b.ts': 'modified' }, {}, {}, ['/w/a.ts'])
    expect(list.map((e) => e.wrote)).toEqual([true, false])
  })
})

describe('classifyKind precedence', () => {
  it('lets a conflicted or deleted status outrank a binary diff', () => {
    expect(classifyKind('conflict', bin)).toBe('conflict')
    expect(classifyKind('deleted', bin)).toBe('deleted')
    expect(classifyKind('modified', bin)).toBe('binary')
    expect(classifyKind('modified', undefined)).toBe('text')
  })
})

describe('writtenPaths', () => {
  it('takes the transcript’s wrote-access files only', () => {
    const session = {
      files: [
        { src: '/w/a.ts', label: 'a.ts', access: 'wrote' },
        { src: '/w/b.ts', label: 'b.ts', access: 'read' },
        { src: '/w/c.ts', label: 'c.ts' }
      ]
    } as unknown as SessionInfo
    expect([...writtenPaths(session)]).toEqual(['/w/a.ts'])
    expect(writtenPaths(null).size).toBe(0)
  })
})

describe('passesFilters (FR-40)', () => {
  const list = entries(
    {
      '/w/a.ts': 'modified',
      '/w/ext.ts': 'modified',
      '/w/doc.md': 'modified',
      '/w/page.html': 'modified',
      '/w/gone.txt': 'deleted'
    },
    {},
    {},
    ['/w/a.ts', '/w/doc.md']
  )
  const keep = (f: ChangeFilters): string[] =>
    list.filter((e) => passesFilters(e, f)).map((e) => e.rel)

  it('keeps everything at the defaults', () => {
    expect(keep(DEFAULT_FILTERS)).toHaveLength(5)
  })

  it('ANDs the three groups (WB-C06)', () => {
    expect(keep({ ...DEFAULT_FILTERS, owner: 'session' })).toEqual(['a.ts', 'doc.md'])
    expect(keep({ ...DEFAULT_FILTERS, owner: 'session', type: 'docs' })).toEqual(['doc.md'])
    expect(keep({ ...DEFAULT_FILTERS, status: 'deleted' })).toEqual(['gone.txt'])
  })

  it('counts markdown AND html as docs, everything else as code', () => {
    expect(keep({ ...DEFAULT_FILTERS, type: 'docs' })).toEqual(['doc.md', 'page.html'])
    expect(keep({ ...DEFAULT_FILTERS, type: 'code' })).toEqual(['a.ts', 'ext.ts', 'gone.txt'])
  })
})

describe('groupByDir', () => {
  it('folds each directory run under one header, root files under `/`', () => {
    const list = entries({
      '/w/a.ts': 'modified',
      '/w/src/b.ts': 'modified',
      '/w/src/c.ts': 'modified'
    })
    expect(groupByDir(list).map((g) => [g.label, g.entries.map((e) => e.name)])).toEqual([
      ['/', ['a.ts']],
      ['src', ['b.ts', 'c.ts']]
    ])
  })

  it('keeps a directory’s files together when a subdirectory sorts between them — one group, one key', () => {
    const list = entries({
      '/w/src/a.ts': 'modified',
      '/w/src/lib/x.ts': 'untracked',
      '/w/src/z.ts': 'modified',
      '/w/docs/g.md': 'modified'
    })
    const groups = groupByDir(list)
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.name)])).toEqual([
      ['docs', ['g.md']],
      ['src', ['a.ts', 'z.ts']],
      ['src/lib', ['x.ts']]
    ])
    expect(new Set(groups.map((g) => g.dir)).size).toBe(groups.length)
    expect(groups.flatMap((g) => g.entries)).toEqual(list)
  })
})

describe('totalDelta — the set added up, which no per-file badge can say', () => {
  it('sums every ±N and counts the files that carry none', () => {
    const list = entries(
      {
        '/w/a.ts': 'modified',
        '/w/b.ts': 'modified',
        '/w/new.ts': 'untracked',
        '/w/logo.png': 'modified'
      },
      {
        '/w/a.ts': { added: 4, removed: 1 },
        '/w/b.ts': { added: 10, removed: 6 },
        '/w/new.ts': { added: 9, removed: 0 },
        '/w/logo.png': { added: 7, removed: 7 }
      },
      { '/w/logo.png': bin }
    )
    expect(totalDelta(list)).toEqual({ files: 4, added: 14, removed: 7, noCount: 2 })
  })

  it('answers zero for an empty set rather than throwing at the caller', () => {
    expect(totalDelta([])).toEqual({ files: 0, added: 0, removed: 0, noCount: 0 })
  })

  it('sums exactly what it is handed — the row describes the FILTERED list, not the repo', () => {
    const list = entries(
      { '/w/a.ts': 'modified', '/w/doc.md': 'modified' },
      { '/w/a.ts': { added: 4, removed: 1 }, '/w/doc.md': { added: 2, removed: 2 } }
    )
    const docs = list.filter((e) => passesFilters(e, { ...DEFAULT_FILTERS, type: 'docs' }))
    expect(totalDelta(docs)).toEqual({ files: 1, added: 2, removed: 2, noCount: 0 })
  })

  it('spells out what the numbers leave out, without naming a cause it cannot know', () => {
    expect(CHANGES_MSG.totals({ files: 3, added: 14, removed: 7, noCount: 0 })).toBe(
      '3 files listed · 14 added, 7 removed.'
    )
    expect(CHANGES_MSG.totals({ files: 1, added: 0, removed: 0, noCount: 1 })).toBe(
      '1 file listed · 0 added, 0 removed. 1 of them brings no line count (new, binary, or git gave none).'
    )
    expect(CHANGES_MSG.totals({ files: 4, added: 1, removed: 0, noCount: 3 })).toBe(
      '4 files listed · 1 added, 0 removed. 3 of them bring no line count (new, binary, or git gave none).'
    )
  })
})

describe('stableEntries', () => {
  it('reuses the objects whose file did not move and mints one for the file that did', () => {
    const first = entries(
      { '/w/a.ts': 'modified', '/w/b.ts': 'modified' },
      { '/w/b.ts': { added: 1, removed: 0 } }
    )
    const second = entries(
      { '/w/a.ts': 'modified', '/w/b.ts': 'modified' },
      { '/w/b.ts': { added: 3, removed: 0 } }
    )
    const kept = stableEntries(first, second)
    expect(kept[0]).toBe(first[0])
    expect(kept[1]).not.toBe(first[1])
    expect(kept[1].delta).toEqual({ added: 3, removed: 0 })
  })
})

describe('nearViewport (NFR-01)', () => {
  const view = { top: 100, bottom: 900 }

  it('takes a block that overlaps the viewport', () => {
    expect(nearViewport({ top: 200, bottom: 400 }, view)).toBe(true)
    expect(nearViewport({ top: -5000, bottom: 5000 }, view)).toBe(true)
  })

  it('takes a block within the lead-in on either side, and drops it past that', () => {
    expect(nearViewport({ top: 1290, bottom: 1400 }, view)).toBe(true)
    expect(nearViewport({ top: 1301, bottom: 1400 }, view)).toBe(false)
    expect(nearViewport({ top: -400, bottom: -300 }, view)).toBe(true)
    expect(nearViewport({ top: -600, bottom: -301 }, view)).toBe(false)
  })

  it('drops the far block a full-height diff pushes off the stream (WB-C16 geometry)', () => {
    expect(nearViewport({ top: 100, bottom: 1900 }, view)).toBe(true)
    expect(nearViewport({ top: 350489, bottom: 352289 }, view)).toBe(false)
  })

  it('agrees with the observer margin it shares', () => {
    expect(HIGHLIGHT_LEAD_IN).toBe(400)
    expect(nearViewport({ top: 1000, bottom: 1000 }, { top: 0, bottom: 0 }, 1000)).toBe(true)
    expect(nearViewport({ top: 1001, bottom: 1001 }, { top: 0, bottom: 0 }, 1000)).toBe(false)
  })
})

describe('CHANGES_MSG', () => {
  it('spells §Edge’s four states', () => {
    expect(CHANGES_MSG.empty).toBe('No changes against the base.')
    expect(CHANGES_MSG.notGit).toBe('Not a git repository.')
    expect(CHANGES_MSG.gitFailed).toBe('Repo too large or git unresponsive — retry.')
    expect(CHANGES_MSG.truncated(7)).toBe('Change set too large — showing the first 7 files.')
  })

  it('gives each of FR-41’s special states its own summary line', () => {
    expect(CHANGES_MSG.renamed('old.ts')).toBe('Renamed from old.ts')
    expect(CHANGES_MSG.renamed(null)).toBe('Renamed')
    expect(new Set([CHANGES_MSG.binary, CHANGES_MSG.deleted, CHANGES_MSG.conflict]).size).toBe(3)
  })
})

describe('emptyStreamMessage — never claim "no changes" while an answer is on its way', () => {
  const idle = { done: false, failed: false, notRepo: false, files: 0 }

  it('says loading before anything has answered — a hung git must not read as a clean repo', () => {
    expect(emptyStreamMessage({ entryCount: 0, load: idle })).toBe(CHANGES_MSG.loading)
  })

  it('stays on loading when the aggregate found files but the row list has none yet', () => {
    const secs = splitAggregateDiff(aggregate)
    const noStatusYet: GitStatusMap = {}
    const joined = sectionsByPath(secs, Object.keys(noStatusYet), repo)
    const entries = buildEntries({
      git: noStatusYet,
      numstat: {},
      root: repo,
      written: new Set(),
      sections: joined
    })
    expect(entries).toHaveLength(0)
    expect(Object.keys(joined)).toHaveLength(0)
    expect(secs.length).toBeGreaterThan(0)
    const load = { done: true, failed: false, notRepo: false, files: secs.length }
    expect(emptyStreamMessage({ entryCount: entries.length, load })).toBe(CHANGES_MSG.loading)
  })

  it('answers "no changes" only once both halves agree the set is empty', () => {
    const load = { done: true, failed: false, notRepo: false, files: 0 }
    expect(emptyStreamMessage({ entryCount: 0, load })).toBe(CHANGES_MSG.empty)
  })

  it('says not-a-repo only when main said so (§Edge)', () => {
    const load = { done: true, failed: false, notRepo: true, files: 0 }
    expect(emptyStreamMessage({ entryCount: 0, load })).toBe(CHANGES_MSG.notGit)
  })

  it('a fresh `git init` with no files is an empty repo, not a non-repo', () => {
    const load = { done: true, failed: false, notRepo: false, files: 0 }
    expect(emptyStreamMessage({ entryCount: 0, load })).toBe(CHANGES_MSG.empty)
  })

  it('blames the filters whenever entries exist at all', () => {
    const load = { done: true, failed: false, notRepo: false, files: 4 }
    expect(emptyStreamMessage({ entryCount: 4, load })).toBe(CHANGES_MSG.filtered)
  })
})

describe('baseUnresolved', () => {
  it('waits only while the base is still being resolved — a null base (a repo with no commits) and a real base are both ready', () => {
    expect(baseUnresolved(undefined)).toBe(true)
    expect(baseUnresolved(null)).toBe(false)
    expect(baseUnresolved('abc123')).toBe(false)
  })
})

describe('baseArg (NFR-02)', () => {
  it('forwards a resolved base verbatim — the half NFR-02 and WB-C17 are about', () => {
    expect(baseArg('abc123')).toBe('abc123')
    expect(baseArg('HEAD')).toBe('HEAD')
  })

  it('maps "no base" to a value main reads as self-derive, which is what a fresh repo needs', () => {
    expect(baseArg(null)).toBe('')
    expect(baseArg(undefined)).toBe('')
  })
})
