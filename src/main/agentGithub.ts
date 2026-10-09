import { GH_FLAGS, GH_READS, GH_READS_TEXT } from '@shared/githubReads'
import { answered, EXIT_USAGE, refused, type AgentVerb } from './agentRequests'

export const GH_USAGE = `koloft: usage: koloft gh ${GH_READS_TEXT} [<number or URL>] [flags], with only the flags ${GH_FLAGS.join(', ')}.`
export const GH_ONLY_A_CONDUCTOR =
  'koloft: only a conductor (a session bound to a Discord channel) can run koloft gh; a session runs gh itself.'
export const GH_NEEDS_A_REPO =
  'koloft: this conductor has no workspace to take the repository from; add --repo <owner>/<name>, or give a full GitHub URL.'

const FLAGS = new Set(GH_FLAGS)

const REPLY_CHARS_A_CONDUCTOR_TURN_HOLDS = 20_000

export interface GithubVerbDeps {
  scopeOf(tabId: string): string | undefined
  repoOf(scope: string): Promise<string | null>
  run(args: string[]): Promise<{ ok: boolean; out: string }>
}

function flagName(arg: string): string {
  const eq = arg.indexOf('=')
  return eq < 0 ? arg : arg.slice(0, eq)
}

// ADR-0029
export function githubVerb(d: GithubVerbDeps): AgentVerb {
  return async (args, caller) => {
    const [noun, action, ...rest] = args
    if (!noun || !action || !GH_READS[noun]?.includes(action)) return refused(GH_USAGE, EXIT_USAGE)
    if (rest.some((a) => a.startsWith('-') && !FLAGS.has(flagName(a))))
      return refused(GH_USAGE, EXIT_USAGE)
    const scope = d.scopeOf(caller.tabId)
    if (scope === undefined) return refused(GH_ONLY_A_CONDUCTOR)
    const gh = [...args]
    if (!rest.some((a) => flagName(a) === '--repo' || a.startsWith('https://'))) {
      const repo = await d.repoOf(scope)
      if (!repo) return refused(GH_NEEDS_A_REPO)
      gh.push('--repo', repo)
    }
    const { ok, out } = await d.run(gh)
    if (!ok) return refused(`koloft: gh ${noun} ${action}: ${out}`)
    if (out.length <= REPLY_CHARS_A_CONDUCTOR_TURN_HOLDS) return answered(out)
    return answered(
      `${out.slice(0, REPLY_CHARS_A_CONDUCTOR_TURN_HOLDS)}\n[koloft: cut at ${REPLY_CHARS_A_CONDUCTOR_TURN_HOLDS} characters; ask for less, e.g. --json with fewer fields]`
    )
  }
}
