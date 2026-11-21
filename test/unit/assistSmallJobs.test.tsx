// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { assistLaunchOn, sanitizeAssist } from '../../src/shared/assistPicks'
import { SESSION_BACKENDS } from '../../src/shared/sessionBackend'
import { DEFAULT_SETTINGS } from '../../src/shared/settingsOps'

function anyApi(): unknown {
  return new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : anyApi()),
    apply: () =>
      Object.assign(() => {}, {
        then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(null).then(ok, bad)
      })
  })
}
;(window as unknown as { api: unknown }).api = anyApi()

const { AssistSection } = await import('../../src/renderer/src/components/settings/AssistSection')

const SAVED_UNDER = ['title', 'handover', 'turn', 'docs', 'route'] as const

afterEach(cleanup)

describe('Settings ▸ Assist small jobs', () => {
  it('lists the same rows, in the same order, with the same words', () => {
    const { container } = render(<AssistSection />)
    const groups = [...container.querySelectorAll('.set-grp')]
    const small = groups.find((g) => g.textContent === 'Small jobs')!
    const rows: string[] = []
    for (
      let el = small.nextElementSibling;
      el && !el.matches('.set-grp');
      el = el.nextElementSibling
    )
      rows.push(
        `${el.querySelector('.set-lab b')?.textContent} — ${el.querySelector('.set-lab small')?.textContent}`
      )
    expect(rows).toEqual([
      'Name a new session — A short title for a session that an agent or your butler starts.',
      'Translate a handover — The note a new session gets, in your language.',
      'After each turn — Decides whether a reply needs you or is only news, and offers one-click answers.',
      'Pick the documents to show — Which files written in a turn are for you to read.',
      'Route what you type in ⌘P — Finds the workspace, session or feature your words are for.'
    ])
  })

  it('keeps each job’s saved pick under the key it was saved under', () => {
    const rows = Object.fromEntries(SAVED_UNDER.map((id) => [id, { backend: 'codex' }]))
    expect(sanitizeAssist({ rows }).rows).toEqual(rows)
  })

  it('runs each job, while it has no pick, with the model and thinking it ran with before', () => {
    const inputs = { assist: {}, sessionMethods: DEFAULT_SETTINGS.sessionMethods, accounts: [] }
    const table = SAVED_UNDER.map((id) => [
      id,
      SESSION_BACKENDS.map((b) => {
        const { model, effort } = assistLaunchOn(id, b, inputs)
        return `${b}: ${model ?? '-'} ${effort ?? '-'}`
      }).join(', ')
    ])
    expect(table).toEqual([
      ['title', 'claude: haiku -, codex: gpt-6-luna low, agy: gemini-3.8-flash low'],
      ['handover', 'claude: haiku -, codex: gpt-6-luna low, agy: gemini-3.8-flash low'],
      ['turn', 'claude: haiku -, codex: gpt-6.1-sol medium, agy: gemini-4-argon medium'],
      ['docs', 'claude: haiku -, codex: gpt-6-luna low, agy: gemini-3.8-flash low'],
      ['route', 'claude: sonnet low, codex: gpt-6.1-sol low, agy: gemini-3.8-flash low']
    ])
  })
})
