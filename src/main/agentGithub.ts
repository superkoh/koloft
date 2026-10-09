import fs from 'fs'
import path from 'path'
import {
  GH_ISSUE_CREATE_FLAGS,
  GH_ISSUE_CREATE_TEXT,
  GH_READ_FLAGS,
  GH_READS,
  GH_READS_TEXT
} from '@shared/githubCommands'
import { answered, EXIT_USAGE, refused, type AgentVerb } from './agentRequests'

export const GH_USAGE = `koloft: usage: koloft gh ${GH_READS_TEXT} [<number or URL>] [flags], with only the flags ${GH_READ_FLAGS.join(', ')}; or koloft gh ${GH_ISSUE_CREATE_TEXT}, where --body-file <file in your own folder> may stand for --body.`
export const GH_ONLY_A_CONDUCTOR =
  'koloft: only a conductor (a session bound to a Discord channel) can run koloft gh; a session runs gh itself.'
export const GH_NEEDS_A_REPO =
  'koloft: this conductor has no workspace to take the repository from; add --repo <owner>/<name>, or give a full GitHub URL.'
export const GH_BODY_FILE_OUTSIDE_OWN_FOLDER =
  'koloft: --body-file must name a file in your own folder, the one you run in; or give the text with --body.'

const READ_FLAGS = new Set(GH_READ_FLAGS)
const ISSUE_CREATE_FLAGS = new Set(GH_ISSUE_CREATE_FLAGS)

const REPLY_CHARS_A_CONDUCTOR_TURN_HOLDS = 20_000

export interface GithubVerbDeps {
  scopeOf(tabId: string): string | undefined
  folderOf(scope: string): string
  repoOf(scope: string): Promise<string | null>
  run(args: string[]): Promise<{ ok: boolean; out: string }>
}

function flagName(arg: string): string {
  const eq = arg.indexOf('=')
  return eq < 0 ? arg : arg.slice(0, eq)
}

function issueCreateFlags(rest: string[]): [string, string][] | null {
  const flags: [string, string][] = []
  for (let i = 0; i < rest.length; i++) {
    const name = flagName(rest[i])
    if (!ISSUE_CREATE_FLAGS.has(name)) return null
    if (name !== rest[i]) flags.push([name, rest[i].slice(name.length + 1)])
    else if (i + 1 < rest.length) flags.push([name, rest[++i]])
    else return null
  }
  return flags
}

async function realPathInside(folder: string, file: string): Promise<string | null> {
  try {
    const [root, real] = await Promise.all([
      fs.promises.realpath(folder),
      fs.promises.realpath(file)
    ])
    return real.startsWith(root + path.sep) ? real : null
  } catch {
    return null
  }
}

// ADR-0029
export function githubVerb(d: GithubVerbDeps): AgentVerb {
  return async (args, caller) => {
    const [noun, action, ...rest] = args
    const created = noun === 'issue' && action === 'create' ? issueCreateFlags(rest) : null
    if (!created) {
      if (!noun || !action || !GH_READS[noun]?.includes(action))
        return refused(GH_USAGE, EXIT_USAGE)
      if (rest.some((a) => a.startsWith('-') && !READ_FLAGS.has(flagName(a))))
        return refused(GH_USAGE, EXIT_USAGE)
    }
    const scope = d.scopeOf(caller.tabId)
    if (scope === undefined) return refused(GH_ONLY_A_CONDUCTOR)
    let gh = [...args]
    let repoNamed = rest.some((a) => flagName(a) === '--repo' || a.startsWith('https://'))
    if (created) {
      for (const flag of created) {
        if (flag[0] !== '--body-file') continue
        const real = await realPathInside(d.folderOf(scope), path.resolve(caller.cwd, flag[1]))
        if (!real) return refused(GH_BODY_FILE_OUTSIDE_OWN_FOLDER)
        flag[1] = real
      }
      // PLATFORM§32
      gh = [noun, action, ...created.map(([name, value]) => `${name}=${value}`)]
      repoNamed = created.some(([name]) => name === '--repo')
    }
    if (!repoNamed) {
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
