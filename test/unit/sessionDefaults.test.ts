import { describe, expect, it } from 'vitest'
import type { CronEffort, SessionDefaults } from '../../src/shared/types'
import { cronPickFor, takesOwnDefaults } from '../../src/shared/sessionDefaults'
import { familyEfforts, resolveOwnPick } from '../../src/shared/sessionPicks'
import { projectDefaults, SET_ONCE_CONNECTED } from '../../src/main/projectDefaults'

const LMH: CronEffort[] = ['low', 'medium', 'high']

describe('which launches take the workspace’s own model and thinking', () => {
  it('only a fresh launch that names neither: a resume, or one an agent gave a model or an effort, keeps what it has', () => {
    expect(takesOwnDefaults({})).toBe(true)
    expect(takesOwnDefaults({ resumeSessionId: 's1' })).toBe(false)
    expect(takesOwnDefaults({ model: 'opus' })).toBe(false)
    expect(takesOwnDefaults({ effort: 'low' })).toBe(false)
  })

  it('a scheduled job set to Default takes the workspace’s pick for that part only, and keeps what it set itself', () => {
    const defaults: SessionDefaults = { picks: { codex: { model: 'sol', effort: 'high' } } }
    expect(cronPickFor('codex', {}, defaults)).toEqual({ model: 'sol', effort: 'high' })
    expect(cronPickFor('codex', { model: 'gpt-6-luna' }, defaults)).toEqual({
      model: 'gpt-6-luna',
      effort: 'high'
    })
    expect(cronPickFor('claude', {}, defaults)).toEqual({})
  })
})

describe('the model and thinking a session the owner starts runs on', () => {
  it('starts Claude on fable even with no fable allowance left: the owner picked it', () => {
    expect(resolveOwnPick('claude', { model: 'fable', effort: 'high' }, undefined)).toEqual({
      pick: { model: 'fable', effort: 'high' }
    })
  })

  it('turns a Codex or Antigravity family into the newest model of it the account lists', () => {
    const listed = [
      { id: 'gpt-6-sol', efforts: LMH },
      { id: 'gpt-6.1-sol', efforts: LMH }
    ]
    expect(resolveOwnPick('codex', { model: 'sol', effort: 'low' }, listed)).toEqual({
      pick: { model: 'gpt-6.1-sol', effort: 'low' }
    })
  })

  it('drops a thinking level the model does not take and starts anyway', () => {
    const listed = [{ id: 'gemini-4-argon', efforts: ['low', 'high'] as CronEffort[] }]
    expect(resolveOwnPick('agy', { model: 'argon', effort: 'medium' }, listed)).toEqual({
      pick: { model: 'gemini-4-argon' }
    })
    expect(resolveOwnPick('agy', { effort: 'medium' }, undefined)).toEqual({ pick: {} })
  })

  it('starts Carbon on Argon when the account has no Carbon, and says so', () => {
    const listed = [{ id: 'gemini-4-argon', efforts: LMH }]
    expect(resolveOwnPick('agy', { model: 'carbon', effort: 'high' }, listed)).toEqual({
      pick: { model: 'gemini-4-argon', effort: 'high' },
      note: 'This account has no carbon model, so it runs on gemini-4-argon.'
    })
  })

  it('passes a full model name the owner typed straight through', () => {
    expect(resolveOwnPick('codex', { model: 'gpt-7-nova' }, [])).toEqual({
      pick: { model: 'gpt-7-nova' }
    })
  })

  it('offers each Antigravity family the thinking levels of the model it would run on', () => {
    expect(familyEfforts('agy', [{ id: 'gemini-4-argon', efforts: LMH }])).toEqual({
      argon: LMH,
      carbon: LMH
    })
  })
})

describe('where a workspace’s session defaults are kept', () => {
  const keeper = (repo: string | null, reachable = true) => {
    let saved: Record<string, SessionDefaults> = {}
    const store = projectDefaults({
      rootOf: (dir) => dir.replace(/\/\.claude\/worktrees\/.*$/, ''),
      reachable: async () => {
        if (!reachable) throw new Error('down')
      },
      repoOf: async () => repo,
      saved: () => saved,
      save: (all) => {
        saved = all
      }
    })
    return { store, saved: () => saved }
  }

  it('under the GitHub repository, so a worktree of it finds what was set for the workspace', async () => {
    const { store, saved } = keeper('octo/app')
    await store.write('/work/app', { picks: { claude: { model: 'opus' } } })
    expect(Object.keys(saved())).toEqual(['octo/app'])
    expect(await store.of('/work/app/.claude/worktrees/fix')).toEqual({
      picks: { claude: { model: 'opus' } }
    })
  })

  it('under the folder when it is on no GitHub repository, and an empty save removes it', async () => {
    const { store, saved } = keeper(null)
    await store.write('/work/notes', { picks: {}, rules: 'Use sonnet.' })
    expect(saved()).toEqual({ '/work/notes': { picks: {}, rules: 'Use sonnet.' } })
    await store.write('/work/notes', { picks: {} })
    expect(saved()).toEqual({})
  })

  it('refuses to read or save while the machine cannot be reached, so nothing lands under the folder of a repository', async () => {
    const { store, saved } = keeper(null, false)
    await expect(store.read('ssh://box/srv/api')).rejects.toThrow(SET_ONCE_CONNECTED)
    await expect(
      store.write('ssh://box/srv/api', { picks: { claude: { effort: 'low' } } })
    ).rejects.toThrow(SET_ONCE_CONNECTED)
    expect(saved()).toEqual({})
  })
})
