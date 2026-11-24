import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const script = path.resolve(__dirname, '../../scripts/check-agent-words.mjs')
const BASELINE = 'scripts/agent-words-baseline.json'

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const manifest = (id: string, anyCase: string[], wholeWord: string[], quoted: string[]): string =>
  `export const agent = { id: '${id}', wordsThatNameMe: ${JSON.stringify({ anyCase, wholeWord, quoted })} }\n`

type Baseline = {
  awaitingMove?: Record<string, string>
  allowed?: { file: string; text: string; reason: string }[]
  lines?: Record<string, string[]>
}

function fixtureRepo(files: Record<string, string>, baseline?: Baseline): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-agent-words-'))
  createdDirs.push(dir)
  const all: Record<string, string> = {
    'src/agents/list.ts':
      "import { agent as alpha } from './alpha/agent'\nimport { agent as beta } from './beta/agent'\nexport const AGENTS = [alpha, beta] as const\n",
    'src/agents/alpha/agent.ts': manifest(
      'alpha',
      ['alpha', 'codex'],
      ['AskFirst', '--first-flag'],
      ['first-home']
    ),
    'src/agents/beta/agent.ts': manifest('beta', ['beta'], ['beta_tool'], ['tok']),
    ...files
  }
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  if (baseline) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(dir, BASELINE), JSON.stringify(baseline))
  }
  return dir
}

function check(
  dir: string,
  ...args: string[]
): { code: number | null; out: string; reported: string[] } {
  const r = spawnSync('node', [script, ...args], { cwd: dir, encoding: 'utf8' })
  const out = r.stdout + r.stderr
  return {
    code: r.status,
    out,
    reported: [...out.matchAll(/^ {2}(src\/\S+:\d+)/gm)].map((m) => m[1])
  }
}

const readBaseline = (dir: string): Required<Baseline> =>
  JSON.parse(fs.readFileSync(path.join(dir, BASELINE), 'utf8'))

const lines = (...l: string[]): string => l.join('\n') + '\n'

