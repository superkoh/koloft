import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const repoRoot = path.resolve(__dirname, '../..')

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const manifest = (id: string, needs: string[]): string =>
  `export const plugin = { formatVersion: 1, id: '${id}', name: '${id}', mandatory: false, needs: ${JSON.stringify(needs)} }\n`

function fixtureRepo(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-plugin-imports-')))
  createdDirs.push(dir)
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.copyFileSync(
    path.join(repoRoot, 'scripts/check-plugin-imports.mjs'),
    path.join(dir, 'scripts/check-plugin-imports.mjs')
  )
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'))
  const all: Record<string, string> = {
    'src/core/plugin.ts': 'export const PLUGIN_FORMAT_VERSION = 1\n',
    'src/shared/types.ts': 'export type Id = string\n',
    'src/main/index.ts': "import { PLUGINS } from '@plugins/list'\n",
    'src/plugins/list.ts':
      "import { plugin as a } from './a/plugin'\nimport { plugin as b } from './b/plugin'\nimport { plugin as c } from './c/plugin'\nexport const PLUGINS = [a, b, c]\n",
    'src/plugins/a/plugin.ts': manifest('a', []),
    'src/plugins/a/api.ts': 'export const fromA = 1\n',
    'src/plugins/a/main/inner.ts': 'export const inner = 1\n',
    'src/plugins/b/plugin.ts': manifest('b', ['a']),
    'src/plugins/b/api.ts': 'export const fromB = 1\n',
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
  const r = spawnSync('node', [path.join(dir, 'scripts/check-plugin-imports.mjs')], {
    cwd: dir,
    encoding: 'utf8'
  })
  return {
    code: r.status,
    reported: [...r.stdout.matchAll(/^ {2}(\S+:\d+) {2}(\S+)/gm)].map((m) => `${m[1]} ${m[2]}`)
  }
}

const lines = (...l: string[]): string => l.join('\n') + '\n'

describe('check-plugin-imports', () => {
  it('lets a plugin import core, its own folder and the api.ts of a plugin it needs, and lets the app import the list', () => {
    const dir = fixtureRepo({
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

  it('reports each import that breaks the rule, in every import form, and still exits 0', () => {
    const dir = fixtureRepo({
      'src/plugins/c/main/bad.ts': lines(
        "import { inner } from '@plugins/a/main/inner'",
        "import type { fromA } from '@plugins/a/api'",
        "import { PLUGINS } from '../../list'",
        "export * from '@shared/types'",
        "const app = require('../../../main/index')",
        "const plugin = import('@plugins/b')",
        "type T = import('@plugins/a/api').X"
      ),
      'src/core/bad.ts': "import { fromA } from '@plugins/a/api'\n",
      'src/renderer/src/bad.tsx': "const b = import('../../plugins/b/api')\n"
    })
    expect(check(dir)).toEqual({
      code: 0,
      reported: [
        'src/core/bad.ts:1 @plugins/a/api',
        'src/plugins/c/main/bad.ts:1 @plugins/a/main/inner',
        'src/plugins/c/main/bad.ts:2 @plugins/a/api',
        'src/plugins/c/main/bad.ts:3 ../../list',
        'src/plugins/c/main/bad.ts:4 @shared/types',
        'src/plugins/c/main/bad.ts:5 ../../../main/index',
        'src/plugins/c/main/bad.ts:6 @plugins/b',
        'src/plugins/c/main/bad.ts:7 @plugins/a/api',
        'src/renderer/src/bad.tsx:1 ../../plugins/b/api'
      ]
    })
  })
})
