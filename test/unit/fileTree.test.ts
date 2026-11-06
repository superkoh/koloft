import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { listDir, search as treeSearch, searchContent } from '../../src/main/fileTree'

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
  fs.writeFileSync(path.join(repo, 'f.txt'), 'alpha match one\nbeta:gamma match two\n')
  git('add', 'f.txt')
})
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }))

const PATH_WITH_GIT_BUT_NO_RG = '/usr/bin:/bin'

async function search(
  query: string,
  forceGitGrep: boolean
): Promise<{ line: number; text: string }[]> {
  const saved = process.env.PATH
  if (forceGitGrep) process.env.PATH = PATH_WITH_GIT_BUT_NO_RG
  try {
    const { hits } = await searchContent(repo, query)
    return hits.map((h) => ({ line: h.line, text: h.text }))
  } finally {
    process.env.PATH = saved
  }
}

// PLATFORM§31
describe('searchContent returns every match with full text, with or without a colon in it', () => {
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

const COMPOSED_ACCENT = 'café.txt'
const DECOMPOSED_ACCENT = 'café.txt'

function initRepo(dir: string): void {
  const r = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git init failed (${r.status}): ${r.stderr || r.error}`)
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`no .git in ${dir}`)
}

describe('A-01…A-04: listDir / search honour the show-ignored switch', () => {
  let ws: string
  beforeAll(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-ign-')))
    initRepo(ws)
    fs.writeFileSync(
      path.join(ws, '.gitignore'),
      `.env\n.venv/\nnode_modules/\n秘密.txt\n${COMPOSED_ACCENT}\n`
    )
    fs.writeFileSync(path.join(ws, '.env'), 'SECRET=1\n')
    fs.writeFileSync(path.join(ws, '秘密.txt'), '')
    fs.writeFileSync(path.join(ws, DECOMPOSED_ACCENT), '')
    fs.writeFileSync(path.join(ws, 'app.ts'), 'ok\n')
    fs.mkdirSync(path.join(ws, '.venv'))
    fs.writeFileSync(path.join(ws, '.venv', 'pyvenv.cfg'), 'home = /usr\n')
    fs.mkdirSync(path.join(ws, 'node_modules'))
    fs.writeFileSync(path.join(ws, 'node_modules', 'index.js'), '')
    fs.mkdirSync(path.join(ws, 'build'))
    fs.writeFileSync(path.join(ws, 'build', 'icon.svg'), '<svg/>\n')
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

  // PLATFORM§30
  it('off: an ignored file whose name is not ASCII is out too', async () => {
    expect((await listDir(ws)).map((e) => e.name)).not.toContain('秘密.txt')
    const on = await listDir(ws, { showIgnored: true })
    expect(on.find((e) => e.name === '秘密.txt')?.ignored).toBe(true)
  })

  // PLATFORM§30
  it('off: an ignored file whose name is stored decomposed on disk is out, as git status sees it', async () => {
    const names = (await listDir(ws)).map((e) => e.name.normalize('NFC'))
    expect(names).not.toContain(COMPOSED_ACCENT)
    const on = await listDir(ws, { showIgnored: true })
    const entry = on.find((e) => e.name.normalize('NFC') === COMPOSED_ACCENT)
    expect(entry?.ignored).toBe(true)
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

  it('a symlink to a directory is listed as a directory, and a symlink to a file as a file', async () => {
    fs.symlinkSync(path.join(ws, 'build'), path.join(ws, 'build-link'))
    fs.symlinkSync(path.join(ws, 'app.ts'), path.join(ws, 'app-link.ts'))
    try {
      const entries = await listDir(ws)
      expect(entries.find((e) => e.name === 'build-link')?.isDir).toBe(true)
      expect(entries.find((e) => e.name === 'app-link.ts')?.isDir).toBe(false)
    } finally {
      fs.unlinkSync(path.join(ws, 'build-link'))
      fs.unlinkSync(path.join(ws, 'app-link.ts'))
    }
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

  // PLATFORM§30
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

  it('content search follows the switch, on both backends', async () => {
    const rels = async (on: boolean, gitGrepOnly: boolean): Promise<string[]> => {
      const saved = process.env.PATH
      if (gitGrepOnly) process.env.PATH = PATH_WITH_GIT_BUT_NO_RG
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

// PLATFORM§30
describe('listDir lists a big folder outside any repository, where git quits before reading the names', () => {
  let ws: string
  const MANY_ENTRIES_PAST_THE_PIPE_BUFFER = 5000
  beforeAll(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-norepo-')))
    for (let i = 0; i < MANY_ENTRIES_PAST_THE_PIPE_BUFFER; i++)
      fs.writeFileSync(path.join(ws, `file-with-a-long-name-${i}.txt`), '')
  })
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }))

  it('returns every entry, none marked ignored', async () => {
    const entries = await listDir(ws, { showIgnored: true })
    expect(entries).toHaveLength(MANY_ENTRIES_PAST_THE_PIPE_BUFFER)
    expect(entries.filter((e) => e.ignored)).toEqual([])
  })
})

describe('search ranks ignored files below everything else, so they cannot crowd a deep tracked file out of the capped list', () => {
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
    expect(truncated).toBe(true)
    expect(hits.map((h) => h.rel)).toContain(tracked)
    expect(hits[0].rel).toBe(tracked)
    expect(hits[0].ignored).toBeUndefined()
  })
})
