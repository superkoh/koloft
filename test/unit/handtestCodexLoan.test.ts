import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexLoan } from '../handtest/codexLoan'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 20, 3, 0, 0)

const profiles: string[] = []

function loginExpiringIn(ms: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: (NOW + ms) / 1000 })).toString('base64url')
  return JSON.stringify({ tokens: { access_token: `h.${payload}.s` } })
}

function profileWith(logins: Record<string, string>): string {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loan-'))
  profiles.push(profile)
  for (const [name, auth] of Object.entries(logins)) {
    fs.mkdirSync(path.join(profile, 'codex-homes', name), { recursive: true })
    fs.writeFileSync(path.join(profile, 'codex-homes', name, 'auth.json'), auth)
  }
  return profile
}

const account = (name: string, enabled = true) => ({ name, kind: 'codex-home', enabled })

afterEach(() => {
  for (const p of profiles.splice(0)) fs.rmSync(p, { recursive: true, force: true })
})

describe('the hand-test sandbox lends a Codex login only while no refresh can come during a run', () => {
  it('lends the enabled account whose access token lasts longest', () => {
    const profile = profileWith({ a: loginExpiringIn(48 * HOUR), b: loginExpiringIn(200 * HOUR) })
    expect(codexLoan(profile, [account('a'), account('b')], NOW)).toMatchObject({ name: 'b' })
  })

  it('never lends a turned-off account, however fresh', () => {
    const profile = profileWith({
      off: loginExpiringIn(200 * HOUR),
      on: loginExpiringIn(48 * HOUR)
    })
    expect(codexLoan(profile, [account('off', false), account('on')], NOW)).toMatchObject({
      name: 'on'
    })
  })

  it('refuses, naming the account and when Codex would refresh it, when that is within a day', () => {
    const profile = profileWith({ on: loginExpiringIn(20 * HOUR) })
    const loan = codexLoan(profile, [account('on')], NOW)
    expect(loan).not.toHaveProperty('auth')
    expect(loan).toMatchObject({ notLent: expect.stringContaining('"on"') })
    expect(loan).toMatchObject({ notLent: expect.stringContaining('2026-11-20T22:55:00.000Z') })
  })

  it('says until when a lent login is safe: five minutes before its token expires', () => {
    const profile = profileWith({ on: loginExpiringIn(48 * HOUR) })
    expect(codexLoan(profile, [account('on')], NOW)).toMatchObject({
      safeUntil: NOW + 48 * HOUR - 5 * 60_000
    })
  })

  it('lends an API key, which never refreshes, with no time limit', () => {
    const profile = profileWith({
      key: JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'k' }),
      soon: loginExpiringIn(1 * HOUR)
    })
    const loan = codexLoan(profile, [account('soon'), account('key')], NOW)
    expect(loan).toMatchObject({ name: 'key' })
    expect(loan).not.toHaveProperty('safeUntil')
  })

  it('passes over a login it cannot read for one it can', () => {
    const profile = profileWith({
      broken: '{"tokens": {"access_token": "opaque"',
      good: loginExpiringIn(48 * HOUR)
    })
    expect(codexLoan(profile, [account('broken'), account('good')], NOW)).toMatchObject({
      name: 'good'
    })
  })

  it('refuses when no enabled account is signed in', () => {
    const profile = profileWith({ off: loginExpiringIn(200 * HOUR) })
    expect(codexLoan(profile, [account('off', false), account('none')], NOW)).toHaveProperty(
      'notLent'
    )
  })
})
