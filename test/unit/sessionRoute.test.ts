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
    sessions: [{ id: 'sess-safari', title: 'Login fails on Safari' }]
  },
  {
    path: 'devbox:/srv/api',
    machine: 'devbox',
    name: 'api',
    git: true,
    worktrees: [],
    sessions: []
  },
  {
    path: '/Users/me/notes',
    machine: 'local',
    name: 'notes',
    git: false,
    worktrees: [],
    sessions: [
      { id: 'sess-report', title: 'Weekly report' },
      { id: 'sess-plan', title: 'Plan the quarter' }
    ]
  }
]

const reply = (o: object): string => `Sure:\n${JSON.stringify(o)}\n`

describe('routeJob: what Koloft Assist is told', () => {
  it('names each workspace by its folder alone, never its full path, and names the machines', () => {
    const { prompt } = routeJob(LIST, 'fix the login bug')
    expect(prompt).not.toContain('/Users/me')
    expect(prompt).not.toContain('/srv/api')
    expect(prompt).toContain('1 | local | app | git | [1.1] Login fails on Safari')
    expect(prompt).toContain(
      '3 | local | notes | not git | [3.1] Weekly report; [3.2] Plan the quarter'
    )
    expect(prompt).toContain('existing worktrees: fix-login, redis-cache')
    expect(prompt).toContain('"local", "devbox"')
    expect(prompt).toContain('fix the login bug')
  })

  it('lists the Koloft features it may pick by key with the words people use for each, leaving out those that act on whichever session or workspace is current', () => {
    const { prompt } = routeJob(LIST, 'open settings')
    expect(prompt).toContain('open-settings | Settings… | 设置, 偏好, preferences')
    expect(prompt).toContain('settings-accounts | Settings ▸ Accounts | 账号, 账户, token')
    expect(prompt).not.toContain('restart-session')
    expect(prompt).not.toContain('scheduled-jobs')
  })
})

describe('parseRoute: an answer is checked before anything uses it', () => {
  it('reads a workspace by its number, with title and reason', () => {
    expect(
      parseRoute(
        reply({
          workspace: 1,
          worktree: { new: 'safari-login' },
          title: 'Safari 登录',
          why: 'The login bug lives in app.'
        }),
        LIST
      )
    ).toEqual({
      kind: 'workspace',
      path: '/Users/me/code/app',
      worktree: { kind: 'new', name: 'safari-login' },
      title: 'Safari 登录',
      why: 'The login bug lives in app.'
    })
  })

  it('reads a feature only by a key it was offered, also when the answer leaves out its hand, and a session only by a ref it was shown', () => {
    expect(parseRoute(reply({ hand: 'feature', feature: 'check-update' }), LIST)).toEqual({
      kind: 'feature',
      key: 'check-update',
      title: '',
      why: ''
    })
    expect(parseRoute(reply({ feature: 'check-update' }), LIST)).toMatchObject({
      kind: 'feature',
      key: 'check-update'
    })
    expect(parseRoute(reply({ hand: 'feature', feature: 'restart-session' }), LIST)).toBeNull()
    expect(parseRoute(reply({ hand: 'feature', feature: 'nope' }), LIST)).toBeNull()
    expect(parseRoute(reply({ hand: 'session', session: '3.2' }), LIST)).toMatchObject({
      kind: 'session',
      path: '/Users/me/notes',
      id: 'sess-plan'
    })
    expect(parseRoute(reply({ hand: 'session', session: 1.1 }), LIST)).toMatchObject({
      id: 'sess-safari'
    })
    expect(parseRoute(reply({ hand: 'session', session: '2.1' }), LIST)).toBeNull()
  })

  it('gives a new worktree that clashes with a listed one the next free -N, and drops a bad or reserved name and the main checkout of a git folder', () => {
    const tree = (worktree: unknown): unknown => {
      const r = parseRoute(reply({ workspace: 1, worktree }), LIST)
      return r?.kind === 'workspace' ? r.worktree : undefined
    }
    expect(tree({ new: 'Fix-Login' })).toEqual({ kind: 'new', name: 'Fix-Login-2' })
    expect(tree({ new: '../x' })).toBeNull()
    expect(tree({ new: 'main' })).toBeNull()
    expect(tree({ existing: 'redis-cache' })).toBeNull()
    expect(tree({ issue: 433 })).toEqual({ kind: 'issue', number: 433 })
    expect(tree({ issue: -1 })).toBeNull()
    expect(tree('main')).toBeNull()
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

  it('hands a message about Koloft itself to the global Assist, and "ask <workspace> …" to that workspace’s Assist; an unknown hand is ordinary work', () => {
    expect(
      parseRoute(reply({ hand: 'koloft', title: 'Dark mode', why: 'A setting.' }), LIST)
    ).toEqual({ kind: 'koloft', title: 'Dark mode', why: 'A setting.' })
    expect(parseRoute(reply({ hand: 'discord', title: 'Discord' }), LIST)).toEqual({
      kind: 'discord',
      title: 'Discord',
      why: ''
    })
    expect(parseRoute(reply({ hand: 'assist', workspace: 2, title: 'Ask api' }), LIST)).toEqual({
      kind: 'assist',
      path: 'devbox:/srv/api',
      title: 'Ask api',
      why: ''
    })
    expect(parseRoute(reply({ hand: 'assist', workspace: 9 }), LIST)).toBeNull()
    expect(
      parseRoute(reply({ hand: 'other', workspace: 1, worktree: 'main' }), LIST)
    ).toMatchObject({ kind: 'workspace', path: '/Users/me/code/app' })
  })

  it('a reply that names the check-in rule goes to that workspace’s Assist even when its shape is the new-session one', () => {
    expect(
      parseRoute(reply({ rule: 1, workspace: 1, worktree: 'main', title: 'Progress' }), LIST)
    ).toEqual({ kind: 'assist', path: '/Users/me/code/app', title: 'Progress', why: '' })
    expect(parseRoute(reply({ rule: 6, workspace: 1, worktree: 'main' }), LIST)).toMatchObject({
      kind: 'workspace',
      path: '/Users/me/code/app'
    })
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
