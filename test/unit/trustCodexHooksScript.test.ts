import { afterEach, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { acceptCodexTrust, codexTrustsFolder } from '../../src/main/codexTrust'

const script = path.resolve(__dirname, '../../scripts/trust-codex-hooks.mjs')

let dir: string
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

// CODEX§11
it("runs under plain node and writes the folder's trust table the way the app does, so the app adds no second table for it", () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trust-codex-hooks-')))
  const config = path.join(dir, 'config.toml')
  fs.writeFileSync(config, 'model = "gpt-5"\n')
  const commonDir = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: path.dirname(script), encoding: 'utf8' }
  ).trim()
  const repo = fs.realpathSync(path.dirname(commonDir))

  const run = spawnSync(
    'node',
    [script, '--config', config, '--codex', path.join(dir, 'no-codex')],
    { encoding: 'utf8' }
  )
  expect(run.stderr).toMatch(/could not start .*no-codex app-server/)
  expect(codexTrustsFolder(config, repo)).toBe(true)

  acceptCodexTrust(config, repo)
  expect(fs.readFileSync(config, 'utf8').match(/^\[projects\./gm)).toHaveLength(1)
})
