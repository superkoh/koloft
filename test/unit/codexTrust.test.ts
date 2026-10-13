import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  acceptCodexHookTrust,
  acceptCodexTrust,
  codexTrustsFolder
} from '../../src/main/codexTrust'

let dir: string
let repo: string
let config: string

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-')))
  repo = path.join(dir, 'repo')
  fs.mkdirSync(repo)
  config = path.join(dir, 'home', 'config.toml')
})

// CODEX§11
describe('acceptCodexTrust', () => {
  it('adds a trusted projects table for the folder and keeps everything already in the file', () => {
    fs.mkdirSync(path.dirname(config))
    fs.writeFileSync(config, 'model = "gpt-5"\n[features]\napps = false')
    acceptCodexTrust(config, repo)
    expect(fs.readFileSync(config, 'utf8')).toBe(
      `model = "gpt-5"\n[features]\napps = false\n\n[projects."${repo}"]\ntrust_level = "trusted"\n`
    )
  })

  it('creates the file when Codex has none yet', () => {
    acceptCodexTrust(config, repo)
    expect(fs.readFileSync(config, 'utf8')).toBe(`[projects."${repo}"]\ntrust_level = "trusted"\n`)
  })

  it('leaves a folder the person already answered for alone, even when the answer was no', () => {
    fs.mkdirSync(path.dirname(config))
    const answered = `[projects."${repo}"]\ntrust_level = "untrusted"\n`
    fs.writeFileSync(config, answered)
    acceptCodexTrust(config, repo)
    expect(fs.readFileSync(config, 'utf8')).toBe(answered)
  })
})

// CODEX§15 PLATFORM§43
it("a trust written through an account home's link to the shared config lands in the shared file and leaves the link in place", () => {
  const shared = path.join(dir, 'shared.toml')
  fs.writeFileSync(shared, 'model = "gpt-5"\n')
  fs.mkdirSync(path.dirname(config))
  fs.symlinkSync(shared, config)
  acceptCodexTrust(config, repo)
  acceptCodexHookTrust(config, 'k', 'sha256:1')
  expect(fs.lstatSync(config).isSymbolicLink()).toBe(true)
  expect(fs.readFileSync(shared, 'utf8')).toContain(`[projects."${repo}"]`)
  expect(fs.readFileSync(shared, 'utf8')).toContain('[hooks.state."k"]\ntrusted_hash = "sha256:1"')
})

// CODEX§27
describe('acceptCodexHookTrust', () => {
  const KEY = '/<session-flags>/config.toml:pre_tool_use:0:0'

  it('adds one trust table for the hook and keeps everything already in the file', () => {
    fs.mkdirSync(path.dirname(config))
    fs.writeFileSync(config, 'model = "gpt-5"\n')
    acceptCodexHookTrust(config, KEY, 'sha256:new')
    expect(fs.readFileSync(config, 'utf8')).toBe(
      `model = "gpt-5"\n\n[hooks.state."${KEY}"]\ntrusted_hash = "sha256:new"\n`
    )
  })

  it("replaces the hash of the hook's existing table in place, never adds a second table for it, which would stop every hook, and keeps the table's other keys and every other table", () => {
    fs.mkdirSync(path.dirname(config))
    const before = (hash: string): string =>
      `model = "gpt-5"\n\n[hooks.state."${KEY}"]\ntrusted_hash = "${hash}"\nenabled = true\n\n[hooks.state."other"]\ntrusted_hash = "sha256:keep"\n\n[features]\napps = false\n`
    fs.writeFileSync(config, before('sha256:old'))
    acceptCodexHookTrust(config, KEY, 'sha256:new')
    acceptCodexHookTrust(config, KEY, 'sha256:new')
    expect(fs.readFileSync(config, 'utf8')).toBe(before('sha256:new'))
  })
})

// CODEX§14
describe('codexTrustsFolder', () => {
  it('says yes only for a table of the folder that says trusted, so a scheduled run is warned before it would stall', () => {
    expect(codexTrustsFolder(config, repo)).toBe(false)
    fs.mkdirSync(path.dirname(config))
    fs.writeFileSync(
      config,
      `[projects."${repo}"]\ntrust_level = "untrusted"\n[projects."${dir}"]\ntrust_level = "trusted"\n`
    )
    expect(codexTrustsFolder(config, repo)).toBe(false)
    fs.writeFileSync(config, '')
    acceptCodexTrust(config, repo)
    expect(codexTrustsFolder(config, repo)).toBe(true)
  })
})
