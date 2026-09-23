import fs from 'fs'
import path from 'path'
import type { E2EEnv } from './env'
import { assertFixtureDir } from './fixtureGuard'
import { runGit, tryGit } from './gitFixture'

export const LINE42_MARKER = 'KOLOFT_E2E_LINE42_BEACON'

const CHANGEABLE = 7

const BULK_FILES = 6
const BULK_LINES = 900
const MIB_PAST_GITDIFF_64MIB_MAXBUFFER = 70

export const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_1X1_ALT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export interface BaselinePaths {
  gitignore: string
  readme: string
  markdown: string
  html: string
  htm: string
  changeable: string[]
  deepFile: string
  deepDir: string
  ignoredDir: string
  ignoredFile: string
  heavyDir: string
  heavyFile: string
  binary: string
  deletable: string
  renameSource: string
  conflictFile: string
  agentTs: string
  agentMd: string
  agentTsB: string
  bulk: string[]
  huge: string
}

function write(root: string, rel: string, body: string | Buffer): string {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  return abs
}

const BODY_LINES_WIDER_THAN_ONE_HUNK = 40

function tsBody(tag: string, n = BODY_LINES_WIDER_THAN_ONE_HUNK): string {
  return (
    Array.from({ length: n }, (_, i) => `export const ${tag}_${i + 1} = ${i + 1}`).join('\n') + '\n'
  )
}

const REL = {
  gitignore: '.gitignore',
  readme: 'README.koloft.md',
  markdown: 'docs/guide.md',
  html: 'docs/report.html',
  htm: 'docs/report.htm',
  changeable: Array.from({ length: CHANGEABLE }, (_, i) => `src/change-${i + 1}.ts`),
  deepFile: 'lib/deep/nested/beacon.ts',
  deepDir: 'lib/deep/nested',
  ignoredDir: 'secrets',
  ignoredFile: 'secrets/token.txt',
  heavyDir: 'node_modules',
  heavyFile: 'node_modules/pkg/index.js',
  binary: 'assets/logo.png',
  deletable: 'src/legacy.ts',
  renameSource: 'src/oldname.ts',
  conflictFile: 'src/conflict.ts',
  agentTs: 'src/agent-notes.ts',
  agentMd: 'docs/agent-notes.md',
  agentTsB: 'src/agent-notes-b.ts',
  bulk: Array.from({ length: BULK_FILES }, (_, i) => `bulk/part-${i + 1}.ts`),
  huge: 'bulk/huge.txt'
} as const

export function baselinePathsIn(root: string): BaselinePaths {
  const at = (rel: string): string => path.join(root, rel)
  return {
    gitignore: at(REL.gitignore),
    readme: at(REL.readme),
    markdown: at(REL.markdown),
    html: at(REL.html),
    htm: at(REL.htm),
    changeable: REL.changeable.map(at),
    deepFile: at(REL.deepFile),
    deepDir: at(REL.deepDir),
    ignoredDir: at(REL.ignoredDir),
    ignoredFile: at(REL.ignoredFile),
    heavyDir: at(REL.heavyDir),
    heavyFile: at(REL.heavyFile),
    binary: at(REL.binary),
    deletable: at(REL.deletable),
    renameSource: at(REL.renameSource),
    conflictFile: at(REL.conflictFile),
    agentTs: at(REL.agentTs),
    agentMd: at(REL.agentMd),
    agentTsB: at(REL.agentTsB),
    bulk: REL.bulk.map(at),
    huge: at(REL.huge)
  }
}

