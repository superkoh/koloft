import { describe, expect, it } from 'vitest'
import type { BackendId } from '../../src/shared/types'
import { koloftAssist } from '../../src/main/assist'
import {
  parseRoute,
  routeJob,
  type RouteWorkspace,
  type SessionRoute
} from '../../src/shared/sessionRoute'

const BINARIES: Record<BackendId, string | undefined> = {
  claude: process.env.KOLOFT_REAL_ROUTE_CLAUDE,
  codex: process.env.KOLOFT_REAL_ROUTE_CODEX
}

const LIST: RouteWorkspace[] = [
  {
    path: '/Users/me/Projects/koloft',
    machine: 'local',
    name: 'koloft',
    git: true,
    worktrees: ['cmd-p-catch-all', 'fix-login'],
    sessions: [
      { id: 'k-palette', title: '⌘P 起 worktree' },
      { id: 'k-codex', title: '修 Codex 账号余额' },
      { id: 'k-release', title: '发布 v0.43.0' }
    ]
  },
  {
    path: '/Users/me/Projects/blog',
    machine: 'local',
    name: 'blog',
    git: false,
    worktrees: [],
    sessions: [{ id: 'b-post', title: '写一篇关于 Electron 的文章' }]
  },
  {
    path: '/Users/me/Projects/shop-api',
    machine: 'local',
    name: 'shop-api',
    git: true,
    worktrees: [],
    sessions: [
      { id: 's-hook', title: 'add payment webhook' },
      { id: 's-flaky', title: 'fix flaky tests' }
    ]
  },
  {
    path: 'ssh://devbox/home/me/ml-train',
    machine: 'devbox',
    name: 'ml-train',
    git: true,
    worktrees: [],
    sessions: [{ id: 'm-lr', title: 'tune learning rate' }]
  }
]

function landing(route: SessionRoute | null): string {
  if (!route) return 'nothing'
  const folder = (p: string): string => p.split('/').pop() ?? p
  if (route.kind === 'workspace' || route.kind === 'assist')
    return `${route.kind}:${folder(route.path)}`
  if (route.kind === 'feature') return `feature:${route.key}`
  if (route.kind === 'session') return `session:${route.id}`
  return route.kind
}

const GLOBAL_ASSIST = 'koloft'

const CASES: [string, string[]][] = [
  ['koloft 里 ⌘P 回车后的 toast 文案改短一点', ['workspace:koloft']],
  ['fix the tests', [GLOBAL_ASSIST]],
  ['问一下 koloft 那边测试跑完了没', ['assist:koloft']],
  ['打开深色模式', [GLOBAL_ASSIST, 'feature:settings-appearance']],
  ['现在有哪些会话在等我回话', [GLOBAL_ASSIST]],
  ['PR 389 合了没', [GLOBAL_ASSIST]],
  ['把这段翻译成英文：今天天气很好', [GLOBAL_ASSIST]],
  ['东京现在几点', [GLOBAL_ASSIST]],
  ['让所有正在跑的会话都提交一下代码', [GLOBAL_ASSIST]],
  ['写一个新的番茄钟小工具', ['project']],
  ['打开设置', ['feature:open-settings']],
  ['检查更新', ['feature:check-update']],
  ['打开账号设置', ['feature:settings-accounts']],
  ['resume the session that was fixing login', [GLOBAL_ASSIST]],
  ['跳到修 Codex 账号余额那个会话', ['session:k-codex']],
  ['每天早上9点帮我跑一下 shop-api 的测试', [GLOBAL_ASSIST]],
  ['set up Discord', ['discord']]
]

for (const backend of ['claude', 'codex'] as const) {
  const binary = BINARIES[backend]
  const assist = koloftAssist({
    setting: () => ({ on: true, backend }),
    enabled: (b) => b === backend,
    claude: async () => (binary ? { binary, env: process.env } : null),
    codex: async () => (binary ? { binary, env: process.env } : null)
  })

  describe
    .skipIf(!binary)
    .concurrent(
      `⌘P routing on the real ${backend}: each typed line lands where the rules in the prompt send it`,
      () => {
        for (const [typed, allowed] of CASES) {
          it(typed, { timeout: 60_000 }, async () => {
            const route = parseRoute(await assist(routeJob(LIST, typed)), LIST)
            expect(allowed).toContain(landing(route))
          })
        }
      }
    )
}
