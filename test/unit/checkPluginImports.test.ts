import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const script = path.resolve(__dirname, '../../scripts/check-plugin-imports.mjs')

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const manifest = (id: string, needs: string[]): string =>
  `export const plugin = { id: '${id}', needs: ${JSON.stringify(needs)} }\n`

function fixtureRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-plugin-imports-'))
  createdDirs.push(dir)
  const all: Record<string, string> = {
    'src/main/index.ts': "import { PLUGINS } from '@plugins/list'\n",
    'src/plugins/list.ts':
      "import { plugin as a } from './a/plugin'\nimport { plugin as b } from './b/plugin'\nimport { plugin as c } from './c/plugin'\nexport const PLUGINS = [a, b, c]\n",
    'src/plugins/a/plugin.ts': manifest('a', []),
    'src/plugins/b/plugin.ts': manifest('b', ['a']),
    'src/plugins/c/plugin.ts': manifest('c', ['b']),
    ...files
  }
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

function check(dir: string): { code: number | null; reported: string[] } {
  const r = spawnSync('node', [script], { cwd: dir, encoding: 'utf8' })
  return {
    code: r.status,
    reported: [...r.stdout.matchAll(/^ {2}(\S+) +(\S+)/gm)].map((m) => `${m[1]} ${m[2]}`)
  }
}

const lines = (...l: string[]): string => l.join('\n') + '\n'

describe('check-plugin-imports', () => {
  it('lets a plugin import core, its own folder and the api.ts of a plugin it needs, and lets the app import the list, the list of preload bridges, the list of UIs and the list of settings', () => {
    const dir = fixtureRepo({
      'src/plugins/settings.ts': "import { SETTINGS } from './a/shared/settings'\n",
      'src/plugins/a/shared/settings.ts': 'export const SETTINGS = {}\n',
      'src/shared/settingsOps.ts': "import { PLUGIN_SETTINGS } from '@plugins/settings'\n",
      'src/plugins/bridges.ts': "import { bridge } from './a/preload/bridge'\n",
      'src/plugins/a/preload/bridge.ts': 'export const bridge = 1\n',
      'src/preload/index.ts': "import { pluginBridges } from '@plugins/bridges'\n",
      'src/plugins/uis.ts': "import { ui } from './a/renderer/ui'\n",
      'src/plugins/a/renderer/ui.tsx': 'export const ui = {}\n',
      'src/renderer/src/pluginUi.tsx': "import { PLUGIN_UIS } from '@plugins/uis'\n",
      'src/plugins/b/main/ok.ts': lines(
        "import { PLUGIN_FORMAT_VERSION } from '@core/plugin'",
        "import { fromA } from '@plugins/a/api'",
        "import { fromB } from '../api'",
        "export { fromA as again } from '../../a/api.ts'",
        "const later = import('@plugins/a/api')",
        "import x from 'react'",
        "import fs from 'node:fs'"
      )
    })
    expect(check(dir)).toEqual({ code: 0, reported: [] })
  })

  it('reports each import that breaks the rule, static, re-exported, dynamic or through a .. in an alias, and still exits 0', () => {
    const dir = fixtureRepo({
      'src/plugins/c/main/bad.ts': lines(
        "import { inner } from '@plugins/a/main/inner'",
        "import type { fromA } from '@plugins/a/api'",
        "import { PLUGINS } from '../../list'",
        "export * from '@shared/types'",
        "import { app } from '../../../main/index'",
        "const plugin = import('@plugins/b')",
        "import { sneak } from '@core/../plugins/b/main/inner'",
        "type Inner = typeof import('@plugins/a/main/inner')",
        "import { pluginBridges } from '../../bridges'"
      ),
      'src/plugins/bridges.ts': "import { start } from './a/main/start'\n",
      'src/plugins/uis.ts': "import { bridge } from './a/preload/bridge'\n",
      'src/plugins/settings.ts': "import { ui } from './a/renderer/ui'\n",
      'src/core/bad.ts': "import { fromA } from '@plugins/a/api'\n",
      'src/renderer/src/bad.tsx': "const b = import('../../plugins/b/api')\n",
      'src/plugins/list.ts':
        "import { plugin as a } from './a/plugin'\nimport { plugin as b } from './b/plugin'\nimport { plugin as c } from './c/plugin'\nimport { start } from './a/main/start'\nexport const PLUGINS = [a, b, c]\n",
      'src/plugins/a/main/start.ts': 'export const start = 1\n',
      'src/plugins/a/broken.ts': 'import {\n'
    })
    expect(check(dir)).toEqual({
      code: 0,
      reported: [
        'src/core/bad.ts:1 @plugins/a/api',
        'src/plugins/a/broken.ts: cannot',
        'src/plugins/bridges.ts:1 ./a/main/start',
        'src/plugins/c/main/bad.ts:1 @plugins/a/main/inner',
        'src/plugins/c/main/bad.ts:2 @plugins/a/api',
        'src/plugins/c/main/bad.ts:3 ../../list',
        'src/plugins/c/main/bad.ts:4 @shared/types',
        'src/plugins/c/main/bad.ts:5 ../../../main/index',
        'src/plugins/c/main/bad.ts:6 @plugins/b',
        'src/plugins/c/main/bad.ts:7 @core/../plugins/b/main/inner',
        'src/plugins/c/main/bad.ts:8 @plugins/a/main/inner',
        'src/plugins/c/main/bad.ts:9 ../../bridges',
        'src/plugins/list.ts:4 ./a/main/start',
        'src/plugins/settings.ts:1 ./a/renderer/ui',
        'src/plugins/uis.ts:1 ./a/preload/bridge',
        'src/renderer/src/bad.tsx:1 ../../plugins/b/api'
      ]
    })
  })

  it('lists a list of plugins it cannot load as a problem and still exits 0', () => {
    const dir = fixtureRepo({ 'src/plugins/list.ts': "throw new Error('broken')\n" })
    expect(check(dir)).toEqual({ code: 0, reported: ['src/plugins/list.ts: cannot'] })
  })
})
