import type { EngineInterface, Register } from 'claude-code'

const NORD_AURORA_256 = [
  { bg: '#af5f5f', fg: '#ffffff' },
  { bg: '#ffd700', fg: '#000000' },
  { bg: '#5f87d7', fg: '#ffffff' },
  { bg: '#87af87', fg: '#000000' },
  { bg: '#d787d7', fg: '#000000' }
]
const POWERLINE_ARROW = ''

interface Git {
  branch: string
  worktree: string
  added: number
  removed: number
}

let git: Git | null = null
let stepEffort: string | undefined
let session = { version: '', account: '', home: '', effortLevel: '' }

const shortstatCount = (stat: string, word: string): number =>
  Number(new RegExp(`(\\d+) ${word}`).exec(stat)?.[1] ?? 0)

const worktreeName = (gitDir: string): string => {
  if (gitDir === '.git' || gitDir.endsWith('/.git')) return 'main'
  const at = gitDir.lastIndexOf('/worktrees/')
  return at === -1 ? '' : gitDir.slice(at + '/worktrees/'.length)
}

const modelName = (id: string): string => {
  const parts = id
    .replace(/\[.*\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .split('-')
  const family = parts.find((p) => /^[a-z]+$/.test(p))
  if (!family) return id
  const numbers = parts.filter((p) => /^\d+$/.test(p)).join('.')
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${numbers}`.trim()
}

async function readGit($: EngineInterface): Promise<Git | null> {
  const [branch, gitDir, unstaged, staged] = await Promise.all([
    $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD']),
    $.process.run(['git', 'rev-parse', '--git-dir']),
    $.process.run(['git', 'diff', '--shortstat']),
    $.process.run(['git', 'diff', '--cached', '--shortstat'])
  ])
  if (branch.exitCode !== 0) return null
  return {
    branch: branch.stdout.trim(),
    worktree: worktreeName(gitDir.stdout.trim()),
    added:
      shortstatCount(unstaged.stdout, 'insertion') + shortstatCount(staged.stdout, 'insertion'),
    removed: shortstatCount(unstaged.stdout, 'deletion') + shortstatCount(staged.stdout, 'deletion')
  }
}

async function refreshGit($: EngineInterface): Promise<void> {
  const fresh = await readGit($).catch(() => null)
  if (JSON.stringify(fresh) === JSON.stringify(git)) return
  git = fresh
  $.ui.invalidate('ui.render')
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const [version, account, home, settings] = await Promise.all([
      $.session.version(),
      $.env.get('ANT_ACCOUNT'),
      $.env.get('HOME'),
      $.settings.read()
    ])
    session = {
      version: version.version,
      account: account ?? '',
      home: home ?? '',
      effortLevel: typeof settings.effortLevel === 'string' ? settings.effortLevel : ''
    }
    await refreshGit($)
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const effort = e.effort === undefined ? undefined : String(e.effort)
    if (e.agentId === undefined && effort !== stepEffort) {
      stepEffort = effort
      $.ui.invalidate('ui.render')
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await refreshGit($)
    return done
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [usage, model, cwd] = await Promise.all([
      $.session.usage(),
      $.session.model(),
      $.session.cwd()
    ])
    const { version, account, home, effortLevel } = session
    const effort = stepEffort ?? effortLevel
    const percent = usage.context.percent
    const cost = usage.cost?.usd
    const rows: string[][] = [
      [
        account,
        percent === undefined ? '' : `${percent.toFixed(1)}%`,
        git ? `(+${git.added},-${git.removed})` : '',
        git?.branch ?? '',
        git?.worktree ?? ''
      ],
      [version, modelName(model), effort, cost === undefined ? '' : `$${cost.toFixed(2)}`],
      [home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd]
    ].map((row) => row.filter((part) => part !== ''))
    const powerline = (parts: string[]) =>
      parts.flatMap((part, i) => {
        const color = NORD_AURORA_256[i % NORD_AURORA_256.length]!
        const after = NORD_AURORA_256[(i + 1) % NORD_AURORA_256.length]!
        return [
          <Text bold color={color.fg} backgroundColor={color.bg}>
            {` ${part} `}
          </Text>,
          <Text color={color.bg} backgroundColor={i === parts.length - 1 ? undefined : after.bg}>
            {POWERLINE_ARROW}
          </Text>
        ]
      })
    return (
      <Box flexDirection="column">
        {rows
          .filter((row) => row.length > 0)
          .map((row) => (
            <Box>{powerline(row)}</Box>
          ))}
        <Text dimColor>{e.props.hint}</Text>
      </Box>
    )
  })
}
