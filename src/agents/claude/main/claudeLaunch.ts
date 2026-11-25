import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { CronEffort, LaunchPermission } from '@shared/types'
import { shq } from '@shared/shellQuote'
import { portOffset } from '@shared/worktreeName'
import { pictureFolderIn } from '@shared/pastedPictures'
import { aboveItsTools } from '../../../main/agentLift'
import { AGENT_PROMPT_FILE } from '../../../main/agentPromptFile'
import type { RemoteTab } from '../../../main/host/host'
import type { Machine, TabProgram } from '../../../main/host/machine'
import { ownerTextOver, type LaunchIdentity } from '../../../main/launchPrompt'
import { resolveSpawnCwd } from '../../../main/projectInfo'
import {
  ACCOUNT_ENV_HELD_IN_MEMORY,
  AGENT_PLUGIN_DIR,
  CLAUDE_BIN_DIR,
  DOCS_PLUGIN_DIR,
  EXEC_ARGS_THROUGH_THE_STATUS_RELAY,
  MACHINE_PICTURES_DIR_TAIL
} from '../../../main/remote/launch'
import {
  mirrorHookDir,
  REMOTE_HOOK_DIR,
  remoteMachineDir,
  remoteTabPath
} from '../../../main/remote/paths'
import { mirrorProjectsRoot } from './claudeMirror'
import { worktreeNameAround } from '../../../main/resumePlan'
import { claudeArgv } from './claudeArgs'
import {
  acceptClaudeTrust,
  claudeJsonPath,
  claudeTrustsFolder,
  markClaudeOnboarded
} from './claudeTrust'
import { TRUST_CWD_JS, TRUSTED_JS } from './claudeTrustJs'

export interface ClaudeLaunch {
  root: string
  cwd?: string
  fallbackCwd?: string
  resumeSessionId?: string
  worktree?: string
  model?: string
  effort?: CronEffort
  permission?: LaunchPermission
  firstPrompt?: string
  ownerWords?: string
  name?: string
  role?: string
  ownerText?: string
  conductor?: boolean
  trustFolder?: boolean
  projectRules?: string
  workspaceParts?: string[]
}

export interface MachineTab {
  tracking: RemoteTab
  cwd: string
  root: string
  hookMirror: string
  attachTo?: string
  pickKey?: string
  skipsPermissionChecks: boolean
}

export type ClaudeLaunchPlan =
  | { ok: false; code: 'invalid-args' }
  | {
      ok: true
      spawnCwd: string
      cwd: string
      shell?: string
      launchCommand: (tabId: string) => string
      resized?: (tabId: string, cols: number, rows: number) => void
      conductor: boolean
      extraEnv?: {
        KOLOFT_FIRST_PROMPT?: string
        KOLOFT_SESSION_NAME?: string
        KOLOFT_PICTURE_FOLDER?: string
        KOLOFT_PORT_OFFSET?: string
        KOLOFT_AGENT_PLUGIN?: string
        KOLOFT_AGENT_PROMPT?: string
        KOLOFT_OWNER_TEXT?: string
        KOLOFT_DOCS_PLUGIN?: string
      }
      envSetForThisTab?: Record<string, string>
      machine?: MachineTab
    }

export interface MachineAccount {
  env: Record<string, string>
  banner: string
}

export interface ClaudeHereDeps {
  writeConductorMarker(tabId: string, role: string): void
  handOverOwnerWords(tabId: string, words: string): void
  agentPlugin(): string | undefined
  projectPromptFile(userData: string, rules: string): string | undefined
  docsPlugin(): string | undefined
  assistOf(cwd: string, resumeKey?: string): LaunchIdentity | undefined
  pastedPicturesDir(): string
}

export interface ClaudeOnMachineDeps {
  realPath(machine: string, p: string): string
  settings(): { skipPermissions: boolean }
  agentTools(): boolean
  projectPrompt(rules: string): string
  docsWritingOn(): boolean
  pickAccount(launchKey: string, resumeSessionId?: string): Promise<MachineAccount | undefined>
  noAccountMessage(): string
  hookSettings(tabId: string, machineDir: string, allowKoloft: boolean): Record<string, unknown>
}