export function seedBrowseTree(dir: string): BaselinePaths {
  assertFixtureDir('seedBrowseTree', dir)
  const root = fs.realpathSync(dir)
  const w = (rel: string, body: string | Buffer): string => write(root, rel, body)

  // PLATFORM§30
  w(REL.gitignore, 'node_modules/\nsecrets/\n*.log\n.claude/worktrees/\nNOTES.md\n')
  w(REL.readme, '# files fixture\n\nBaseline for the Files phase.\n')
  w(
    REL.markdown,
    '# Guide\n\n' +
      Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of the guide fixture.`).join(
        '\n\n'
      ) +
      '\n'
  )
  w(
    REL.html,
    '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>Koloft report fixture</title>\n' +
      '</head>\n<body>\n<h1 id="top">koloft-e2e-report-html</h1>\n' +
      '<p>A page the Files tab must open as a web tab, never as source.</p>\n</body>\n</html>\n'
  )
  w(
    REL.htm,
    '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>Koloft legacy fixture</title>\n' +
      '</head>\n<body>\n<h1>koloft-e2e-report-htm</h1>\n</body>\n</html>\n'
  )
  REL.changeable.forEach((rel, i) => w(rel, tsBody(`change${i + 1}`)))
  const beacon = Array.from({ length: 60 }, (_, i) => `export const beacon_${i + 1} = ${i + 1}`)
  beacon[41] = `export const beacon_42 = '${LINE42_MARKER}'`
  w(REL.deepFile, beacon.join('\n') + '\n')
  w(REL.ignoredFile, 'koloft-e2e-secret\n')
  w(REL.heavyFile, 'module.exports = 1\n')
  w(REL.binary, Buffer.from(PNG_1X1, 'base64'))
  w(REL.deletable, tsBody('legacy'))
  w(REL.renameSource, tsBody('oldname'))
  w(REL.conflictFile, tsBody('conflict'))
  w(REL.agentTs, tsBody('agentNotes'))
  w(REL.agentTsB, tsBody('agentNotesB'))
  w(REL.agentMd, '# Agent notes\n\nBaseline body.\n')
  REL.bulk.forEach((rel, i) => w(rel, tsBody(`part${i + 1}`, BULK_LINES)))
  w(REL.huge, 'seed\n')

  return baselinePathsIn(root)
}

export interface SpecialStates {
  renamed: { from: string; to: string }
  binary: string
  deleted: string
  conflicted: string
}

export interface MixedOwnershipSet {
  external: string
  deleted: string
  agentTs: string
  agentTsRel: string
  agentMd: string
  agentMdRel: string
}

export interface ChangeFixture {
  root: string
  paths: BaselinePaths
  rel(abs: string): string
  git(...args: string[]): string
  base(): string
  head(): string
  isClean(): boolean
  unmergedPaths(): string[]
  commitAll(message?: string): void

  modifyTracked(n?: number): string[]
  modifyMarkdown(): string
  modifyHtml(): string
  editTracked(abs: string): string
  addUntracked(rel?: string): string
  changeBinary(): string
  deleteTracked(abs?: string): string
  renameWithEdit(): { from: string; to: string }
  mergeConflict(): { file: string; branch: string }
  specialStates(): SpecialStates
  featureBranch(name?: string): { branch: string; committed: string; uncommitted: string }
  mixedOwnershipSet(): MixedOwnershipSet
  bigChange(): string[]
  overflowAggregateDiff(targetMiB?: number): string
}

export function setupChangeFixture(dir: string): ChangeFixture {
  const paths = seedBrowseTree(dir)
  const root = fs.realpathSync(dir)
  const git = (...args: string[]): string => runGit(root, ...args)

  git('init', '-q', '.')
  git('add', '-A')
  git('commit', '-q', '-m', 'baseline')

  const bumps = new Map<string, number>()
  const bump = (abs: string): number => {
    const n = (bumps.get(abs) ?? 0) + 1
    bumps.set(abs, n)
    return n
  }

  const editOneLine = (abs: string, index: number): string => {
    const lines = fs.readFileSync(abs, 'utf8').split('\n')
    const at = Math.min(index, Math.max(0, lines.length - 2))
    lines[at] = `${lines[at]} // koloft-e2e-edit-${bump(abs)}`
    fs.writeFileSync(abs, lines.join('\n'))
    return abs
  }

  const defaultBranch = (): string => {
    for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
      try {
        git('rev-parse', '--verify', '--quiet', ref)
        return ref
      } catch {}
    }
    return 'HEAD'
  }

  const fx: ChangeFixture = {
    root,
    paths,
    rel: (abs) => path.relative(root, abs),
    git,
    base: () => git('merge-base', 'HEAD', defaultBranch()).trim(),
    head: () => git('rev-parse', 'HEAD').trim(),
    isClean: () => git('status', '--porcelain').trim() === '',
    unmergedPaths: () => [
      ...new Set(
        git('ls-files', '-u')
          .split('\n')
          .filter(Boolean)
          .map((l) => l.split('\t')[1])
      )
    ],
    commitAll(message = 'fixture') {
      git('add', '-A')
      git('commit', '-q', '-m', message)
    },

    modifyTracked(n = 5) {
      const picked = paths.changeable.slice(0, n)
      if (picked.length < n) {
        throw new Error(
          `modifyTracked(${n}): the baseline only carries ${CHANGEABLE} change-N.ts files`
        )
      }
      return picked.map((abs) => editOneLine(abs, 20))
    },
    modifyMarkdown() {
      const lines = fs.readFileSync(paths.markdown, 'utf8').split('\n')
      lines[6] = `Paragraph 3 of the guide fixture, edited (koloft-e2e-md-${bump(paths.markdown)}).`
      fs.writeFileSync(paths.markdown, lines.join('\n'))
      return paths.markdown
    },
    modifyHtml() {
      const body = fs.readFileSync(paths.html, 'utf8')
      fs.writeFileSync(
        paths.html,
        body.replace('koloft-e2e-report-html', `koloft-e2e-report-html-${bump(paths.html)}`)
      )
      return paths.html
    },
    editTracked(abs) {
      return editOneLine(abs, 10)
    },
    addUntracked(rel = 'src/brand-new.ts') {
      return write(root, rel, tsBody('brandNew', 12))
    },
    changeBinary() {
      fs.writeFileSync(paths.binary, Buffer.from(PNG_1X1_ALT, 'base64'))
      return paths.binary
    },
    deleteTracked(abs = paths.deletable) {
      fs.rmSync(abs)
      return abs
    },
    renameWithEdit() {
      const to = path.join(path.dirname(paths.renameSource), 'newname.ts')
      git('mv', fx.rel(paths.renameSource), path.relative(root, to))
      editOneLine(to, 10)
      return { from: paths.renameSource, to }
    },

    mergeConflict() {
      const branch = 'conflict-side'
      const relPath = fx.rel(paths.conflictFile)
      const at = 4
      const sideways = (text: string): void => {
        const lines = fs.readFileSync(paths.conflictFile, 'utf8').split('\n')
        lines[at] = text
        fs.writeFileSync(paths.conflictFile, lines.join('\n'))
      }
      const onBranch = git('rev-parse', '--abbrev-ref', 'HEAD').trim()
      git('checkout', '-q', '-b', branch)
      sideways('export const conflict_5 = 555 // theirs')
      git('commit', '-q', '-am', 'conflict: their edit')
      git('checkout', '-q', onBranch)
      sideways('export const conflict_5 = 999 // ours')
      git('commit', '-q', '-am', 'conflict: our edit')
      const merged = tryGit(root, 'merge', '--no-edit', branch)
      if (merged.ok)
        throw new Error('mergeConflict: the merge succeeded — no conflict was produced')
      if (!fx.unmergedPaths().includes(relPath)) {
        throw new Error(`mergeConflict: ${relPath} is not unmerged after the failed merge`)
      }
      return { file: paths.conflictFile, branch }
    },

    specialStates() {
      const conflicted = fx.mergeConflict().file
      const renamed = fx.renameWithEdit()
      const binary = fx.changeBinary()
      const deleted = fx.deleteTracked()
      return { renamed, binary, deleted, conflicted }
    },

    featureBranch(name = 'feature/files') {
      git('checkout', '-q', '-b', name)
      const committed = editOneLine(paths.changeable[0], 6)
      git('commit', '-q', '-am', 'C1: committed on the branch')
      const uncommitted = editOneLine(paths.changeable[1], 20)
      return { branch: name, committed, uncommitted }
    },

    mixedOwnershipSet() {
      return {
        external: editOneLine(paths.changeable[0], 20),
        deleted: fx.deleteTracked(),
        agentTs: paths.agentTs,
        agentTsRel: fx.rel(paths.agentTs),
        agentMd: paths.agentMd,
        agentMdRel: fx.rel(paths.agentMd)
      }
    },

    bigChange() {
      return paths.bulk.map((abs, i) => {
        fs.writeFileSync(abs, tsBody(`part${i + 1}rewritten`, BULK_LINES))
        return abs
      })
    },

    overflowAggregateDiff(targetMiB = MIB_PAST_GITDIFF_64MIB_MAXBUFFER) {
      const chunk =
        Array.from({ length: 1000 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n') + '\n'
      const reps = Math.ceil((targetMiB * 1024 * 1024) / Buffer.byteLength(chunk))
      const fd = fs.openSync(paths.huge, 'w')
      try {
        for (let i = 0; i < reps; i++) fs.writeSync(fd, chunk)
      } finally {
        fs.closeSync(fd)
      }
      return paths.huge
    }
  }
  return fx
}

export interface OutsideFixture {
  dir: string
  md: string
  html: string
  png: string
  ts: string
  all: string[]
  remove(): void
}

export function seedOutsideDir(env: E2EEnv, name = 'outside-notes'): OutsideFixture {
  const dir = path.join(env.home, name)
  fs.mkdirSync(dir, { recursive: true })
  assertFixtureDir('seedOutsideDir', dir)
  const md = write(dir, 'report.md', '# Outside report\n\nkoloft-e2e-outside-md\n')
  const html = write(
    dir,
    'page.html',
    '<!doctype html>\n<html><head><meta charset="utf-8"><title>Koloft outside fixture</title></head>\n' +
      '<body><h1>koloft-e2e-outside-html</h1></body></html>\n'
  )
  const png = write(dir, 'shot.png', Buffer.from(PNG_1X1, 'base64'))
  const ts = write(dir, 'helper.ts', tsBody('outsideHelper', 8))
  return {
    dir,
    md,
    html,
    png,
    ts,
    all: [md, html, png, ts],
    remove: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}
