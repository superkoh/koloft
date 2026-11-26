// ADR-0054
import type {
  AccountAddResult,
  McpServer,
  SignInNews,
  SignInProgress,
  SignInStart
} from '@shared/types'
import type { ListedModel } from '@shared/sessionPicks'
import type { AssistJob, ModelAndEffort } from '../assistModels'
import {
  AGENT_IDS,
  accountKindFacts,
  agentManifest,
  agentOfAccountKind,
  type AccountKindId,
  type AgentId
} from './registry'
import type { AgentUsage } from './usage'
import type { AgentSearch } from './search'

export interface OneShotTarget {
  binary: string
  env: NodeJS.ProcessEnv
  args?: string[]
  done(): void
}

export interface AgentOneShot {
  argv(job: AssistJob, launch: ModelAndEffort): string[]
  stdin(job: AssistJob): string
  answerFrom(stdout: string): string | null
  sometimesAnswersLate: boolean
  saysItHasNoSuchModel: RegExp
}

export interface AgentCatalog {
  moreSkillFoldersEveryAccountReadsOnThisMac(): readonly string[]
  mcpServersOn(folders: readonly string[]): Promise<McpServer[]>
  listedModels(): Promise<ListedModel[] | undefined>
  oneShot: AgentOneShot
}

export interface AgentTools {
  shimScript(): string
}

export interface AgentShimScript {
  command: string
  script: string
}

export interface EnsureOnTheMachine {
  word: string | undefined
  functions: string
  install: string
  whichNodeWillDo: string
}

export interface AgentMachinePackage {
  filesForTheMachinePackage(): Record<string, string>
  ensureOnTheMachine: EnsureOnTheMachine | null
}

export const NO_SUCH_ACTION = 'noSuchAction'

export interface StartAsk {
  tabId: string
  resumeSessionId?: string
}

export interface AgentAccounts {
  pickForThisStart(ask: StartAsk): Promise<object>
  probeAll(): Promise<void>
  addSecret(
    kind: AccountKindId,
    name: string,
    secret: string,
    endpoint?: { baseUrl?: string; model?: string }
  ): Promise<AccountAddResult>
  forget(kind: AccountKindId, name: string): void
  folderSaysItRunsOnAKey(kind: AccountKindId, name: string): boolean
  signIn(kind: AccountKindId, name: string, again: boolean): Promise<SignInStart>
  cancelSignIn(kind: AccountKindId, name: string): void
  act(kind: AccountKindId, name: string, action: string): Promise<string>
}

type SignInListener = (news: SignInNews, heldFailureChanged: boolean) => void

export interface AgentMain {
  id: AgentId
  oneShotTarget(): Promise<OneShotTarget | null>
  catalog: AgentCatalog
  tools: AgentTools
  machinePackage: AgentMachinePackage
  accounts: AgentAccounts
  usage: AgentUsage
  search: AgentSearch
}

export class AgentsMain {
  private built = new Map<AgentId, AgentMain>()

  register(agent: AgentMain): void {
    this.built.set(agent.id, agent)
  }

  inListOrder(): AgentMain[] {
    return AGENT_IDS.flatMap((id) => this.built.get(id) ?? [])
  }

  async oneShotTarget(id: AgentId): Promise<OneShotTarget | null> {
    return (await this.built.get(id)?.oneShotTarget()) ?? null
  }

  oneShot(id: AgentId): AgentOneShot | undefined {
    return this.built.get(id)?.catalog.oneShot
  }

  async listedModels(id: AgentId): Promise<ListedModel[] | undefined> {
    return this.built.get(id)?.catalog.listedModels()
  }

  moreSkillFoldersEveryAccountReadsOnThisMac(id: AgentId): readonly string[] {
    return this.built.get(id)?.catalog.moreSkillFoldersEveryAccountReadsOnThisMac() ?? []
  }

  shimScripts(): AgentShimScript[] {
    return this.inListOrder().map((agent) => ({
      command: agentManifest(agent.id).command,
      script: agent.tools.shimScript()
    }))
  }

  filesForTheMachinePackage(): Record<string, string> {
    return Object.assign(
      {},
      ...this.inListOrder().map((agent) => agent.machinePackage.filesForTheMachinePackage())
    )
  }

  ensuresOnTheMachine(): EnsureOnTheMachine[] {
    return this.inListOrder().flatMap((agent) => agent.machinePackage.ensureOnTheMachine ?? [])
  }

  async mcpServersOn(folders: readonly string[]): Promise<McpServer[]> {
    const each = await Promise.all(
      this.inListOrder().map((agent) => agent.catalog.mcpServersOn(folders))
    )
    return each.flat()
  }

  private ownerOf(kind: AccountKindId): AgentMain | undefined {
    const id = agentOfAccountKind(kind)
    return id && this.built.get(id)
  }

  async pickForThisStart(id: AgentId | undefined, ask: StartAsk): Promise<object> {
    const agent = id && this.built.get(id)
    return agent ? agent.accounts.pickForThisStart(ask) : {}
  }

  async probeAllAccounts(): Promise<void> {
    await Promise.all(this.inListOrder().map((agent) => agent.accounts.probeAll()))
  }

  addSecret(
    kind: AccountKindId,
    name: string,
    secret: string,
    endpoint?: { baseUrl?: string; model?: string }
  ): Promise<AccountAddResult> {
    const owner = this.ownerOf(kind)
    if (!owner) throw new Error(`No agent keeps accounts of the kind ${kind}.`)
    return owner.accounts.addSecret(kind, name, secret, endpoint)
  }

  forgetAccount(kind: AccountKindId, name: string): void {
    this.ownerOf(kind)?.accounts.forget(kind, name)
  }

  folderSaysItRunsOnAKey(kind: AccountKindId, name: string): boolean {
    return this.ownerOf(kind)?.accounts.folderSaysItRunsOnAKey(kind, name) ?? false
  }

  async act(kind: AccountKindId, name: string, action: string): Promise<string> {
    return (await this.ownerOf(kind)?.accounts.act(kind, name, action)) ?? NO_SUCH_ACTION
  }

  private heldFailure: SignInProgress | null = null
  private tabsSigningIn = new Map<string, number>()
  private signInListener: SignInListener = () => {}

  watchSignIns(listener: SignInListener): void {
    this.signInListener = listener
  }

  async signIn(kind: AccountKindId, name: string, again: boolean): Promise<SignInStart> {
    const owner = this.ownerOf(kind)
    if (!owner || !accountKindFacts(kind).signsInThroughABrowser)
      return { ok: false, error: 'invalid-name' }
    return owner.accounts.signIn(kind, name, again)
  }

  signInChanged(progress: SignInProgress): void {
    const key = `${progress.kind}:${progress.name}`
    const tabs = this.tabsSigningIn.get(key) ?? 0
    if (progress.phase === 'inATab') this.tabsSigningIn.set(key, tabs + 1)
    const held = progress.phase === 'failed' && tabs > 0
    if (held) {
      this.tabsSigningIn.set(key, tabs - 1)
      this.heldFailure = progress
    }
    this.signInListener({ progress, heldFailure: this.heldFailure }, held)
  }

  heldSignInFailure(): SignInProgress | null {
    return this.heldFailure
  }

  forgetHeldSignInFailure(): void {
    this.heldFailure = null
    this.signInListener({ progress: null, heldFailure: null }, true)
  }

  endSignIn(kind: AccountKindId, name: string): void {
    if (this.heldFailure?.kind === kind && this.heldFailure.name === name)
      this.forgetHeldSignInFailure()
    this.ownerOf(kind)?.accounts.cancelSignIn(kind, name)
  }
}
