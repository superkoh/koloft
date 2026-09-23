import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { listDir, search as treeSearch, searchContent } from '../../src/main/fileTree'

// A real git repo so searchContent's grep backends run for real.
let repo: string
beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-ft-')))
  const git = (...args: string[]): void => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  spawnSync('git', ['init', '-q', repo])
  git('config', 'user.email', 't@t.com')
  git('config', 'user.name', 't')
  // line 1 has NO colon; line 2 has a colon INSIDE the matched text.
  fs.writeFileSync(path.join(repo, 'f.txt'), 'alpha match one\nbeta:gamma match two\n')
  git('add', 'f.txt')
})
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }))

async function search(
  query: string,
  forceGitGrep: boolean
): Promise<{ line: number; text: string }[]> {
  const saved = process.env.PATH
  // git present here, rg absent → rgLines() returns null → the gitGrepLines() fallback
  if (forceGitGrep) process.env.PATH = '/usr/bin:/bin'
  try {
    const { hits } = await searchContent(repo, query)
    return hits.map((h) => ({ line: h.line, text: h.text }))
  } finally {
    process.env.PATH = saved
  }
}

// Intent (regardless of backend): content search surfaces EVERY matching line with its
// full, verbatim text. line 1 has no colon (git grep dropped it); line 2 has a colon in
// its text (git grep mangled it). Both backends must agree.
describe('searchContent returns every match with full text', () => {
  it('via the git grep fallback (no ripgrep on PATH)', async () => {
    const hits = await search('match', true)
    expect(hits.map((h) => h.line).sort()).toEqual([1, 2])
    expect(hits).toContainEqual({ line: 1, text: 'alpha match one' })
    expect(hits).toContainEqual({ line: 2, text: 'beta:gamma match two' })
  })

  it('via ripgrep (normal PATH), consistently', async () => {
    const hits = await search('match', false)
    expect(hits.map((h) => h.line).sort()).toEqual([1, 2])
    expect(hits).toContainEqual({ line: 1, text: 'alpha match one' })
    expect(hits).toContainEqual({ line: 2, text: 'beta:gamma match two' })
  })
})

// ---------------------------------------------------------------------------
// A-01…A-04, A-08 — "Show ignored files". Real git repos, because what is under test IS
// what git answers: the ignore rules, the batching of `check-ignore`, and the third
// `ls-files` spawn that only the switch turns on.

/** `git init`, loudly. A silent failure here (a spawn that could not fork under load, a
 *  git that is not on PATH) leaves a plain directory behind, and every case then fails as
 *  "nothing was marked ignored" — which reads exactly like the product bug these cases
 *  exist to catch. */
