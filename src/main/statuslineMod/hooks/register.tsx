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

async function refreshGit($: EngineInterface): Promise<void> {
  try {
    const branch = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch.exitCode !== 0) {
      git = null
    } else {
      const [gitDir, unstaged, staged] = await Promise.all([
        $.process.run(['git', 'rev-parse', '--git-dir']),
        $.process.run(['git', 'diff', '--shortstat']),
        $.process.run(['git', 'diff', '--cached', '--shortstat'])
      ])
      git = {
        branch: branch.stdout.trim(),
        worktree: worktreeName(gitDir.stdout.trim()),
        added:
          shortstatCount(unstaged.stdout, 'insertion') + shortstatCount(staged.stdout, 'insertion'),
        removed:
          shortstatCount(unstaged.stdout, 'deletion') + shortstatCount(staged.stdout, 'deletion')
      }
    }
  } catch {
    git = null
  }
  $.ui.invalidate('ui.render')
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refreshGit($)
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const effort = e.effort === undefined ? undefined : String(e.effort)
    if (effort !== stepEffort) {
      stepEffort = effort
      $.ui.invalidate('ui.render')
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refreshGit($)
    return done
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [usage, model, version, cwd, account, home, settings] = await Promise.all([
      $.session.usage(),
      $.session.model(),
      $.session.version(),
      $.session.cwd(),
      $.env.get('ANT_ACCOUNT'),
      $.env.get('HOME'),
      $.settings.read()
    ])
    const effort =
      stepEffort ?? (typeof settings.effortLevel === 'string' ? settings.effortLevel : '')
    const percent = usage.context.percent
    const cost = usage.cost?.usd
    const rows: string[][] = [
      [
        account ?? '',
        percent === undefined ? '' : `${percent.toFixed(1)}%`,
        git ? `(+${git.added},-${git.removed})` : '',
        git?.branch ?? '',
        git?.worktree ?? ''
      ],
      [version.version, modelName(model), effort, cost === undefined ? '' : `$${cost.toFixed(2)}`],
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
          i === parts.length - 1 ? (
            <Text color={color.bg}>{POWERLINE_ARROW}</Text>
          ) : (
            <Text color={color.bg} backgroundColor={after.bg}>
              {POWERLINE_ARROW}
            </Text>
          )
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