export async function launchClaudeHere(
  d: ClaudeHereDeps,
  spec: ClaudeLaunch
): Promise<ClaudeLaunchPlan> {
  const args = claudeArgv(process.env.KOLOFT_CLAUDE_CMD || 'claude', {
    resumeSessionId: spec.resumeSessionId,
    worktree: spec.worktree,
    model: spec.model,
    effort: spec.effort,
    permission: spec.permission
  })
  if (!args.ok) return args
  try {
    markClaudeOnboarded(claudeJsonPath())
  } catch (err) {
    console.error('[koloft] could not mark Claude onboarding done', err)
  }
  if (spec.trustFolder) trustFolder(spec.cwd ?? spec.root)
  // CC§18 ADR-0026
  const pictures = spec.resumeSessionId
    ? undefined
    : pictureFolderIn(spec.firstPrompt ?? '', (folder) => folder === d.pastedPicturesDir())
  if (pictures) trustFolder(pictures)
  const cwd = resolveSpawnCwd(spec.cwd ?? spec.root)
  const launchCommand = `exec ${aboveItsTools(args.argv).join(' ')}`
  const worktree = spec.worktree ?? worktreeNameAround(cwd)
  // ADR-0029
  const assist = d.assistOf(cwd, spec.resumeSessionId)
  const conductor = !!spec.conductor || !!assist
  const role = spec.role ?? assist?.role
  // CC§23
  const ownerText = ownerTextOver(
    spec.ownerText ?? assist?.ownerText,
    conductor,
    spec.workspaceParts
  )
  const agentPlugin = d.agentPlugin()
  const prompt =
    agentPlugin && !conductor
      ? (spec.projectRules && d.projectPromptFile(path.dirname(agentPlugin), spec.projectRules)) ||
        path.join(agentPlugin, AGENT_PROMPT_FILE)
      : undefined
  return {
    ok: true,
    spawnCwd: cwd,
    cwd,
    conductor,
    launchCommand: (tabId) => {
      if (role) d.writeConductorMarker(tabId, role)
      if (spec.ownerWords) d.handOverOwnerWords(tabId, spec.ownerWords)
      return launchCommand
    },
    extraEnv: {
      // CC§9
      ...(spec.firstPrompt !== undefined || spec.name
        ? {
            KOLOFT_FIRST_PROMPT: spec.firstPrompt ?? '',
            KOLOFT_SESSION_NAME: spec.name ?? '',
            KOLOFT_PICTURE_FOLDER: pictures
          }
        : {}),
      ...(worktree ? { KOLOFT_PORT_OFFSET: String(portOffset(worktree)) } : {}),
      KOLOFT_DOCS_PLUGIN: d.docsPlugin(),
      // CC§13
      ...(ownerText ? { KOLOFT_OWNER_TEXT: ownerText } : {}),
      ...(agentPlugin
        ? {
            KOLOFT_AGENT_PLUGIN: agentPlugin,
            KOLOFT_AGENT_PROMPT: prompt
          }
        : {})
    },
    envSetForThisTab: {
      // CC§12
      CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1',
      CLAUDE_CODE_DECSTBM: '1'
    }
  }
}

// ADR-0026
function trustFolder(dir: string): void {
  if (!fs.existsSync(dir)) return
  try {
    acceptClaudeTrust(claudeJsonPath(), dir)
  } catch (err) {
    console.error('[koloft] could not record Claude trust for', dir, err)
  }
}

export const claudeTrustsFolderHere = (dir: string): boolean =>
  claudeTrustsFolder(claudeJsonPath(), dir)

const NOT_TRUSTED = 1

const WITH_NODE_IN_REAL_DIR = `cd "$1" 2>/dev/null || exit ${NOT_TRUSTED}
command -v node >/dev/null 2>&1 || exit ${NOT_TRUSTED}
node -e "$2" "$HOME/.claude.json" "$(pwd -P)"`

// CC§9
export async function claudeTrustsFolderOnMachine(machine: Machine, dir: string): Promise<boolean> {
  const r = await machine.sh(WITH_NODE_IN_REAL_DIR, [machine.bare(dir), TRUSTED_JS])
  return r.code !== NOT_TRUSTED
}

function machinePermission(
  spec: ClaudeLaunch,
  skipPermissions: boolean
): ClaudeLaunch['permission'] {
  if (spec.permission && spec.permission !== 'default') return spec.permission
  return skipPermissions ? 'bypass' : undefined
}

