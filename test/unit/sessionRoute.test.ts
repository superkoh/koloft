import { describe, expect, it } from 'vitest'
import {
  distinctName,
  parseRoute,
  routeJob,
  type RouteWorkspace
} from '../../src/shared/sessionRoute'

const LIST: RouteWorkspace[] = [
  {
    path: '/Users/me/code/app',
    machine: 'local',
    name: 'app',
    git: true,
    worktrees: ['fix-login', 'redis-cache'],
    titles: ['Login fails on Safari']
  },
  {
    path: 'devbox:/srv/api',
    machine: 'devbox',
    name: 'api',
    git: true,
    worktrees: [],
    titles: []
  },
  {
    path: '/Users/me/notes',
    machine: 'local',
    name: 'notes',
    git: false,
    worktrees: [],
    titles: ['Weekly report']
  }
]

const reply = (o: object): string => `Sure:\n${JSON.stringify(o)}\n`

describe('routeJob: what Koloft Assist is told', () => {
  it('names each workspace by its folder alone, never its full path, and names the machines', () => {
    const { prompt } = routeJob(LIST, 'fix the login bug')
    expect(prompt).not.toContain('/Users/me')
    expect(prompt).not.toContain('/srv/api')
    expect(prompt).toContain('1 | local | app | git | Login fails on Safari')
    expect(prompt).toContain('existing worktrees: fix-login, redis-cache')
    expect(prompt).toContain('"local", "devbox"')
    expect(prompt).toContain('fix the login bug')
  })
})

describe('parseRoute: an answer is checked before anything uses it', () => {
  it('reads a workspace by its number, with title, reason and how sure it is', () => {
    expect(
      parseRoute(
        reply({
          workspace: 1,
          worktree: { new: 'safari-login' },
          title: 'Safari 登录',
          sure: false,
          why: 'The login bug lives in app.'
        }),
        LIST
      )
    ).toEqual({
      kind: 'workspace',
      path: '/Users/me/code/app',
      worktree: { kind: 'new', name: 'safari-login' },
      title: 'Safari 登录',
      why: 'The login bug lives in app.',
      sure: false
    })
  })

  it('gives a new worktree that clashes with a listed one the next free -N, and drops a bad or reserved name', () => {
    const tree = (worktree: unknown): unknown => {
      const r = parseRoute(reply({ workspace: 1, worktree }), LIST)
      return r?.kind === 'workspace' ? r.worktree : undefined
    }
    expect(tree({ new: 'Fix-Login' })).toEqual({ kind: 'new', name: 'Fix-Login-2' })
    expect(tree({ new: '../x' })).toBeNull()
    expect(tree({ new: 'main' })).toBeNull()
    expect(tree({ existing: 'REDIS-CACHE' })).toEqual({ kind: 'existing', name: 'redis-cache' })
    expect(tree({ existing: 'nope' })).toBeNull()
    expect(tree({ issue: 433 })).toEqual({ kind: 'issue', number: 433 })
    expect(tree({ issue: -1 })).toBeNull()
    expect(tree('main')).toEqual({ kind: 'main' })
  })

  it('always starts a folder that is not git in the folder itself', () => {
    const r = parseRoute(reply({ workspace: 3, worktree: { new: 'report' } }), LIST)
    expect(r).toMatchObject({ kind: 'workspace', worktree: { kind: 'main' } })
  })

  it('reads a brand-new project as a machine Koloft knows and a folder name, never a path', () => {
    expect(
      parseRoute(reply({ workspace: null, machine: 'devbox', newFolder: 'price-crawler' }), LIST)
    ).toMatchObject({ kind: 'project', machine: 'devbox', folder: 'price-crawler' })
    expect(
      parseRoute(reply({ workspace: null, machine: 'elsewhere', newFolder: '/tmp/x' }), LIST)
    ).toMatchObject({ kind: 'project', machine: 'local', folder: null })
  })

  it('gives up on no answer, no JSON, or a workspace number that is not listed', () => {
    expect(parseRoute(null, LIST)).toBeNull()
    expect(parseRoute('I think app.', LIST)).toBeNull()
    expect(parseRoute(reply({ workspace: 9 }), LIST)).toBeNull()
    expect(parseRoute(reply({ workspace: '1' }), LIST)).toBeNull()
  })
})

describe('distinctName', () => {
  it('keeps a free name and counts up past taken ones, ignoring letter case', () => {
    expect(distinctName('a', [])).toBe('a')
    expect(distinctName('a', ['A', 'a-2'])).toBe('a-3')
  })
})
