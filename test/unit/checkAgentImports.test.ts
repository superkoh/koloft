import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const script = path.resolve(__dirname, '../../scripts/check-agent-imports.mjs')
const BASELINE = 'scripts/agent-imports-baseline.json'
const WORDS_BASELINE = 'scripts/agent-words-baseline.json'

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

type Baseline = {
  imports?: Record<string, Record<string, Record<string, string>>>
  optionalMethods?: Record<string, Record<string, string>>
  messagingOf?: Record<string, number>
}

const lines = (...l: string[]): string => l.join('\n') + '\n'

const ALWAYS_THERE: Record<string, string> = {
  'src/agents/list.ts': lines(
    "import { agent as alpha } from './alpha/agent'",
    "import { agent as beta } from './beta/agent'",
    'export const AGENTS = [alpha, beta] as const',
    'export const PICKED = alpha'
  ),
  'src/agents/alpha/agent.ts': "export const agent = { id: 'alpha' }\n",
  'src/agents/beta/agent.ts': "export const agent = { id: 'beta' }\n",
  'src/core/agent/registry.ts': lines(
    "import { AGENTS, PICKED } from '@agents/list'",
    'export const IDS = AGENTS.map((a) => a.id)',
    'export const FIRST = PICKED'
  ),
  'src/shared/sessionBackend.ts': 'export function messagingOf(): string {\n  return ""\n}\n'
}