const picturesHandedTo = (spec: ClaudeLaunch): string | undefined =>
  !spec.resumeSessionId && spec.firstPrompt
    ? pictureFolderIn(spec.firstPrompt, (folder) => folder.endsWith(MACHINE_PICTURES_DIR_TAIL))
    : undefined

// CC§9
export function machineClaudeArgs(
  spec: ClaudeLaunch,
  sessionId: string,
  skipPermissions: boolean
): { ok: true; args: string[]; pictures?: string } | { ok: false; code: 'invalid-args' } {
  const argv = claudeArgv('claude', {
    resumeSessionId: spec.resumeSessionId,
    sessionId: spec.resumeSessionId ? undefined : sessionId,
    worktree: spec.worktree,
    model: spec.model,
    effort: spec.effort,
    permission: machinePermission(spec, skipPermissions)
  })
  if (!argv.ok) return argv
  const fresh = !spec.resumeSessionId
  const pictures = picturesHandedTo(spec)
  return {
    ok: true,
    pictures,
    args: [
      ...argv.argv.slice(1),
      ...(fresh && spec.name ? ['--name', spec.name] : []),
      // CC§18
      ...(pictures ? ['--add-dir', pictures] : []),
      ...(fresh && spec.firstPrompt ? ['--', spec.firstPrompt] : [])
    ]
  }
}

export interface ClaudeTab {
  settings: Record<string, unknown>
  agentPlugin?: boolean
  docsPlugin?: boolean
  projectPrompt?: string
  ownerText?: string
  claudeArgs: string[]
  trustFolder?: boolean
  pictureFolder?: string
}

interface ClaudeTabPlace {
  tabId: string
  tmuxName: string
  cwd: string
  ownerWords?: string
}

const PROJECT_PROMPT_SUFFIX = '.prompt.md'
const OWNER_TEXT_SUFFIX = '.owner.md'

export const claudeTabProgram = (tab: ClaudeTabPlace, c: ClaudeTab): TabProgram => ({
  run: claudeRun(tab.tabId, c),
  beforeTmux: `${c.trustFolder ? trustOnTheMachine(tab.cwd) : ''}${c.pictureFolder ? trustOnTheMachine(c.pictureFolder) : ''}${claudeFirstRun(tab)}`,
  whenItEnds: '',
  files: {
    [`${tab.tabId}.json`]: JSON.stringify(c.settings),
    [`${tab.tabId}.tmux`]: tab.tmuxName,
    ...(c.agentPlugin &&
      c.projectPrompt && { [`${tab.tabId}${PROJECT_PROMPT_SUFFIX}`]: c.projectPrompt }),
    ...(c.ownerText && { [`${tab.tabId}${OWNER_TEXT_SUFFIX}`]: c.ownerText })
  }
})

// CC§12 CC§13
function claudeRun(tabId: string, c: ClaudeTab): string {
  const T = remoteTabPath(tabId)
  const prompt = c.projectPrompt
    ? `${T}${PROJECT_PROMPT_SUFFIX}`
    : `$M/${AGENT_PLUGIN_DIR}${AGENT_PROMPT_FILE}`
  const ownerText = c.ownerText ? ` --append-system-prompt "$(cat "${T}${OWNER_TEXT_SUFFIX}")"` : ''
  return `  PATH="$M/${CLAUDE_BIN_DIR}:$PATH"; export PATH
  set -- claude --settings "${T}.json"${c.docsPlugin ? ` --plugin-dir "$M/${DOCS_PLUGIN_DIR}"` : ''}${c.agentPlugin ? ` --plugin-dir "$M/${AGENT_PLUGIN_DIR}" --append-system-prompt-file "${prompt}"` : ''}${ownerText} ${c.claudeArgs.map(shq).join(' ')}
  ${EXEC_ARGS_THROUGH_THE_STATUS_RELAY.join('\n  ')}\n`
}

// CC§9 CC§18 ADR-0026
const trustOnTheMachine = (folder: string): string =>
  `( cd ${shq(folder)} 2>/dev/null && node -e ${shq(TRUST_CWD_JS)} "$HOME/.claude.json" "$(pwd -P)" ) >/dev/null 2>&1\n`

