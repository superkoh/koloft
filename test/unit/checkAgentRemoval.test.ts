import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const repo = path.resolve(__dirname, '../..')
const script = path.join(repo, 'scripts/check-agent-removal.mjs')
const TSC_RUNS = 30_000

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const manifest = (id: string, anyCase: string[]): string =>
  `export const agent = { id: '${id}', wordsThatNameMe: { anyCase: ${JSON.stringify(anyCase)}, wholeWord: [], quoted: [] } } as const\n`

const tsconfig = (include: string[]): string =>
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: []
    },
    include
  })

const LIST = [
  "import { agent as alpha } from './alpha/agent'",
  "import { agent as beta } from './beta/agent'",
  '',
  'export const AGENTS = [alpha, beta] as const',
  '',
  'export const PICKED_ON_FIRST_OPEN = alpha',
  '',
  "export const OWNER_OF_UNNAMED_OLD_DATA = 'alpha'",
  ''
].join('\n')

function fixtureRepo(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-agent-removal-test-'))
  createdDirs.push(dir)
  const all: Record<string, string> = {
    '.gitignore': 'node_modules\n',
    'tsconfig.node.json': tsconfig(['src/main', 'src/core', 'src/agents']),
    'tsconfig.web.json': tsconfig(['src/renderer', 'src/core', 'src/agents']),
    'src/agents/list.ts': LIST,
    'src/agents/alpha/agent.ts': manifest('alpha', ['alpha', 'codex']),
    'src/agents/beta/agent.ts': manifest('beta', ['beta']),
    'src/core/registry.ts': [
      "import { AGENTS, PICKED_ON_FIRST_OPEN } from '../agents/list'",
      "export type AgentId = (typeof AGENTS)[number]['id']",
      'export const FIRST: AgentId = PICKED_ON_FIRST_OPEN.id',
      ''
    ].join('\n'),
    ...files
  }
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'))
  spawnSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

type Row = { files: number; main: number; window: number; markers: string }

function check(
  dir: string,
  ...args: string[]
): { code: number | null; out: string; rows: Record<string, Row> } {
  const r = spawnSync('node', [script, ...args], { cwd: dir, encoding: 'utf8' })
  const out = r.stdout + r.stderr
  const rows: Record<string, Row> = {}
  for (const m of out.matchAll(
    /^ {2}(nothing deleted|\w+) +(\d+) +(\d+) files, \d+ errors +(\d+) files, \d+ errors +(.*)$/gm
  ))
    rows[m[1]] = { files: +m[2], main: +m[3], window: +m[4], markers: m[5].trim() }
  return { code: r.status, out, rows }
}

describe('check-agent-removal', () => {
  it(
    'counts a file elsewhere that uses the deleted agent, in the check that reads it, and reports and exits 0 when nothing deleted is clean',
    () => {
      const dir = fixtureRepo({
        'src/main/usesAlpha.ts':
          "import { agent } from '../agents/alpha/agent'\nexport const a = agent.id\n",
        'src/renderer/usesBeta.ts':
          "import { agent } from '../agents/beta/agent'\nexport const b = agent.id\n"
      })
      const r = check(dir, '--files')
      expect(r.code).toBe(0)
      expect(r.rows['nothing deleted']).toMatchObject({ files: 0, main: 0, window: 0 })
      expect(r.rows.alpha).toMatchObject({ files: 1, main: 1, window: 0 })
      expect(r.rows.beta).toMatchObject({ files: 1, main: 0, window: 1 })
      expect(r.out).toMatch(/^ {4}alpha: src\/main 1$/m)
      expect(r.out).toMatch(/^ {6}src\/renderer\/usesBeta\.ts$/m)
    },
    TSC_RUNS
  )

  it(
    'takes an agent out of the list file and points the first-open pick at the next agent, so a list with no other users types clean',
    () => {
      const dir = fixtureRepo()
      const r = check(dir)
      expect(r.code).toBe(0)
      expect(r.rows.alpha).toMatchObject({ files: 0 })
      expect(r.rows.beta).toMatchObject({ files: 0 })
      expect(fs.readFileSync(path.join(dir, 'src/agents/list.ts'), 'utf8')).toBe(LIST)
    },
    TSC_RUNS
  )

  it(
    'exits 1 and shows the errors when the copy with nothing deleted does not typecheck',
    () => {
      const dir = fixtureRepo({ 'src/main/broken.ts': 'export const n: number = "text"\n' })
      const r = check(dir)
      expect(r.code).toBe(1)
      expect(r.rows['nothing deleted']).toMatchObject({ files: 1, main: 1 })
      expect(r.out).toMatch(/src\/main\/broken\.ts\(1,14\): error TS2322/)
    },
    TSC_RUNS
  )

  it(
    'counts the ledger markers left in src for the ledger whose file is named by the deleted agent',
    () => {
      const dir = fixtureRepo({
        'src/main/marked.ts': '// CODEX§3 PLATFORM§1\nexport const one = 1 // CODEX§4\n'
      })
      const r = check(dir)
      expect(r.rows.alpha.markers).toBe('CODEX: 2 in 1 files')
      expect(r.rows.beta.markers).toBe('no ledger is named after it')
    },
    TSC_RUNS
  )

  it(
    'cannot run, with exit 2, when the list file uses an agent in a way it does not know how to take out',
    () => {
      const dir = fixtureRepo({
        'src/agents/list.ts': LIST + 'export const BY_ID = { first: alpha }\n'
      })
      const r = check(dir)
      expect(r.code).toBe(2)
      expect(r.out).toMatch(/src\/agents\/list\.ts: cannot take out alpha/)
    },
    TSC_RUNS
  )
})
