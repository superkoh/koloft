import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { answered, EXIT_USAGE, refused, type AgentVerb } from './agentRequests'

export const GH_USAGE =
  "koloft: usage: koloft gh <one of gh's own commands but auth, alias, extension, config or copilot>, like: koloft gh pr view 389"

// PLATFORM§32
const GH_OWN_COMMANDS = new Set([
  'agent-task',
  'api',
  'attestation',
  'browse',
  'cache',
  'codespace',
  'completion',
  'discussion',
  'gist',
  'gpg-key',
  'issue',
  'label',
  'licenses',
  'org',
  'pr',
  'preview',
  'project',
  'release',
  'repo',
  'ruleset',
  'run',
  'search',
  'secret',
  'skill',
  'ssh-key',
  'status',
  'variable',
  'workflow'
])

export const GH_REFUSED =
  "koloft: koloft gh runs gh's own commands, but not auth, alias, extension, config or copilot, nor an alias or an extension: each could print the GitHub sign-in or run another program with it."

const READS_THE_ENVIRONMENT = /\benv\b|\$ENV/

export const GH_JQ_READS_ENV =
  'koloft: a --jq filter may not read the environment, which holds the GitHub sign-in.'

const HANDS_THE_REST_TO_ANOTHER_PROGRAM = '--'

export const GH_PASSES_THROUGH =
  'koloft: koloft gh takes no --: gh hands what follows it to git, ssh or scp, which run with the GitHub sign-in.'

const REPLY_CHARS_A_TURN_HOLDS = 20_000

export function cutForATurn(text: string, ifCut = ''): string {
  if (text.length <= REPLY_CHARS_A_TURN_HOLDS) return text
  return `${text.slice(0, REPLY_CHARS_A_TURN_HOLDS)}\n[koloft: cut at ${REPLY_CHARS_A_TURN_HOLDS} characters${ifCut}]`
}

export interface GithubVerbDeps {
  run(args: string[], tabId: string, cwd: string): Promise<{ ok: boolean; out: string }>
  writesInEnglishOnly(tabId: string): boolean
}

// PLATFORM§32
function flagValuesOf(args: string[], long: string, short: string): string[] {
  return args.flatMap((a, i) => {
    if (a === long || a === short) return args[i + 1] === undefined ? [] : [args[i + 1]]
    if (a.startsWith(`${long}=`)) return [a.slice(long.length + 1)]
    if (!a.startsWith('--') && a.startsWith(short)) return [a.slice(short.length).replace(/^=/, '')]
    return []
  })
}

export function repoFlagOf(args: string[]): string | undefined {
  return flagValuesOf(args, '--repo', '-R')[0]
}

const OPENS_AN_ISSUE_OR_PULL_REQUEST = /^(issue|pr) create$/
const CHINESE_JAPANESE_OR_KOREAN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

export const GH_WRITE_IT_IN_ENGLISH =
  'koloft: the butler opens a GitHub issue or pull request in English: write its title and body in English and run it again.'

async function textItOpensWith(args: string[], cwd: string): Promise<string[]> {
  const bodyFiles = flagValuesOf(args, '--body-file', '-F').filter((f) => f !== '-')
  const files = await Promise.all(
    bodyFiles.map((f) => readFile(path.resolve(cwd, f), 'utf8').catch(() => ''))
  )
  return [...flagValuesOf(args, '--title', '-t'), ...flagValuesOf(args, '--body', '-b'), ...files]
}

// PLATFORM§32
function jqFilters(args: string[]): string[] {
  return args.flatMap((a, i) => {
    if (a === '--jq' || a === '-q') return args[i + 1] === undefined ? [] : [args[i + 1]]
    if (a.startsWith('--jq=')) return [a.slice('--jq='.length)]
    const attached = /^-[A-Za-z]*q=?(.*)$/.exec(a)
    if (!attached || a.startsWith('--')) return []
    if (attached[1]) return [attached[1]]
    return args[i + 1] === undefined ? [] : [args[i + 1]]
  })
}

// ADR-0029
export function githubVerb(d: GithubVerbDeps): AgentVerb {
  return async (args, caller) => {
    const [command] = args
    if (!command || command.startsWith('-')) return refused(GH_USAGE, EXIT_USAGE)
    if (!GH_OWN_COMMANDS.has(command)) return refused(GH_REFUSED)
    if (jqFilters(args).some((f) => READS_THE_ENVIRONMENT.test(f))) return refused(GH_JQ_READS_ENV)
    // PLATFORM§32
    if (args.includes(HANDS_THE_REST_TO_ANOTHER_PROGRAM)) return refused(GH_PASSES_THROUGH)
    // ADR-0050
    if (
      d.writesInEnglishOnly(caller.tabId) &&
      OPENS_AN_ISSUE_OR_PULL_REQUEST.test(args.slice(0, 2).join(' ')) &&
      (await textItOpensWith(args, caller.cwd)).some((t) => CHINESE_JAPANESE_OR_KOREAN.test(t))
    )
      return refused(GH_WRITE_IT_IN_ENGLISH)
    const { ok, out } = await d.run(args, caller.tabId, caller.cwd)
    if (!ok) return refused(`koloft: gh ${args.slice(0, 2).join(' ')}: ${out}`)
    return answered(cutForATurn(out, '; ask for less, e.g. --json with fewer fields'))
  }
}
