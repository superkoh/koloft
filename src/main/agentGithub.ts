import { answered, EXIT_USAGE, refused, type AgentVerb } from './agentRequests'

export const GH_USAGE =
  'koloft: usage: koloft gh <any gh command but auth, alias or extension>, like: koloft gh pr view 389'

const REFUSED_COMMANDS = new Set(['auth', 'alias', 'extension'])

export const GH_REFUSED =
  'koloft: koloft gh runs every gh command but auth, alias and extension, which could print or change the sign-in.'

const JQ_FLAGS = new Set(['--jq', '-q'])
const READS_THE_ENVIRONMENT = /env/i

export const GH_JQ_READS_ENV =
  'koloft: a --jq filter may not read the environment, which holds the GitHub sign-in.'

const REPLY_CHARS_A_TURN_HOLDS = 20_000

export interface GithubVerbDeps {
  run(args: string[], tabId: string, cwd: string): Promise<{ ok: boolean; out: string }>
}

function flagName(arg: string): string {
  const eq = arg.indexOf('=')
  return eq < 0 ? arg : arg.slice(0, eq)
}

export function repoFlagOf(args: string[]): string | undefined {
  const at = args.findIndex((a) => flagName(a) === '--repo' || a === '-R')
  if (at < 0) return undefined
  return args[at] === '--repo' || args[at] === '-R'
    ? args[at + 1]
    : args[at].slice('--repo='.length)
}

function jqReadsTheEnvironment(args: string[]): boolean {
  return args.some((arg, i) => {
    const filter = JQ_FLAGS.has(arg) ? args[i + 1] : JQ_FLAGS.has(flagName(arg)) ? arg : undefined
    return filter !== undefined && READS_THE_ENVIRONMENT.test(filter)
  })
}

// ADR-0029
export function githubVerb(d: GithubVerbDeps): AgentVerb {
  return async (args, caller) => {
    const [command] = args
    if (!command || command.startsWith('-')) return refused(GH_USAGE, EXIT_USAGE)
    if (REFUSED_COMMANDS.has(command)) return refused(GH_REFUSED)
    if (jqReadsTheEnvironment(args)) return refused(GH_JQ_READS_ENV)
    const { ok, out } = await d.run(args, caller.tabId, caller.cwd)
    if (!ok) return refused(`koloft: gh ${args.slice(0, 2).join(' ')}: ${out}`)
    if (out.length <= REPLY_CHARS_A_TURN_HOLDS) return answered(out)
    return answered(
      `${out.slice(0, REPLY_CHARS_A_TURN_HOLDS)}\n[koloft: cut at ${REPLY_CHARS_A_TURN_HOLDS} characters; ask for less, e.g. --json with fewer fields]`
    )
  }
}