function fixtureRepo(
  files: Record<string, string>,
  baseline?: Baseline,
  wordLines?: Record<string, string[]>
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-agent-imports-'))
  createdDirs.push(dir)
  const all: Record<string, string> = { ...ALWAYS_THERE, ...files }
  if (baseline) all[BASELINE] = JSON.stringify(baseline)
  if (wordLines) all[WORDS_BASELINE] = JSON.stringify({ lines: wordLines })
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

function check(
  dir: string,
  ...args: string[]
): { code: number | null; out: string; crossings: string[] } {
  const r = spawnSync('node', [script, ...args], { cwd: dir, encoding: 'utf8' })
  const out = r.stdout + r.stderr
  return {
    code: r.status,
    out,
    crossings: [...out.matchAll(/^ {2}(src\/\S+):\d+ {2}\[(\S+)\] {2}→ (\S+)/gm)]
      .map((m) => `${m[1]} [${m[2]}] ${m[3]}`)
      .sort()
  }
}

const readBaseline = (dir: string): Required<Baseline> =>
  JSON.parse(fs.readFileSync(path.join(dir, BASELINE), 'utf8'))

describe('check-agent-imports: who may import whom around src/agents', () => {
  it('lets the lists import the agents, an agent import core, shared, kit, its own folder and a main-process module that names no agent, and common code import the lists', () => {
    const dir = fixtureRepo({
      'src/agents/starts.ts':
        "import { start } from './alpha/main/start'\nexport const S = [start]\n",
      'src/agents/uis.ts': "import { ui } from './alpha/renderer/ui'\nexport const U = [ui]\n",
      'src/agents/alpha/main/start.ts': lines(
        "import type { Manifest } from '@core/agent/manifest'",
        "import { IDS } from '@core/agent/registry'",
        "import { key } from '@shared/keys'",
        "import { store } from '@agents/kit/main/store'",
        "import { own } from '../shared/own'",
        "import { agent } from '../agent'",
        "import { openTerminal } from '../../../main/terminal'",
        "import fs from 'node:fs'",
        'export const start = 1'
      ),
      'src/agents/alpha/shared/own.ts':
        "import { key } from '@shared/keys'\nexport const own = key\n",
      'src/agents/alpha/renderer/ui.tsx': lines(
        "import { own } from '../shared/own'",
        "import { Row } from '@core/ui'",
        'export const ui = <Row>{own}</Row>'
      ),
      'src/agents/kit/main/store.ts': lines(
        "import { openTerminal } from '../../../main/terminal'",
        'export const store = openTerminal'
      ),
      'src/main/terminal.ts': lines(
        "import { key } from '@shared/keys'",
        "import { PLUGINS } from '@plugins/list'",
        'export const openTerminal = [key, PLUGINS]'
      ),
      'src/main/index.ts': lines(
        "import { S } from '@agents/starts'",
        "import { FIRST } from '@core/agent/registry'"
      ),
      'src/renderer/src/App.tsx': "import { U } from '@agents/uis'\n",
      'src/plugins/list.ts':
        "import { plugin } from './p/plugin'\nexport const PLUGINS = [plugin]\n",
      'src/plugins/p/plugin.ts':
        "import { FIRST } from '@core/agent/registry'\nexport const plugin = FIRST\n",
      'src/plugins/p/shared/types.ts': 'export type T = 1\n',
      'src/shared/keys.ts':
        "import type { T } from '@plugins/p/shared/types'\nexport const key = 1\n",
      'src/core/ui.ts': 'export const Row = 1\n',
      'src/core/agent/manifest.ts': 'export interface Manifest {\n  id: string\n}\n'
    })
    const r = check(dir)
    expect(r.out).toContain('imports that cross a boundary: 0')
    expect(r.code).toBe(0)
  })

  it('fails on each kind of import that crosses a boundary, whether static, type-only, re-exported, dynamic or for its side effect, and says the rule and how to fix it', () => {
    const dir = fixtureRepo({
      'src/plugins/p/main/a.ts': "import { x } from '@agents/alpha/main/x'\n",
      'src/main/m.ts': "import type { X } from '../agents/alpha/main/x'\n",
      'src/renderer/src/r.tsx': "const b = import('@agents/beta/shared/b')\n",
      'src/shared/s.ts': "export { x } from '@agents/alpha/main/x'\n",
      'src/core/c.ts': "type B = typeof import('@agents/beta/shared/b')\n",
      'src/preload/p.ts': "import '@agents/alpha/agent'\n",
      'src/plugins/uis.ts': "import { ui } from '@agents/beta/renderer/ui'\n",
      'src/main/k.ts': "import { store } from '@agents/kit/main/store'\n",
      'src/plugins/p/main/k.ts': "import { store } from '@agents/kit/main/store'\n",
      'src/agents/alpha/main/x.ts': lines(
        "import { api } from '@plugins/p/api'",
        "import { AGENTS } from '@agents/list'",
        "import { b } from '@agents/beta/shared/b'",
        "import { Row } from '@renderer/components/Row'",
        'export const x = 1'
      ),
      'src/agents/kit/main/store.ts': lines(
        "import { PLUGINS } from '@plugins/list'",
        "import { S } from '../../starts'",
        "import { x } from '../../alpha/main/x'",
        'export const store = 1'
      ),
      'src/agents/beta/shared/b.ts':
        "import { t } from '../../../main/terminal'\nexport const b = t\n",
      'src/agents/beta/agent.ts':
        "import { y } from './main/y'\nexport const agent = { id: 'beta' }\n",
      'src/agents/beta/renderer/ui.tsx':
        "import { store } from '@agents/kit/main/store'\nexport const ui = [store]\n",
      'src/agents/beta/main/y.ts': 'export const y = 1\n',
      'src/agents/starts.ts': 'export const S = []\n',
      'src/main/terminal.ts': 'export const t = 1\n',
      'src/renderer/src/components/Row.tsx': 'export const Row = 1\n',
      'src/plugins/p/api.ts': 'export const api = 1\n',
      'src/plugins/list.ts': 'export const PLUGINS = []\n'
    })
    const r = check(dir)
    expect(r.code).toBe(1)
    expect(r.crossings).toEqual([
      'src/agents/alpha/main/x.ts [agent-into-agent] src/agents/beta/shared/b.ts',
      'src/agents/alpha/main/x.ts [agent-into-list] src/agents/list.ts',
      'src/agents/alpha/main/x.ts [agent-into-plugin] src/plugins/p/api.ts',
      'src/agents/alpha/main/x.ts [agent-into-window] src/renderer/src/components/Row.tsx',
      'src/agents/beta/agent.ts [window-safe-into-main] src/agents/beta/main/y.ts',
      'src/agents/beta/renderer/ui.tsx [window-safe-into-main] src/agents/kit/main/store.ts',
      'src/agents/beta/shared/b.ts [window-safe-into-main] src/main/terminal.ts',
      'src/agents/kit/main/store.ts [agent-into-agent] src/agents/alpha/main/x.ts',
      'src/agents/kit/main/store.ts [agent-into-list] src/agents/starts.ts',
      'src/agents/kit/main/store.ts [agent-into-plugin] src/plugins/list.ts',
      'src/core/c.ts [common-into-agent] src/agents/beta/shared/b.ts',
      'src/main/k.ts [outside-into-kit] src/agents/kit/main/store.ts',
      'src/main/m.ts [common-into-agent] src/agents/alpha/main/x.ts',
      'src/plugins/p/main/a.ts [plugin-into-agent] src/agents/alpha/main/x.ts',
      'src/plugins/p/main/k.ts [outside-into-kit] src/agents/kit/main/store.ts',
      'src/plugins/uis.ts [common-into-agent] src/agents/beta/renderer/ui.tsx',
      'src/preload/p.ts [common-into-agent] src/agents/alpha/agent.ts',
      'src/renderer/src/r.tsx [common-into-agent] src/agents/beta/shared/b.ts',
      'src/shared/s.ts [common-into-agent] src/agents/alpha/main/x.ts'
    ])
    expect(r.out).toContain('[plugin-into-agent] A plugin never imports an agent’s folder')
    expect(r.out).toContain('src/agents/<id>/')
    expect(r.out).toContain('npm run check:agent-imports -- --accept-new <step>')
  })

  it('fails when a manifest loads, at run time, a file that loads the list of agents, straight or through its own shared file, and lets a type-only import through', () => {
    const dir = fixtureRepo({
      'src/agents/alpha/agent.ts': lines(
        "import type { Kind } from '@shared/types'",
        "import { type Other, DEFAULT } from '@shared/types'",
        "import { label } from './shared/label'",
        "import { own } from './shared/own'",
        "export const agent = { id: 'alpha' }"
      ),
      'src/shared/types.ts': lines(
        "import { IDS } from '@core/agent/registry'",
        'export const DEFAULT = IDS[0]',
        'export type Kind = string',
        'export type Other = string'
      ),
      'src/agents/alpha/shared/label.ts':
        "import { DEFAULT } from '@shared/types'\nexport const label = DEFAULT\n",
      'src/agents/alpha/shared/own.ts':
        "import type { Kind } from '@shared/types'\nexport const own = 1\n"
    })
    const r = check(dir)
    expect(r.crossings).toEqual([
      'src/agents/alpha/agent.ts [manifest-loads-list] src/agents/alpha/shared/label.ts',
      'src/agents/alpha/agent.ts [manifest-loads-list] src/shared/types.ts'
    ])
    expect(r.out).toContain(
      'it loads src/shared/types.ts → src/core/agent/registry.ts → src/agents/list.ts'
    )
  })

  it('fails when an agent’s main imports a main-process module that names an agent, or whose imports lead to a plugin or to another agent’s folder, and says which', () => {
    const dir = fixtureRepo(
      {
        'src/agents/alpha/main/x.ts': lines(
          "import { named } from '../../../main/named'",
          "import { neutral } from '../../../main/neutral'",
          "import { toPlugin } from '../../../main/toPlugin'",
          "import { toBeta } from '../../../main/toBeta'",
          'export const x = 1'
        ),
        'src/agents/beta/main/b.ts':
          "import { toBeta } from '../../../main/toBeta'\nexport const b = 1\n",
        'src/agents/kit/main/store.ts':
          "import { toBeta } from '../../../main/toBeta'\nexport const s = 1\n",
        'src/main/named.ts': 'export const named = 1\n',
        'src/main/neutral.ts': lines(
          "import { key } from '@shared/keys'",
          "import { PLUGINS } from '@plugins/list'",
          'export const neutral = [key, PLUGINS]'
        ),
        'src/main/toPlugin.ts': "import { deep } from './deep'\nexport const toPlugin = [deep]\n",
        'src/main/deep.ts': "import { api } from '@plugins/p/api'\nexport const deep = [api]\n",
        'src/main/toBeta.ts':
          "import { usesBeta } from './usesBeta'\nexport const toBeta = [usesBeta]\n",
        'src/main/usesBeta.ts':
          "import { b } from '@agents/beta/main/b'\nexport const usesBeta = [b]\n",
        'src/plugins/list.ts':
          "import { plugin } from './p/plugin'\nexport const PLUGINS = [plugin]\n",
        'src/plugins/p/plugin.ts': 'export const plugin = 1\n',
        'src/plugins/p/api.ts': 'export const api = 1\n',
        'src/plugins/p/shared/types.ts': 'export type T = 1\n',
        'src/shared/keys.ts':
          "import type { T } from '@plugins/p/shared/types'\nexport const key = 1\n"
      },
      {
        imports: {
          'common-into-agent': { 'src/main/usesBeta.ts': { 'src/agents/beta/main/b.ts': 'C1' } }
        }
      },
      { 'src/main/named.ts': ['const alphaHome = 1'] }
    )
    const r = check(dir)
    expect(r.crossings).toEqual([
      'src/agents/alpha/main/x.ts [agent-main-into-mixed-main] src/main/named.ts',
      'src/agents/alpha/main/x.ts [agent-main-into-mixed-main] src/main/toBeta.ts',
      'src/agents/alpha/main/x.ts [agent-main-into-mixed-main] src/main/toPlugin.ts',
      'src/agents/kit/main/store.ts [agent-main-into-mixed-main] src/main/toBeta.ts'
    ])
    expect(r.out).toContain('it names an agent on 1 lines')
    expect(r.out).toContain(
      'it leads to src/main/toPlugin.ts → src/main/deep.ts → src/plugins/p/api.ts'
    )
    expect(r.out).toContain(
      'it leads to src/main/toBeta.ts → src/main/usesBeta.ts → src/agents/beta/main/b.ts'
    )
  })

  it('counts an import where the name is really declared: passed on under another name, by a re-export, a re-exported import, a constant, `export *`, or taken whole', () => {
    const dir = fixtureRepo(
      {
        'src/agents/alpha/main/x.ts': 'export const x = 1\nexport const other = 2\n',
        'src/core/pass.ts': lines(
          "export { x as renamed } from '@agents/alpha/main/x'",
          "import { other } from '@agents/alpha/main/x'",
          'export const alias = other',
          'export { other as again }',
          'export const mine = 1'
        ),
        'src/core/star.ts': "export * from './pass'\n",
        'src/plugins/p/main/named.ts': "import { renamed as r } from '@core/pass'\n",
        'src/plugins/p/main/alias.ts': "import { alias } from '@core/pass'\n",
        'src/plugins/p/main/again.ts': "import { again } from '@core/star'\n",
        'src/plugins/p/main/whole.ts': "import * as all from '@core/pass'\n",
        'src/plugins/p/main/lazy.ts': "const all = import('@core/pass')\n",
        'src/plugins/p/main/typed.ts': "type R = import('@core/pass').renamed\n",
        'src/plugins/p/main/mine.ts': "import { mine } from '@core/pass'\n",
        'src/plugins/p/main/starMine.ts': "import { mine } from '@core/star'\n",
        'src/main/first.ts': "import { FIRST } from '@core/agent/registry'\n"
      },
      {
        imports: {
          'common-into-agent': { 'src/core/pass.ts': { 'src/agents/alpha/main/x.ts': 'C1' } }
        }
      }
    )
    const r = check(dir)
    const through = (file: string): string =>
      `src/plugins/p/main/${file}.ts [plugin-into-agent] src/agents/alpha/main/x.ts`
    expect(r.crossings).toEqual([
      'src/core/star.ts [common-into-agent] src/agents/alpha/main/x.ts',
      ...['again', 'alias', 'lazy', 'named', 'typed', 'whole'].map(through)
    ])
    expect(r.out).toContain('passed on by src/core/pass.ts')
    expect(r.out).toContain('passed on by src/core/star.ts')
  })
})

describe('check-agent-imports: the baseline only shrinks', () => {
  const crossing = {
    'src/agents/alpha/main/x.ts': 'export const x = 1\nexport const z = 2\n',
    'src/main/a.ts': "import { x } from '@agents/alpha/main/x'\n"
  }
  const recorded: Baseline = {
    imports: {
      'common-into-agent': { 'src/main/a.ts': { 'src/agents/alpha/main/x.ts': 'C4' } }
    }
  }

  it('passes when every crossing is in the baseline, and prints how many are left by rule and by step', () => {
    const r = check(fixtureRepo(crossing, recorded))
    expect(r.code).toBe(0)
    expect(r.out).toContain('imports that cross a boundary: 1')
    expect(r.out).toContain('by rule: common-into-agent 1')
    expect(r.out).toContain('by the step that removes them: C4 1')
  })

  it('fails when one crossing is removed and another added: one cannot pay for the other', () => {
    const dir = fixtureRepo(
      { ...crossing, 'src/main/a.ts': '', 'src/main/b.ts': crossing['src/main/a.ts'] },
      recorded
    )
    const r = check(dir)
    expect(r.code).toBe(1)
    expect(r.crossings).toEqual(['src/main/b.ts [common-into-agent] src/agents/alpha/main/x.ts'])
    expect(r.out).toContain(
      'imports  common-into-agent  src/main/a.ts → src/agents/alpha/main/x.ts'
    )
  })

  it('fails on a baseline entry the code no longer has, and --prune drops it without taking in new ones', () => {
    const dir = fixtureRepo(
      { ...crossing, 'src/main/a.ts': '', 'src/main/b.ts': crossing['src/main/a.ts'] },
      recorded
    )
    const pruned = check(dir, '--prune')
    expect(pruned.code).toBe(1)
    expect(pruned.crossings).toHaveLength(1)
    expect(readBaseline(dir).imports).toEqual({})
  })

  it('takes new entries in only with --accept-new and the step that removes them', () => {
    const dir = fixtureRepo(crossing, {})
    const noStep = check(dir, '--accept-new')
    expect(noStep.code).toBe(2)
    expect(noStep.out).toContain('--accept-new C4')
    expect(check(dir, '--accept-new', 'C4').code).toBe(0)
    expect(readBaseline(dir).imports).toEqual(recorded.imports)
    expect(check(dir).code).toBe(0)
  })

  it('fails on a baseline entry that does not say which step removes it', () => {
    const dir = fixtureRepo(crossing, {
      imports: {
        'common-into-agent': { 'src/main/a.ts': { 'src/agents/alpha/main/x.ts': '' } }
      }
    })
    const r = check(dir)
    expect(r.code).toBe(1)
    expect(r.out).toContain('do not say which step removes them')
  })

  it('stops with exit 2 and names the file when the baseline cannot be read', () => {
    const dir = fixtureRepo(crossing, {})
    fs.writeFileSync(path.join(dir, BASELINE), '<<<<<<< HEAD\n{}\n')
    const r = check(dir)
    expect(r.code).toBe(2)
    expect(r.out).toContain(BASELINE)
  })
})

describe('check-agent-imports: no optional method on the run-time interfaces', () => {
  const interfaces = {
    'src/core/agent/sessions.ts': lines(
      'export interface Sessions {',
      '  list(): string[]',
      '  recovers?: true',
      '  answer?(tabId: string): void',
      '  deliver?: (tabId: string) => boolean',
      '}',
      'export type Accounts = {',
      '  probe?(): void',
      '  name?: string',
      '}',
      'export class Runtime {',
      '  activeTab?: () => string',
      '}'
    ),
    'src/core/agent/manifest.ts':
      'export interface Manifest {\n  price?(model: string): number\n}\n',
    'src/agents/kit/main/stored.ts':
      'export interface Stored {\n  follow?(host: string): void\n}\n',
    'src/main/host.ts': 'export interface Host {\n  launch?(): void\n}\n',
    'src/agents/alpha/main/deps.ts': 'export interface Deps {\n  rules?(): string\n}\n'
  }
  const recorded: Baseline = {
    optionalMethods: {
      'src/core/agent/sessions.ts': {
        'Sessions.answer': 'C1',
        'Sessions.deliver': 'C2',
        'Accounts.probe': 'C4'
      },
      'src/agents/kit/main/stored.ts': { 'Stored.follow': 'B3' }
    }
  }

  it('fails on an optional method of an interface or object type in src/core/agent and src/agents/kit/main, written as a method or as a function-typed field, and lets optional data fields, the manifest type and other folders through', () => {
    const r = check(fixtureRepo(interfaces, {}))
    expect(r.code).toBe(1)
    expect([...r.out.matchAll(/^ {2}(src\/\S+):\d+ {2}(\w+\.\w+)$/gm)].map((m) => m[2])).toEqual([
      'Stored.follow',
      'Sessions.answer',
      'Sessions.deliver',
      'Accounts.probe'
    ])
    expect(r.out).toContain('is never optional')
  })

  it('passes when each one is in the baseline with its step, and fails on one more', () => {
    expect(check(fixtureRepo(interfaces, recorded)).out).toContain(
      'optional methods on the run-time interfaces: 4 (B3 1, C1 1, C2 1, C4 1)'
    )
    const more = check(
      fixtureRepo(
        {
          ...interfaces,
          'src/agents/kit/main/stored.ts':
            'export interface Stored {\n  follow?(host: string): void\n  tmux?(): string\n}\n'
        },
        recorded
      )
    )
    expect(more.code).toBe(1)
    expect(more.out).toContain('src/agents/kit/main/stored.ts:3  Stored.tmux')
  })
})

describe('check-agent-imports: no new use of messagingOf outside the agents’ folders', () => {
  const uses = {
    'src/plugins/p/main/send.ts': lines(
      "import { messagingOf } from '@shared/sessionBackend'",
      'export const route = messagingOf()',
      'export const other = { messagingOf: 1 }.messagingOf'
    ),
    'src/agents/alpha/main/send.ts': lines(
      "import { messagingOf } from '@shared/sessionBackend'",
      'export const route = messagingOf()'
    )
  }
  const recorded: Baseline = { messagingOf: { 'src/plugins/p/main/send.ts': 1 } }

  it('passes when each use outside the agents’ folders is in the baseline, and does not count an agent’s own use or another thing of the same name', () => {
    const r = check(fixtureRepo(uses, recorded))
    expect(r.code).toBe(0)
    expect(r.out).toContain('references to messagingOf: 1 in 1 files')
  })

  it('fails on one more use in a file that already has some, and on a use that is gone until --prune', () => {
    const more = check(
      fixtureRepo(
        {
          ...uses,
          'src/plugins/p/main/send.ts': uses['src/plugins/p/main/send.ts'] + 'messagingOf()\n'
        },
        recorded
      )
    )
    expect(more.code).toBe(1)
    expect(more.out).toContain('src/plugins/p/main/send.ts  2 now, the baseline allows 1')
    const dir = fixtureRepo({ ...uses, 'src/plugins/p/main/send.ts': '' }, recorded)
    expect(check(dir).out).toContain('messagingOf  src/plugins/p/main/send.ts  (0 left')
    expect(check(dir, '--prune').code).toBe(0)
    expect(readBaseline(dir).messagingOf).toEqual({})
  })

  it('knows it under another name, passed on by another file, and as a member of a whole-module import', () => {
    const r = check(
      fixtureRepo(
        {
          'src/main/renamed.ts': lines(
            "import { messagingOf as howItSends } from '@shared/sessionBackend'",
            'howItSends()'
          ),
          'src/core/pass.ts': lines(
            "export { messagingOf as viaExport } from '@shared/sessionBackend'",
            "import { messagingOf } from '@shared/sessionBackend'",
            'export const viaConstant = messagingOf'
          ),
          'src/main/passed.ts': lines(
            "import { viaExport, viaConstant } from '@core/pass'",
            'viaExport()',
            'viaConstant()'
          ),
          'src/renderer/src/whole.ts': lines(
            "import * as backend from '@shared/sessionBackend'",
            'backend.messagingOf()'
          )
        },
        {}
      )
    )
    expect(r.code).toBe(1)
    expect(
      [...r.out.matchAll(/^ {2}(src\/\S+) {2}(\d+) now/gm)].map((m) => `${m[1]} ${m[2]}`)
    ).toEqual([
      'src/core/pass.ts 2',
      'src/main/passed.ts 2',
      'src/main/renamed.ts 1',
      'src/renderer/src/whole.ts 1'
    ])
  })
})
