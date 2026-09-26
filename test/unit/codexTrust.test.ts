import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { acceptCodexTrust, codexTrustsFolder } from '../../src/main/codexTrust'

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