function claudeFirstRun(tab: ClaudeTabPlace): string {
  const T = remoteTabPath(tab.tabId)
  return `${tab.ownerWords ? `mkdir -p "${REMOTE_HOOK_DIR}" && mv -f "${T}".said* "${REMOTE_HOOK_DIR}/"\n` : ''}# CC§10
CJ="$HOME/.claude.json"
if [ -n "$${ACCOUNT_ENV_HELD_IN_MEMORY}" ]; then
  if [ ! -f "$CJ" ]; then printf '{"hasCompletedOnboarding":true}\\n' > "$CJ"
  elif ! grep -q hasCompletedOnboarding "$CJ" && [ "$(head -n1 "$CJ")" = "{" ]; then
    sed -i.koloft-bak '1s/^{/{"hasCompletedOnboarding":true,/' "$CJ" && rm -f "$CJ.koloft-bak"
  fi
  # CC§10
  if ! grep -q cachedGrowthBookFeatures "$CJ"; then
    echo '[Koloft] first run on this machine: fetching Claude settings (a few seconds)'
    ( set -a; eval "$${ACCOUNT_ENV_HELD_IN_MEMORY}"; set +a
      if command -v timeout >/dev/null 2>&1; then timeout 60 claude -p ok --max-turns 1; else claude -p ok --max-turns 1; fi ) >/dev/null 2>&1
  fi
fi
`
}

export async function launchClaudeOnMachine(
  machine: Machine,
  d: ClaudeOnMachineDeps,
  userData: string,
  spec: ClaudeLaunch
): Promise<ClaudeLaunchPlan> {
  await machine.ready()
  await machine.reachOrThrow()
  const settings = d.settings()
  const agentTools = d.agentTools()
  const sid = spec.resumeSessionId ?? crypto.randomUUID()
  const args = machineClaudeArgs(spec, sid, settings.skipPermissions)
  if (!args.ok) return args
  const opened = await machine.tmux.open({ session: sid })
  const starts = opened.mode === 'start'
  // CC§2
  const root = d.realPath(machine.name, machine.bare(spec.root))
  const cwd = spec.cwd ? machine.bare(spec.cwd) : root
  const wsRoot = spec.fallbackCwd ? d.realPath(machine.name, machine.bare(spec.fallbackCwd)) : root
  const worktree = spec.worktree ?? worktreeNameAround(cwd)
  const machineDir = remoteMachineDir(opened.packageName)
  const pickKey = starts ? `launch-${sid}` : undefined
  const account = pickKey ? await d.pickAccount(pickKey, spec.resumeSessionId) : undefined
  // ADR-0030
  if (pickKey && !account) throw new Error(d.noAccountMessage())
  const loginPath = starts ? await opened.loginPath : ''
  // CC§9
  const model = spec.model && account?.env.ANTHROPIC_MODEL ? args.args.indexOf('--model') : -1
  const claudeArgs = args.args.filter((_, i) => model < 0 || (i !== model && i !== model + 1))
  const projectPrompt = spec.projectRules && d.projectPrompt(spec.projectRules)
  return {
    ok: true,
    spawnCwd: opened.spawnCwd,
    cwd: spec.root,
    conductor: !!spec.conductor,
    shell: opened.shell,
    launchCommand: (tabId) =>
      opened.launchCommand(tabId, {
        cwd,
        fallbackCwd: wsRoot !== cwd ? wsRoot : undefined,
        banner: account?.banner ?? '',
        env: account?.env,
        portOffset: worktree ? portOffset(worktree) : undefined,
        ownerWords: spec.ownerWords,
        loginPath,
        program: claudeTabProgram(
          { tabId, tmuxName: opened.tmuxName, cwd, ownerWords: spec.ownerWords },
          {
            settings: d.hookSettings(tabId, machineDir, agentTools),
            agentPlugin: agentTools,
            docsPlugin: d.docsWritingOn(),
            projectPrompt,
            ownerText: ownerTextOver(spec.ownerText, !!spec.conductor, spec.workspaceParts),
            claudeArgs,
            trustFolder: spec.trustFolder,
            pictureFolder: args.pictures
          }
        )
      }),
    resized: opened.resized,
    machine: {
      tracking: {
        host: machine.name,
        projectsRoot: mirrorProjectsRoot(userData, machine.name),
        tmuxName: opened.tmuxName
      },
      cwd,
      root,
      hookMirror: mirrorHookDir(userData, machine.name),
      attachTo: starts ? undefined : sid,
      pickKey,
      skipsPermissionChecks: machinePermission(spec, settings.skipPermissions) === 'bypass'
    }
  }
}