function initRepo(dir: string): void {
  const r = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git init failed (${r.status}): ${r.stderr || r.error}`)
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`no .git in ${dir}`)
}

/** does git itself call `name` ignored? Asked straight, so a case can tell "the batching
 *  dropped it" apart from "git never considered it ignored in the first place". */
function gitCallsItIgnored(dir: string, name: string): boolean {
  const r = spawnSync('git', ['-C', dir, 'check-ignore', '--', name], { encoding: 'utf8' })
  if (r.status === 0) return true
  if (r.status === 1) return false
  throw new Error(`git check-ignore failed (${r.status}): ${r.stderr || r.error}`)
}

describe('listDir / search honour the show-ignored switch', () => {
  let ws: string
  beforeAll(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-ign-')))
    initRepo(ws)
    fs.writeFileSync(path.join(ws, '.gitignore'), '.env\n.venv/\nnode_modules/\n')
    fs.writeFileSync(path.join(ws, '.env'), 'SECRET=1\n')
    fs.writeFileSync(path.join(ws, 'app.ts'), 'ok\n')
    fs.mkdirSync(path.join(ws, '.venv'))
    fs.writeFileSync(path.join(ws, '.venv', 'pyvenv.cfg'), 'home = /usr\n')
    fs.mkdirSync(path.join(ws, 'node_modules'))
    fs.writeFileSync(path.join(ws, 'node_modules', 'index.js'), '')
    // a directory that merely shares its NAME with build output: this repo keeps its icon
    // source in build/, and the old name-based drop hid it with no way back
    fs.mkdirSync(path.join(ws, 'build'))
    fs.writeFileSync(path.join(ws, 'build', 'icon.svg'), '<svg/>\n')
    // a nested repository: `ls-files --others` prints it as one `nested/` entry
    fs.mkdirSync(path.join(ws, 'nested'))
    initRepo(path.join(ws, 'nested'))
    fs.writeFileSync(path.join(ws, 'nested', 'inner.txt'), '')
  })
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }))

  it('off: an ignored file is not in the listing (what it does today)', async () => {
    const names = (await listDir(ws)).map((e) => e.name)
    expect(names).toContain('app.ts')
    expect(names).not.toContain('.env')
  })

  it('on: the ignored FILE comes back, marked', async () => {
    const entries = await listDir(ws, { showIgnored: true })
    const env = entries.find((e) => e.name === '.env')
    expect(env).toBeTruthy()
    expect(env?.ignored).toBe(true)
    expect(entries.find((e) => e.name === 'app.ts')?.ignored).toBeUndefined()
  })

  it('off: an ignored DIRECTORY and the hidden-by-default names are out', async () => {
    const names = (await listDir(ws)).map((e) => e.name)
    expect(names).not.toContain('.venv')
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('.git')
  })

  it('off: a directory merely NAMED like build output is listed — only git decides', async () => {
    expect((await listDir(ws)).map((e) => e.name)).toContain('build')
  })

  it('on: EVERYTHING comes back — ignored directories and node_modules/.git, marked, and they open', async () => {
    const entries = await listDir(ws, { showIgnored: true })
    for (const name of ['.venv', 'node_modules', '.git']) {
      const e = entries.find((x) => x.name === name)
      expect(e, name).toBeTruthy()
      expect(e?.isDir, name).toBe(true)
      expect(e?.ignored, name).toBe(true)
    }
    expect(entries.find((e) => e.name === 'build')?.ignored).toBeUndefined()
    // opening an ignored directory lists its children, each marked in turn
    const inside = await listDir(path.join(ws, '.venv'), { showIgnored: true })
    expect(inside.map((e) => e.name)).toContain('pyvenv.cfg')
    expect(inside.find((e) => e.name === 'pyvenv.cfg')?.ignored).toBe(true)
  })

  it('search off: an ignored file is not a hit', async () => {
    const { hits } = await treeSearch(ws, '.env')
    expect(hits.map((h) => h.rel)).not.toContain('.env')
  })

  it('search on: the ignored file is a hit, marked', async () => {
    const { hits } = await treeSearch(ws, '.env', { showIgnored: true })
    const hit = hits.find((h) => h.rel === '.env')
    expect(hit).toBeTruthy()
    expect(hit?.ignored).toBe(true)
  })

  it('search off: nothing inside an ignored directory or node_modules is a hit', async () => {
    expect((await treeSearch(ws, 'pyvenv')).hits).toEqual([])
    expect((await treeSearch(ws, 'index.js')).hits.map((h) => h.rel)).not.toContain(
      'node_modules/index.js'
    )
    // …while a file under a tracked `build/` is
    expect((await treeSearch(ws, 'icon.svg')).hits.map((h) => h.rel)).toContain('build/icon.svg')
  })

  it('search on: files inside an ignored directory are hits, marked', async () => {
    const venv = (await treeSearch(ws, 'pyvenv', { showIgnored: true })).hits.find(
      (h) => h.rel === '.venv/pyvenv.cfg'
    )
    expect(venv?.ignored).toBe(true)
    const heavy = (await treeSearch(ws, 'index.js', { showIgnored: true })).hits.find(
      (h) => h.rel === 'node_modules/index.js'
    )
    expect(heavy?.ignored).toBe(true)
  })

  it('search on: an ignored DIRECTORY is never a hit itself (the list is files-only)', async () => {
    for (const q of ['.venv', 'ven']) {
      const { hits } = await treeSearch(ws, q, { showIgnored: true })
      expect(hits.filter((h) => h.rel.endsWith('/'))).toEqual([])
      expect(hits.map((h) => h.rel)).not.toContain('.venv')
      expect(hits.map((h) => h.name)).not.toContain('.venv')
    }
  })

  it('search never lists a nested repository as a file (the `dir/` entry from ls-files)', async () => {
    for (const on of [false, true]) {
      const { hits } = await treeSearch(ws, 'nested', { showIgnored: on })
      expect(
        hits.filter((h) => h.rel.endsWith('/') || h.name === 'nested'),
        `on=${on}`
      ).toEqual([])
    }
  })

  it('search on: a normal file is still an unmarked hit', async () => {
    const { hits } = await treeSearch(ws, 'app.ts', { showIgnored: true })
    expect(hits.find((h) => h.rel === 'app.ts')?.ignored).toBeUndefined()
  })

  // content search is a third backend (rg, or git grep) — it has to follow the same switch
  it('content search follows the switch, on both backends', async () => {
    const rels = async (on: boolean, gitGrepOnly: boolean): Promise<string[]> => {
      const saved = process.env.PATH
      if (gitGrepOnly) process.env.PATH = '/usr/bin:/bin'
      try {
        return (await searchContent(ws, 'SECRET', { showIgnored: on })).hits.map((h) => h.rel)
      } finally {
        process.env.PATH = saved
      }
    }
    for (const gitGrepOnly of [false, true]) {
      expect(await rels(false, gitGrepOnly), `off gitGrepOnly=${gitGrepOnly}`).not.toContain('.env')
      expect(await rels(true, gitGrepOnly), `on gitGrepOnly=${gitGrepOnly}`).toContain('.env')
    }
  })
})

// A-08 — `check-ignore` is asked in batches of 500. A batch where NOTHING is ignored exits
// 1, which the old code treated as fatal and used to abandon every later batch: ignored
// files near the end of a big directory silently lost their mark. The directory order is
// read back from disk, so the single ignored file is provably in a LATER batch.
describe('listDir marks ignored files past the first check-ignore batch', () => {
  let ws: string
  let lastName: string
  /** `IGNORE_BATCH` in fileTree.ts — not exported, so the number is repeated here and the
   *  case below re-checks the position it implies rather than trusting it. */
  const BATCH = 500
  beforeAll(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-batch-')))
    initRepo(ws)
    fs.writeFileSync(path.join(ws, '.gitignore'), 'nothing-here\n')
    for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(ws, `f${i}.txt`), '')
    // whatever the filesystem hands back LAST sits at index >= 500, i.e. in batch 2+
    const order = fs.readdirSync(ws).filter((n) => n !== '.git')
    if (order.length !== 601) throw new Error(`expected 601 entries, got ${order.length}`)
    lastName = order[order.length - 1]
    if (lastName === '.gitignore') lastName = order[order.length - 2]
    fs.writeFileSync(path.join(ws, '.gitignore'), lastName + '\n')
  })
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }))

  it('a later batch is still asked after an earlier one matched nothing', async () => {
    // Everything the case leans on, checked here rather than assumed: the batching order
    // is the directory order, so a red below means the batching dropped the file — not
    // that the repo never came up or that git disagrees about it being ignored.
    const order = fs.readdirSync(ws).filter((n) => n !== '.git')
    expect(order.indexOf(lastName)).toBeGreaterThanOrEqual(BATCH)
    expect(gitCallsItIgnored(ws, lastName)).toBe(true)
    // the first batch must match NOTHING — that exit-1 answer is the trigger. One spawn
    // for all 500, the same shape the code under test uses.
    const first = spawnSync('git', ['-C', ws, 'check-ignore', '--', ...order.slice(0, BATCH)], {
      encoding: 'utf8'
    })
    expect({ status: first.status, stdout: first.stdout }).toEqual({ status: 1, stdout: '' })

    const entries = await listDir(ws, { showIgnored: true })
    expect(entries.find((e) => e.name === lastName)?.ignored).toBe(true)
  })
})

// The 300-result cap is what makes ranking load-bearing: 2000 ignored logs all score
// above a tracked file buried deeper than they are, so they fill the cap and the file the
// user was actually after never reaches the list at all. (A tracked `run.ts` at the ROOT
// would win on path length alone — this case only bites where the tracked path is the
// longer one, which is the normal shape of a real source tree.)
describe('search ranks ignored files below everything else', () => {
  let ws: string
  const tracked = 'src/services/runner/run.ts'
  beforeAll(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-rank-')))
    initRepo(ws)
    fs.writeFileSync(path.join(ws, '.gitignore'), '*.log\n')
    fs.mkdirSync(path.join(ws, 'src', 'services', 'runner'), { recursive: true })
    fs.writeFileSync(path.join(ws, tracked), 'export const run = 1\n')
    fs.mkdirSync(path.join(ws, 'logs'))
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(ws, 'logs', `run-${i}.log`), '')
  })
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }))

  it('keeps the tracked file first, and in the list at all, past the result cap', async () => {
    const { hits, truncated } = await treeSearch(ws, 'run', { showIgnored: true })
    expect(truncated).toBe(true) // the cap really is in play, or the case proves nothing
    expect(hits.map((h) => h.rel)).toContain(tracked)
    expect(hits[0].rel).toBe(tracked)
    expect(hits[0].ignored).toBeUndefined()
  })
})
