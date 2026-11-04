import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const runs = Number(process.argv[2] ?? 2)
const backends = (process.argv[3] ?? 'claude,codex').split(',')
const outFile = path.join(here, 'results.jsonl')

const bundle = path.join(os.tmpdir(), `route-${process.pid}.mjs`)
execFileSync(
  path.join(repo, 'node_modules/.bin/esbuild'),
  [
    path.join(repo, 'src/shared/sessionRoute.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${bundle}`
  ],
  { stdio: 'ignore' }
)
const { routeJob, parseRoute } = await import(bundle)

const WORKSPACES = [
  {
    path: '/w/shop-api',
    machine: 'local',
    name: 'shop-api',
    git: true,
    worktrees: ['session-1102'],
    sessions: [
      { id: 'a1', title: 'Fix checkout tax rounding' },
      { id: 'a2', title: 'Add coupon endpoint' }
    ]
  },
  {
    path: '/w/blog',
    machine: 'local',
    name: 'blog',
    git: false,
    worktrees: [],
    sessions: [{ id: 'b1', title: 'Write post about caching' }]
  },
  {
    path: '/w/mobile-app',
    machine: 'local',
    name: 'mobile-app',
    git: true,
    worktrees: [],
    sessions: [{ id: 'c1', title: '登录页改版' }]
  },
  {
    path: '/w/ml-notebooks',
    machine: 'gpu-box',
    name: 'ml-notebooks',
    git: false,
    worktrees: [],
    sessions: []
  }
]

const MESSAGES = [
  '给 shop-api 的结账接口加一个按国家算税的功能',
  'why does the blog sidebar not show the tag list',
  'mobile-app 登录页在小屏上按钮被挡住了，修一下',
  '做一个把 markdown 转成幻灯片的小工具',
  '把这段话翻成英文：今天天气很好',
  '问一下 shop-api 那边优惠券接口做完没'
]

const WHY_LINE =
  ' "why": <one short sentence in the language of the message, naming the rule you took>,\n "rule": <the number of the rule you named in "why">'
const NO_WHY_LINE =
  ' "why" (rule 7 only, leave it out for every other rule): <one short sentence in the language of the message>,\n "rule": <the number of the rule you took>'

function jobs(message) {
  const full = routeJob(WORKSPACES, message)
  if (!full.prompt.includes(WHY_LINE)) throw new Error('the prompt changed: update WHY_LINE')
  return {
    withWhy: full,
    withoutWhy: { system: full.system, prompt: full.prompt.replace(WHY_LINE, NO_WHY_LINE) }
  }
}

function run(binary, argv, stdin) {
  return new Promise((resolve) => {
    const started = performance.now()
    const child = spawn(binary, argv, { cwd: os.tmpdir() })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) =>
      resolve({ code, out, err: err.slice(-500), ms: Math.round(performance.now() - started) })
    )
    child.stdin.end(stdin)
  })
}

const ONE_SHOT = {
  claude: async (job) => {
    const r = await run(
      'claude',
      [
        '-p',
        '--model',
        'haiku',
        '--no-session-persistence',
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--system-prompt',
        job.system,
        '--tools',
        '',
        '--output-format',
        'json'
      ],
      job.prompt
    )
    try {
      const j = JSON.parse(r.out)
      return {
        ...r,
        reply: j.result,
        outputTokens: j.usage?.output_tokens,
        apiMs: j.duration_api_ms
      }
    } catch {
      return { ...r, reply: null }
    }
  },
  codex: async (job) => {
    const r = await run(
      'codex',
      [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '-s',
        'read-only',
        '-m',
        'gpt-6-luna',
        '-C',
        os.tmpdir(),
        '-'
      ],
      `${job.system}\n\n${job.prompt}`
    )
    return { ...r, reply: r.code === 0 ? r.out : null }
  }
}

function routeKey(route) {
  if (!route) return 'unparsed'
  const where = route.path ? path.basename(route.path) : (route.machine ?? '')
  return `${route.kind}:${where}`
}

for (let i = 0; i < runs; i++) {
  for (const backend of backends) {
    for (const message of MESSAGES) {
      for (const [variant, job] of Object.entries(jobs(message))) {
        const r = await ONE_SHOT[backend](job)
        const route = r.reply ? parseRoute(r.reply, WORKSPACES) : null
        const row = {
          backend,
          variant,
          message,
          ms: r.ms,
          apiMs: r.apiMs,
          replyChars: r.reply?.length ?? null,
          outputTokens: r.outputTokens,
          route: routeKey(route),
          why: route?.why ?? null,
          reply: r.reply,
          error: r.reply ? undefined : r.err
        }
        fs.appendFileSync(outFile, JSON.stringify(row) + '\n')
        console.log(backend, variant, r.ms, row.replyChars, row.route)
      }
    }
  }
}
fs.rmSync(bundle, { force: true })
