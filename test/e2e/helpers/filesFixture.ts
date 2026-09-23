import fs from 'fs'
import path from 'path'
import type { E2EEnv } from './env'
import { assertFixtureDir } from './fixtureGuard'
import { runGit, tryGit } from './gitFixture'

/**
 * The Files-phase fixture kit.
 *
 * Every one of those cases opens with a `Setup:` line describing a repo SHAPE — five
 * modified files, a branch whose committed work is invisible `vs HEAD`, four special
 * states in one tree, a change set too big for the aggregate diff's buffer. This file
 * makes each of those one call.
 *
 * Two rules it is written under, both borrowed from helpers/gitFixture.ts:
 *  - hermetic by construction. Nothing reads the developer's gitconfig (`runGit` pins the
 *    identity and the default branch per invocation), nothing touches the network, and
 *    `assertFixtureDir` refuses any dir outside the test's temp home — the guard issue
 * exists for.
 *  - real git state, never a hand-written imitation. The merge conflict below is produced
 *    by an actual failing `git merge`, because `git status` has to REPORT the unmerged
 *    index; conflict markers typed into a file would leave the repo clean and the case
 *    would pass against a build that reads nothing.
 *
 * Composability: `setupChangeFixture` seeds the whole baseline tree in ONE commit and the
 * builders only apply CHANGES on top. That is what makes them order-independent — a spec
 * asks for exactly the change-set shape it needs and unmodified baseline files simply do
 * not appear in the change set. The two exceptions are called out on their own docs
 * (`mergeConflict` needs a clean index; it and `featureBranch` cannot share a repo).
 */

// ---- the baseline tree ------------------------------------------------------------------

/** WB-B03's content-search target: the ONLY occurrence in the whole fixture tree, and it
 *  sits on line 42 of `paths.deepFile` — so "jump to the hit's line" has an exact oracle. */
export const LINE42_MARKER = 'KOLOFT_E2E_LINE42_BEACON'

/** How many `src/change-N.ts` files the baseline carries — the pool `modifyTracked` draws
 *  from (WB-C01 wants 5, WB-C10 wants 6 counting the two docs). */
const CHANGEABLE = 7

/** WB-C16 wants an aggregate change over 5000 lines. Six fully-rewritten 900-line files
 *  clear it on EVERY counting convention (5400 added, 5400 removed, 10800 diff lines) —
 *  a set sized to "just over 5000 added+removed" would fail against a reader that counts
 *  only additions. */
const BULK_FILES = 6
const BULK_LINES = 900

/** A 1×1 PNG, and a DIFFERENT 1×1 PNG, as base64. Both are genuinely valid images (an
 *  image view can render them) and genuinely binary to git (NUL bytes in the header),
 *  which is what makes `changeBinary` a real `Binary files … differ` diff rather than a
 *  text one. Exported because the virtual-root seeders in helpers/workbench.ts need the
 *  same bytes. */
export const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_1X1_ALT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** Absolute paths of every baseline entry, so a spec never spells a fixture path itself
 *  (and a rename here is one edit, not a hunt through six spec files). */
export interface BaselinePaths {
  gitignore: string
  readme: string
  /** WB-C02 / WB-B09: a TRACKED markdown file, so a change to it is a diff and not an add */
  markdown: string
  /** WB-R09 / WB-B08: a real page — clicking it in Files must open a `web` tab */
  html: string
  /** WB-R09: the `.htm` spelling, which routes the same way */
  htm: string
  /** WB-C01 / WB-C03 / WB-C10: the modification pool, in strip order (`change-1` … `-7`;
   *  single digits, so alphabetical order IS numeric order in the left column) */
  changeable: string[]
  /** WB-B01 / WB-B03 / WB-B06 / WB-P06: three levels down, and the file carrying
   *  LINE42_MARKER on line 42 */
  deepFile: string
  deepDir: string
  /** WB-B01: a directory `.gitignore` hides, and WB-B05's "agent wrote a gitignored file" */
  ignoredDir: string
  ignoredFile: string
  /** WB-B01: dropped (while the switch is off) by fileTree's HEAVY set, a different mechanism from .gitignore */
  heavyDir: string
  heavyFile: string
  /** WB-C07 / WB-C08 */
  binary: string
  /** WB-C06 / WB-C07's deletion target */
  deletable: string
  /** WB-C07's `git mv` source */
  renameSource: string
  /** WB-C07's merge-conflict target */
  conflictFile: string
  /** WB-C06 / WB-C15: files the SESSION writes (via fake-claude's `/write`), tracked with
   *  baseline content so the write reads as a modification rather than an add */
  agentTs: string
  agentMd: string
  /** WB-C15's second session's file */
  agentTsB: string
  /** WB-C16's rewrite pool */
  bulk: string[]
  /** WB-C11's overflow carrier — a one-line seed until `overflowAggregateDiff` grows it */
  huge: string
}