describe('check-agent-words', () => {
  it('passes when every line that names an agent outside its folder is in the baseline, and prints the counts', () => {
    const dir = fixtureRepo(
      {
        'src/main/a.ts': lines("if (id === 'alpha') run()", 'const x = 1'),
        'src/renderer/b.css': lines('.badge.beta { color: red; }')
      },
      {
        lines: {
          'src/main/a.ts': ["if (id === 'alpha') run()"],
          'src/renderer/b.css': ['.badge.beta { color: red; }']
        }
      }
    )
    const r = check(dir)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/\b1 lines in 1 files\b.*\b1 lines in 1 files\b/)
  })

  it('fails on a new line that names an agent in any code file, saying where agent code goes and how to add a reasoned exception', () => {
    const dir = fixtureRepo(
      {
        'src/main/a.ts': lines('const x = 1', 'const alphaHome = 2'),
        'src/main/b.mjs': lines("export const id = 'beta'")
      },
      {}
    )
    const r = check(dir)
    expect(r.code).toBe(1)
    expect(r.reported).toEqual(['src/main/a.ts:2', 'src/main/b.mjs:1'])
    expect(r.out).toContain('src/agents/<id>/')
    expect(r.out).toContain('npm run check:agent-words -- --accept-new')
  })

  it('fails when a line naming an agent is deleted and another added in the same file: one cannot pay for the other', () => {
    const dir = fixtureRepo(
      { 'src/main/a.ts': lines('const betaTwo = 2') },
      { lines: { 'src/main/a.ts': ['const betaOne = 1'] } }
    )
    const r = check(dir)
    expect(r.code).toBe(1)
    expect(r.reported).toEqual(['src/main/a.ts:1'])
    expect(r.out).toContain('src/main/a.ts  const betaOne = 1')
  })

  it('counts a changed line that already named an agent as new, and the same line twice as two', () => {
    const dir = fixtureRepo(
      { 'src/main/a.ts': lines('useAlpha(1)', 'useAlpha(1)', 'useAlpha(2)') },
      { lines: { 'src/main/a.ts': ['useAlpha(1)', 'useAlpha(3)'] } }
    )
    expect(check(dir).reported).toEqual(['src/main/a.ts:2', 'src/main/a.ts:3'])
  })

  it('fails on a baseline entry the code no longer has, and --prune drops it without taking in new lines', () => {
    const dir = fixtureRepo(
      { 'src/main/a.ts': lines('const fresh = beta') },
      { lines: { 'src/main/a.ts': ['const gone = alpha'] } }
    )
    const before = check(dir)
    expect(before.code).toBe(1)
    expect(before.out).toContain('src/main/a.ts  const gone = alpha')
    const pruned = check(dir, '--prune')
    expect(pruned.code).toBe(1)
    expect(pruned.reported).toEqual(['src/main/a.ts:1'])
    expect(readBaseline(dir).lines).toEqual({})
  })

  it('takes new lines into the baseline only with --accept-new', () => {
    const dir = fixtureRepo({ 'src/main/a.ts': lines('const a = alpha', 'const b = beta') }, {})
    expect(check(dir, '--accept-new').code).toBe(0)
    expect(readBaseline(dir).lines).toEqual({
      'src/main/a.ts': ['const a = alpha', 'const b = beta']
    })
    expect(check(dir).code).toBe(0)
  })

  it('does not check a file on the awaiting-move list at all, checks a new agent-named file that is not on it, and fails on a listed file that is gone', () => {
    const dir = fixtureRepo(
      {
        'src/main/alphaTrust.ts': lines('export const alphaTrust = 1', 'const b = beta'),
        'src/main/alphaNew.ts': lines('export const alphaNew = 1')
      },
      { awaitingMove: { 'src/main/alphaTrust.ts': 'alpha', 'src/main/alphaMoved.ts': 'alpha' } }
    )
    const r = check(dir)
    expect(r.reported).toEqual(['src/main/alphaNew.ts:1'])
    expect(r.out).toContain('awaitingMove src/main/alphaMoved.ts (no such file any more)')
  })

  it('stops with exit 2 and names the file when the baseline cannot be read', () => {
    const dir = fixtureRepo({ 'src/main/a.ts': lines('const x = 1') }, {})
    fs.writeFileSync(path.join(dir, BASELINE), '<<<<<<< HEAD\n{}\n')
    const r = check(dir)
    expect(r.code).toBe(2)
    expect(r.out).toContain(BASELINE)
  })

  it('lets a line allowed by name through once per entry, and fails when that line is gone', () => {
    const allowed = [
      { file: 'src/main/a.ts', text: "mode: 'tok'", reason: 'a git host sign-in mode' }
    ]
    expect(check(fixtureRepo({ 'src/main/a.ts': lines("mode: 'tok'") }, { allowed })).code).toBe(0)
    const twice = check(
      fixtureRepo({ 'src/main/a.ts': lines("mode: 'tok'", "mode: 'tok'") }, { allowed })
    )
    expect(twice.reported).toEqual(['src/main/a.ts:2'])
    const gone = check(fixtureRepo({ 'src/main/a.ts': lines('mode: 1') }, { allowed }))
    expect(gone.code).toBe(1)
    expect(gone.out).toContain("allowed src/main/a.ts  mode: 'tok' (no such line any more)")
  })

  it('lets an agent folder name itself but not another agent, checks kit as common code, and never checks the list', () => {
    const dir = fixtureRepo(
      {
        'src/agents/alpha/main/start.ts': lines('const alphaOwn = 1', 'const betaThere = 2'),
        'src/agents/beta/renderer/ui.tsx': lines("const k = 'tok'", 'const t = beta_tool'),
        'src/agents/kit/shared.ts': lines('const fromKit = alpha')
      },
      {}
    )
    expect(check(dir).reported).toEqual([
      'src/agents/alpha/main/start.ts:2',
      'src/agents/kit/shared.ts:1'
    ])
  })

  it('matches any-case words inside names, whole words only as a whole, and quoted words only in quotes', () => {
    const dir = fixtureRepo(
      {
        'src/main/a.ts': lines(
          'const ALPHA_DIR = 1',
          'askFirst()',
          'AskFirstNow()',
          'run(AskFirst)',
          '--first-flag-two',
          "args.push('--first-flag')",
          'const tokens = 1',
          'kind="tok"',
          'kind = `tok`'
        )
      },
      {}
    )
    expect(check(dir).reported).toEqual([
      'src/main/a.ts:1',
      'src/main/a.ts:4',
      'src/main/a.ts:6',
      'src/main/a.ts:8',
      'src/main/a.ts:9'
    ])
  })

  it('does not count a comment that only holds doc markers, even one whose prefix is an agent word', () => {
    const dir = fixtureRepo(
      {
        'src/main/a.ts': lines('// CODEX§5', 'run() // CODEX§5 ADR-0054', 'const codexDir = 1'),
        'src/renderer/a.tsx': lines('{/* CODEX§5 */}'),
        'src/renderer/a.css': lines('/* CODEX§5 */')
      },
      {}
    )
    expect(check(dir).reported).toEqual(['src/main/a.ts:3'])
  })

  it('reports an id type with one agent left out and an agent picked by its place in a list', () => {
    const dir = fixtureRepo(
      {
        'src/main/a.ts': lines(
          'type Rest = Exclude<AgentId, typeof first>',
          'const second = AGENTS[1]',
          'const last = AGENT_IDS.at(-1)',
          'const every = AGENTS.map((a) => a.id)',
          'type Others = Exclude<SessionBackend, typeof picked>'
        )
      },
      {}
    )
    expect(check(dir).reported).toEqual([
      'src/main/a.ts:1',
      'src/main/a.ts:2',
      'src/main/a.ts:3',
      'src/main/a.ts:5'
    ])
  })
})
