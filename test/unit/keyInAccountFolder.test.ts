import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexKeyOnDisk } from '../../src/agents/codex/main/codexAccounts'
import { agyHomeOf, agyKeyOnDisk, setAgyApiKeyRoute } from '../../src/agents/agy/main/agyAccounts'

let userData: string

beforeEach(() => {
  userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-key-')))
})

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

const write = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

describe('telling a pasted API-key account from a sign-in by its own folder, before any probe has run', () => {
  it('reads a Codex key from auth.json and a Gemini key from the gemini model provider; a sign-in or an empty folder is not a key', () => {
    write(path.join(userData, 'codex-homes', 'key', 'auth.json'), {
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'sk-made-up'
    })
    write(path.join(userData, 'codex-homes', 'chatgpt', 'auth.json'), {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: 'a', account_id: 'b' }
    })
    expect(codexKeyOnDisk(userData, 'key')).toBe(true)
    expect(codexKeyOnDisk(userData, 'chatgpt')).toBe(false)
    expect(codexKeyOnDisk(userData, 'missing')).toBe(false)

    setAgyApiKeyRoute(agyHomeOf(userData, 'gemini'), true)
    expect(agyKeyOnDisk(userData, 'gemini')).toBe(true)
    expect(agyKeyOnDisk(userData, 'google')).toBe(false)
  })
})