function write(root: string, rel: string, body: string | Buffer): string {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  return abs
}

/** `n` numbered lines of plausible TypeScript. 40 by default: wide enough that git's
 *  3-line default context (a ~7-line hunk) and WB-C03's ⤢ full context (the whole file)
 *  are unmistakably different sizes. */
function tsBody(tag: string, n = 40): string {
  return (
    Array.from({ length: n }, (_, i) => `export const ${tag}_${i + 1} = ${i + 1}`).join('\n') + '\n'
  )
}

/** The baseline tree's layout, as repo-relative paths. One table, so the writer below and
 *  the path map below THAT can never drift apart. */
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

/**
 * Where the baseline tree's files WOULD be under `root`, writing nothing.
 *
 * WB-C15 is why this is separate from the writer: two sessions share one worktree, so the
 * spec seeds the repo once and then needs the same path map re-based onto the linked
 * checkout `gitWorktreeAdd` produced (git puts the committed tree there itself — nothing
 * needs writing a second time).
 */
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

/**
 * Write the baseline tree — the shape BOTH halves of the Files phase read: Browse's
 * nesting / ignore / heavy-dir cases and Changes' modification pool.
 *
 * No git at all, which is exactly what WB-C13 ("workspace points at a non-git folder": Changes
 * reports "not a git repository", Browse lists as usual) needs, and what WB-P06's
 * untouched second workspace needs. `setupChangeFixture` calls it and then commits.
 *
 * Safe over an existing directory: it only adds files, so the fixture workspaces
 * helpers/env.ts already seeds (ws-a's `docs/page.html`, `notes.xyz`, …) survive — the
 * names here are deliberately distinct from those so nothing is overwritten.
 */
