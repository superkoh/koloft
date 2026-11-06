import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { homeKeyOnDisk } from '../../src/main/homeKeyOnDisk'
import { agyHomeOf, setAgyApiKeyRoute } from '../../src/main/agyAccounts'

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
  it('reads a Codex key from auth.json, a Muse key from its stored api_key, and a Gemini key from the gemini model provider; a sign-in or an empty folder is not a key', () => {
    write(path.join(userData, 'codex-homes', 'key', 'auth.json'), {
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'sk-made-up'
    })
    write(path.join(userData, 'codex-homes', 'chatgpt', 'auth.json'), {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: 'a', account_id: 'b' }
    })
    expect(homeKeyOnDisk['codex-home'](userData, 'key')).toBe(true)
    expect(homeKeyOnDisk['codex-home'](userData, 'chatgpt')).toBe(false)
    expect(homeKeyOnDisk['codex-home'](userData, 'missing')).toBe(false)

    const museAuth = (name: string): string =>
      path.join(userData, 'muse-homes', name, 'muse', 'auth.json')
    write(museAuth('key'), { schema_version: 1, providers: { meta: { api_key: 'k' } } })
    write(museAuth('meta'), { schema_version: 1, providers: { meta: { access_token: 't' } } })
    expect(homeKeyOnDisk['muse-home'](userData, 'key')).toBe(true)
    expect(homeKeyOnDisk['muse-home'](userData, 'meta')).toBe(false)
    expect(homeKeyOnDisk['muse-home'](userData, 'missing')).toBe(false)

    setAgyApiKeyRoute(agyHomeOf(userData, 'gemini'), true)
    expect(homeKeyOnDisk['agy-home'](userData, 'gemini')).toBe(true)
    expect(homeKeyOnDisk['agy-home'](userData, 'google')).toBe(false)
  })
})