export function seedBrowseTree(dir: string): BaselinePaths {
  assertFixtureDir('seedBrowseTree', dir)
  const root = fs.realpathSync(dir)
  const w = (rel: string, body: string | Buffer): string => write(root, rel, body)

  // `secrets/` is hidden by git, `node_modules/` by fileTree's own HEAVY set — WB-B01
  // asserts both, and only two different mechanisms can tell them apart.
  //
  // `.claude/worktrees/` is ignored for a third reason, copied from Koloft's own .gitignore:
  // `gitWorktreeAdd` puts a linked checkout there, and git does NOT self-ignore it — so
  // without this line a spec that adds a worktree (WB-C15) silently gains an untracked
  // `.claude/` in the PARENT repo's change set, and WB-C12's clean repo stops being clean.
  //
  // `NOTES.md` is ignored for a FOURTH reason, and it is the only entry here about the
  // harness rather than about a repo: every fake-claude session writes one into its cwd at
  // SessionStart (fixtures/fake-claude.js:505, a real Write tool_use in the startup turn).
  // So any session started in this fixture carries an extra changed file that belongs to
  // the test binary and not to the case — WB-C01 asks for five files and the screen would
  // show six, and WB-C10's badge case is ABOUT the number. It has to be in the BASELINE
  // COMMIT, not appended later: `--exclude-standard` honours an uncommitted .gitignore
  // fine, but the .gitignore would then itself be a modified row in the change set.
  //
  // Browse consequence, deliberate: an ignored file the session WROTE is force-revealed by
  // FR-47, so NOTES.md stays visible in the tree exactly as before and only its
  // `data-forced` flag changes. Nothing is hidden from Browse by this line.
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
  // 60 lines so line 42 exists; the marker is written once in the whole tree, which is
  // what lets WB-B03 assert "one hit, on that line"
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

// ---- the change-set builders --------------------------------------------------------------

export interface SpecialStates {
  /** the `git mv` target, carrying a small edit (WB-C07: its expanded diff must be tiny) */
  renamed: { from: string; to: string }
  binary: string
  deleted: string
  conflicted: string
}

export interface MixedOwnershipSet {
  /** already modified by this fixture — the "changed by something other than the session" leg */
  external: string
  /** already deleted by this fixture */
  deleted: string
  /** NOT written yet: hand `agentTsRel` to fake-claude's `/write` so the transcript
   *  records the session as the author (that is what FR-40's ownership filter reads) */
  agentTs: string
  agentTsRel: string
  agentMd: string
  agentMdRel: string
}

export interface ChangeFixture {
  /** the repo root, realpath'd — the same spelling the app works in */
  root: string
  paths: BaselinePaths
  /** repo-relative form of an absolute fixture path, for `/write <rel>` and for asserting
   *  a row's label */
  rel(abs: string): string
  /** run git in the repo (escape hatch for a shape this kit does not cover) */
  git(...args: string[]): string
  /** the commit the app will measure against: `merge-base HEAD <default branch>`, i.e. what
   *  `gitStatus.diffBase` resolves. WB-K08's `isAggregateDiff` argv check needs it. */
  base(): string
  head(): string
  /** `git status --porcelain` is empty — WB-C12's precondition, asserted rather than assumed */
  isClean(): boolean
  /** the paths git itself reports as unmerged. The fixture's OWN guarantee for WB-C07:
   *  independent of whatever the panel decides to show, this proves the repo really is
   *  mid-conflict. */
  unmergedPaths(): string[]
  commitAll(message?: string): void

  /** WB-C01 (5) / WB-C03 (2) / WB-C10 (4 + the two docs): `n` tracked .ts files, ONE hunk
   *  each, in left-column order. */
  modifyTracked(n?: number): string[]
  /** WB-C02 / WB-B09: the tracked markdown, one hunk — a changed `.md` that the stream
   *  must show as a diff, never as rendered prose. */
  modifyMarkdown(): string
  /** WB-C10 / WB-C06: the tracked `.html`, so the "docs only" chip (md + html) has two
   *  members and the chip is not tautological. */
  modifyHtml(): string
  /** WB-C09 / WB-B05: edit one named tracked file the way an external script would. Each
   *  call writes different content, so a repeat really is a new change for the watcher. */
  editTracked(abs: string): string
  /** WB-C08: a brand-new uncommitted file — present in `ls-files --others`, absent from
   *  every `git diff`, which is exactly why it can carry no ±N. */
  addUntracked(rel?: string): string
  /** WB-C07 / WB-C08: rewrite the tracked PNG's bytes. */
  changeBinary(): string
  /** WB-C06 / WB-C07: delete a tracked file (leaving the deletion uncommitted). */
  deleteTracked(abs?: string): string
  /** WB-C07: `git mv` plus a one-line edit, so rename detection pairs them (~R097) and the
   *  expanded diff is a couple of lines rather than a whole-file add. */
  renameWithEdit(): { from: string; to: string }
  /** WB-C07: a REAL unresolved merge — two branches editing the same line, then a `git
   *  merge` that fails. See the doc on the implementation for the ordering it imposes. */
  mergeConflict(): { file: string; branch: string }
  /** WB-C07 in one call: all four special states, in the only order git permits. */
  specialStates(): SpecialStates
  /** WB-C04: a branch with one COMMITTED change plus one uncommitted one, so `merge-base`
   *  lists two files and `vs HEAD` lists one. */
  featureBranch(name?: string): { branch: string; committed: string; uncommitted: string }
  /** WB-C06 / WB-C15: the mixed ownership set, minus the two writes only the session can
   *  make (drive those with `/write`). */
  mixedOwnershipSet(): MixedOwnershipSet
  /** WB-C16: an aggregate change over 5000 lines, spread over enough files that some start
   *  far outside the viewport. */
  bigChange(): string[]
  /** WB-C11: a change too big for the aggregate diff's 64 MiB maxBuffer. SLOW-ish — see
   *  the implementation's cost note. */
  overflowAggregateDiff(targetMiB?: number): string
}

/**
 * A repo whose whole tree is committed and clean, plus the builders that dirty it.
 *
 * Unlike `setupGitFixture`, this does NOT write layout.json: the Files cases run in the
 * workspaces helpers/env.ts already pinned, so a spec calls
 * `setupChangeFixture(env.workspaces.a)` and everything else stays as it was.
 *
 * The freshly-returned state IS WB-C12's clean repo (`isClean()` proves it) — the ignored
 * dir and `node_modules` are covered by the committed `.gitignore`, so nothing lingers as
 * untracked.
 *
 * Fast: ~20 small files plus six 900-line ones, one commit. Only `overflowAggregateDiff`
 * costs real time.
 */
export function setupChangeFixture(dir: string): ChangeFixture {
  const paths = seedBrowseTree(dir)
  const root = fs.realpathSync(dir)
  const git = (...args: string[]): string => runGit(root, ...args)

  git('init', '-q', '.')
  git('add', '-A')
  git('commit', '-q', '-m', 'baseline')

  // each editTracked on the same file must differ from the last, or the second write is a
  // no-op the fs watcher never reports
  const bumps = new Map<string, number>()
  const bump = (abs: string): number => {
    const n = (bumps.get(abs) ?? 0) + 1
    bumps.set(abs, n)
    return n
  }

  /** Replace ONE line, keeping the file's length — a single hunk, and (for a renamed file)
   *  a similarity score high enough that git still pairs it with its source. */
  const editOneLine = (abs: string, index: number): string => {
    const lines = fs.readFileSync(abs, 'utf8').split('\n')
    const at = Math.min(index, Math.max(0, lines.length - 2))
    lines[at] = `${lines[at]} // koloft-e2e-edit-${bump(abs)}`
    fs.writeFileSync(abs, lines.join('\n'))
    return abs
  }

  const defaultBranch = (): string => {
    // mirrors gitStatus.defaultBranch's fallback ladder; with no remote in these fixtures
    // it always lands on the local default the GIT_ID config pins
    for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
      try {
        git('rev-parse', '--verify', '--quiet', ref)
        return ref
      } catch {
        // not present — try the next
      }
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
      // line 21 of 40: the hunk lands mid-file, so the 3-line context window is entirely
      // interior and WB-C03's ⤢ has something to widen in both directions
      return picked.map((abs) => editOneLine(abs, 20))
    },
    modifyMarkdown() {
      // index 6 is the third paragraph (blank lines alternate) — mid-document, so the hunk
      // has prose context on both sides and a "was it rendered or diffed?" assertion has
      // surrounding lines to look at
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

    /**
     * Two branches editing the SAME line, then a merge that really fails.
     *
     * It has to be built this way — not by writing `<<<<<<<` into a file — because the
     * unmerged state lives in git's INDEX: only a failed merge makes `git status` answer
     * `UU`, and a hand-markered file leaves a repo git calls merely modified.
     *
     * Ordering it imposes, both from git itself:
     *  - it needs a clean index, so call it BEFORE the working-tree builders (`specialStates`
     *    already does);
     *  - `featureBranch` cannot follow it — git refuses `checkout -b` while a merge is
     *    unresolved. The two shapes belong to different cases (WB-C07 vs WB-C04) and no case
     *    needs both.
     */
    mergeConflict() {
      const branch = 'conflict-side'
      const relPath = fx.rel(paths.conflictFile)
      const at = 4 // both sides edit line 5, which is what makes the merge unresolvable
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
      // the conflict goes first and alone: it commits and merges, and git will not do either
      // with the rename/delete already sitting in the working tree
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
      // C2 stays in the working tree, so `vs HEAD` sees only this one while the
      // merge-base default sees both
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
      // every line of every bulk file changes, so the aggregate carries 5400 additions and
      // 5400 deletions — over 5000 whichever half a reader counts
      return paths.bulk.map((abs, i) => {
        fs.writeFileSync(abs, tsBody(`part${i + 1}rewritten`, BULK_LINES))
        return abs
      })
    },

    /**
     * Grow the tracked `bulk/huge.txt` past the 64 MiB `maxBuffer` gitDiff caps its stdout
     * with, so the overflow — and therefore the `truncated` flag and its banner — is real.
     *
     * Cost, on this machine: ~50 ms to generate 70 MiB and ~300 ms per
     * `git diff` over it. Cheap to BUILD; what a spec must budget for is the app side —
     * every Changes refresh re-runs that diff and then ships ~64 MiB of text over IPC into
     * the renderer. Budget several seconds and call `test.slow()`.
     *
     * Additions only (the file grows from a one-line seed) because that is the cheapest way
     * to reach the threshold: a rewrite would need half the bytes on disk but emits both a
     * `-` and a `+` line for each, and costs git a real diff instead of an append.
     */
    overflowAggregateDiff(targetMiB = 70) {
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

// ---- ↗ Outside, the second virtual root (WB-B04) --------------------------------------------
//
// Its sibling ⌗ Scratchpad needs a session id and Claude's project-slug encoding, so
// `seedScratchpad` lives in helpers/workbench.ts beside the other session-scoped seeders —
// which keeps THIS file free of the `@playwright/test` chain p1.ts pulls in, and so
// unit-testable (test/unit/filesFixture.test.ts).

export interface OutsideFixture {
  dir: string
  /** the three previewable kinds ↗ Outside is allowed to list */
  md: string
  html: string
  png: string
  /** the kind it must NOT list, even though the session wrote it (a locked A7 consequence) */
  ts: string
  /** repo-external absolute paths, ready for `/write <abs>` — which is what puts them in
   *  the session's file map, and only a session-written file reaches ↗ Outside at all */
  all: string[]
  /** the missing-directory branch */
  remove(): void
}

/**
 * A directory OUTSIDE every workspace root, holding one file of each kind ↗ Outside
 * discriminates on (WB-B04).
 *
 * It sits directly under the test's `$HOME`, beside `ws-a` / `ws-b` rather than inside
 * either, so `inProj` is false for every file here — that is the only reason they qualify
 * for the Outside root. Nothing appears there until the SESSION writes them, so a spec
 * hands `all` (or the individual absolute paths) to fake-claude's `/write`.
 */
export function seedOutsideDir(env: E2EEnv, name = 'outside-notes'): OutsideFixture {
  const dir = path.join(env.home, name)
  fs.mkdirSync(dir, { recursive: true })
  // no git runs here, but `remove()` is a recursive rm — the same guard, for the same
  // reason  gave it to the git helpers
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
