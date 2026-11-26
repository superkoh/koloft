import os from 'os'
import {
  takesAnEndpoint,
  type AccountAddResult,
  type AccountKind,
  type AccountMeta,
  type AccountView,
  type LoginProgress,
  type SignInProgress
} from '@shared/types'
import { ACCOUNT_KINDS_OF, noAccountLine } from '@shared/accountUsage'
import { stripTerminalCodes } from '@core/terminalCodes'
import { NO_SUCH_ACTION, type AgentAccounts, type StartAsk } from '@core/agent/agentsMain'
import {
  findAccount,
  keychainRead,
  keychainWrite,
  listAccounts,
  recordProbeOutcome,
  upsertAccountMeta,
  validateNewAccount
} from '../../../main/accounts'
import { loadSettings } from '../../../main/settings'
import {
  MARK_OUTPUT_START,
  afterOutputStart,
  outputStartCarry,
  plainTerminalTail
} from '../../../main/signInOutput'
import type { PtyManager } from '../../../main/ptyManager'
import type { LaunchedSession } from '../../../main/accountPicker'
import { probeAccount, shouldSkipFable } from './claudeAccountProbe'
import {
  AccountPicker,
  PROBE_TIMEOUT_MS,
  type PickResponse,
  type UsageSnapshots
} from './claudeAccountPicker'
import {
  CLAUDE_AUTH_ENV_VARS,
  claudeCodeGuessesWindowOf,
  pickMachineAccount
} from './claudeAccountEnv'

// CC§7
interface LoginWatch {
  name: string
  again: boolean
  buf: string
  sawUrl: boolean
  done: boolean
  giveUp: NodeJS.Timeout
  installing?: { carry: string }
}
const LOGIN_TIMEOUT_MS = 10 * 60_000
const LOGIN_TIMED_OUT = 'Sign-in timed out'
// CC§10
const INSTALL_SILENCE_LONGER_THAN_EITHER_SILENT_DOWNLOAD_AT_2_MBIT_MS = 30 * 60_000
const INSTALL_STALLED = `The Claude Code install did not finish: it printed nothing for ${INSTALL_SILENCE_LONGER_THAN_EITHER_SILENT_DOWNLOAD_AT_2_MBIT_MS / 60_000} minutes`
const LOGIN_BUF_MAX = 8192
const LOGIN_PTY_COLS_WIDER_THAN_TOKEN = 800
const ACCOUNT_PROBE_TIMEOUT_MS = 10_000
// CC§7
const AUTH_URL_RE = /https?:\/\/[^\s'"`<>\x00-\x1f\x7f]+(?=[\s'"`<>\x00-\x1f\x7f])/
// CC§7
const TOKEN_RE = /sk-ant-[A-Za-z0-9]{2,12}-[A-Za-z0-9_-]{24,}/

export function recordFableCapability(
  name: string,
  kind: AccountKind,
  fable: 'yes' | 'no',
  checkedAt: number = Date.now()
): void {
  const acct = findAccount(name, kind)
  if (!acct) return
  if (fable === 'no') upsertAccountMeta({ ...acct, fable, fableCheckedAt: checkedAt })
  else if (acct.fable !== 'yes') upsertAccountMeta({ ...acct, fable })
}

export interface ClaudeAccountDeps {
  ptyMgr: Pick<PtyManager, 'create' | 'get' | 'kill'>
  usageViews: Map<string, Omit<AccountView, keyof AccountMeta>>
  viewKey(name: string, kind: AccountKind): string
  accountViews(): AccountView[]
  pushAccounts(): void
  notifyExpired(name: string): void
  signInChanged(progress: SignInProgress): void
  savedUsage: UsageSnapshots
  tracker: {
    launchedSessions(): LaunchedSession[]
    setPickedAccount(tabId: string, account: string): void
  }
  sessionAccounts: { of(backend: 'claude', sessionId: string | undefined): string | undefined }
  claudeBackend: {
    picked(tabId: string, skipFlag: boolean): void
    forgetAvailability(): void
    availability(): Promise<{ available: boolean }>
  }
  loginEnvReady(): Promise<void>
  cronTestMs(name: string, dflt: number): number
  setupLine(): string | undefined
  PLAIN_KOLOFT_SHIM: Parameters<PtyManager['create']>[0]['koloftShim']
  installThen(backend: 'claude', then: (binary: string) => string, testInstaller?: string): string
  toolInstallPtys: { add(id: string): unknown }
}

export function claudeAccountsOf(deps: ClaudeAccountDeps) {
  const {
    ptyMgr,
    usageViews,
    viewKey,
    accountViews,
    pushAccounts,
    notifyExpired,
    signInChanged,
    savedUsage,
    tracker,
    sessionAccounts,
    claudeBackend,
    loginEnvReady,
    cronTestMs,
    setupLine,
    PLAIN_KOLOFT_SHIM,
    installThen,
    toolInstallPtys
  } = deps

  const loginWatchers = new Map<string, LoginWatch>()
  const loginPtys = new Set<string>()

  function foldProbeResult(
    name: string,
    kind: AccountKind,
    result: Awaited<ReturnType<typeof probeAccount>>
  ): void {
    const prevStatus = findAccount(name, kind)?.status
    const key = viewKey(name, kind)
    if (result.ok) {
      recordProbeOutcome(name, kind, 'ok')
      if (result.fable) recordFableCapability(name, kind, result.fable)
      usageViews.set(key, { usage: result.usage ?? usageViews.get(key)?.usage })
    } else {
      const status = recordProbeOutcome(name, kind, result.error === 'expired' ? '401' : 'fail')
      usageViews.set(key, { ...usageViews.get(key), probeError: result.error })
      if (status === 'expired' && prevStatus !== 'expired') notifyExpired(name)
    }
    pushAccounts()
  }

  const picker = new AccountPicker(
    {
      listAccounts,
      fablePriority: () => loadSettings().fablePriority,
      readSecret: (kind, name) => keychainRead(kind, name),
      probe: (a, secret) =>
        probeAccount(a.kind, secret, {
          timeoutMs: PROBE_TIMEOUT_MS,
          skipFable: shouldSkipFable(a, Date.now())
        }),
      onProbeOutcome: foldProbeResult,
      launchedSessions: () => tracker.launchedSessions(),
      recordPick: (tabId, account) => tracker.setPickedAccount(tabId, account),
      now: () => Date.now()
    },
    savedUsage
  )

  async function pickForLaunch(
    tabId?: string,
    resumeSessionId?: string
  ): Promise<{
    res: PickResponse
    endpoint?: { baseUrl?: string; model?: string }
  }> {
    let res: PickResponse
    try {
      res = await picker.pick(tabId, sessionAccounts?.of('claude', resumeSessionId))
    } catch {
      res = { account: null, reason: 'no-usable' }
    }
    if (!res.account || res.kind !== 'custom') return { res }
    const meta = findAccount(res.account, 'custom')
    return { res, endpoint: { baseUrl: meta?.baseUrl, model: meta?.model } }
  }

  async function pickedAccountEnv(): Promise<NodeJS.ProcessEnv | null> {
    await loginEnvReady()
    const picked = await pickMachineAccount(() => pickForLaunch())
    if (!picked) return null
    const env = { ...process.env }
    for (const k of CLAUDE_AUTH_ENV_VARS) delete env[k]
    // ADR-0030
    return { ...env, ...picked.env, KOLOFT_ACCOUNT_PICKED: '1' }
  }

  const shimAccountRefusals = new Map<string, string>()

  async function pickForThisStart(obj: StartAsk): Promise<object> {
    const { res, endpoint } = await pickForLaunch(obj.tabId, obj.resumeSessionId)
    const accountIssue = res.account === null && noAccountLine(listAccounts(), 'claude')
    if (accountIssue) shimAccountRefusals.set(obj.tabId, accountIssue)
    else shimAccountRefusals.delete(obj.tabId)
    const payload: Record<string, unknown> = { ...res }
    if (res.account && loadSettings().skipPermissions) payload.skipFlag = true
    claudeBackend.picked(obj.tabId, payload.skipFlag === true)
    if (endpoint?.baseUrl) payload.baseUrl = endpoint.baseUrl
    if (endpoint?.model) {
      payload.model = endpoint.model
      if (claudeCodeGuessesWindowOf(endpoint.model)) payload.disable1mContext = true
    }
    return payload
  }

  async function probeAll(): Promise<void> {
    const claude = listAccounts().filter(
      (a) => a.enabled && ACCOUNT_KINDS_OF.claude.includes(a.kind)
    )
    await Promise.all(
      claude.map(async (a) => {
        const secret = await keychainRead(a.kind, a.name)
        if (!secret) return
        const result = await probeAccount(a.kind, secret, {
          timeoutMs: ACCOUNT_PROBE_TIMEOUT_MS,
          skipFable: shouldSkipFable(a, Date.now()),
          baseUrl: a.baseUrl,
          model: a.model
        })
        foldProbeResult(a.name, a.kind, result)
        picker.probed(a.kind, a.name, result)
      })
    )
  }

  async function addSecret(
    kind: AccountKind,
    name: string,
    trimmed: string,
    endpoint?: { baseUrl?: string; model?: string }
  ): Promise<AccountAddResult> {
    const { baseUrl, model } = endpoint ?? {}
    if (!(await keychainWrite(kind, name, trimmed))) return { ok: false, error: 'unknown' }
    const result = await probeAccount(kind, trimmed, {
      timeoutMs: ACCOUNT_PROBE_TIMEOUT_MS,
      baseUrl,
      model
    })
    const meta: AccountMeta = {
      name,
      kind,
      enabled: true,
      fable: result.ok && result.fable ? result.fable : 'unknown',
      status: result.ok ? 'ok' : 'unverified',
      addedAt: Date.now(),
      ...(takesAnEndpoint(kind) ? { baseUrl, model } : {})
    }
    upsertAccountMeta(meta)
    if (result.ok && result.fable) recordFableCapability(name, kind, result.fable)
    const key = viewKey(name, kind)
    if (result.ok) usageViews.set(key, { usage: result.usage })
    else usageViews.set(key, { probeError: result.error })
    pushAccounts()
    const account = accountViews().find((a) => a.kind === kind && a.name === name)
    return result.ok ? { ok: true, account } : { ok: false, error: result.error, account }
  }

  function loginTimeoutMs(): number {
    return cronTestMs('KOLOFT_LOGIN_TIMEOUT_MS', LOGIN_TIMEOUT_MS)
  }

  function sendLoginProgress(p: LoginProgress, again: boolean): void {
    const { phase, name, url, tail, tabId, cwd } = p
    signInChanged({
      kind: 'oauth',
      name,
      again,
      phase,
      ...(url !== undefined && { url }),
      ...(tail !== undefined && { tail }),
      ...(tabId !== undefined && { tab: { tabId, cwd } })
    })
  }

  function feedLoginWatcher(tabId: string, data: string): void {
    const w = loginWatchers.get(tabId)
    if (!w || w.done) return
    if (w.installing) {
      const seen = w.installing.carry + data
      const rest = afterOutputStart(seen)
      if (rest === null) {
        w.installing.carry = outputStartCarry(seen)
        w.giveUp.refresh()
        w.buf = (w.buf + stripTerminalCodes(data)).slice(-LOGIN_BUF_MAX)
        return
      }
      clearTimeout(w.giveUp)
      w.giveUp = giveUpLoginAfter(tabId, loginTimeoutMs(), LOGIN_TIMED_OUT)
      w.installing = undefined
      w.buf = ''
      data = rest
    }
    w.buf = (w.buf + stripTerminalCodes(data)).slice(-LOGIN_BUF_MAX)
    const m = TOKEN_RE.exec(w.buf)
    if (!m) {
      if (!w.sawUrl) {
        const u = AUTH_URL_RE.exec(w.buf)
        if (u) {
          w.sawUrl = true
          sendLoginProgress({ phase: 'browser', name: w.name, url: u[0] }, w.again)
        }
      }
      return
    }
    endLoginWatch(tabId, w)
    void completeLogin(tabId, w.name, m[0], w.again)
  }

  function endLoginWatch(tabId: string, w: LoginWatch): void {
    w.done = true
    loginWatchers.delete(tabId)
    clearTimeout(w.giveUp)
  }

  function failLogin(tabId: string, why: string, terminalKept = true): void {
    const w = loginWatchers.get(tabId)
    if (!w || w.done) return
    endLoginWatch(tabId, w)
    const tail = plainTerminalTail(w.buf)
    sendLoginProgress(
      {
        phase: 'failed',
        name: w.name,
        tail: `${why}${tail ? `\n${tail}` : ''}`,
        ...(terminalKept && { tabId, cwd: ptyMgr.get(tabId)?.cwd })
      },
      w.again
    )
  }

  function giveUpLoginAfter(tabId: string, ms: number, why: string): NodeJS.Timeout {
    return setTimeout(() => {
      failLogin(tabId, why, false)
      try {
        ptyMgr.kill(tabId)
      } catch {}
    }, ms)
  }

  function cancelGuidedLogin(tabId: string): void {
    const w = loginWatchers.get(tabId)
    if (!w) return
    endLoginWatch(tabId, w)
    try {
      ptyMgr.kill(tabId)
    } catch {}
  }

  function startGuidedLogin(name: string, installFirst: boolean, again: boolean): string {
    const handle = ptyMgr.create({
      kind: 'shell',
      koloftShim: PLAIN_KOLOFT_SHIM,
      cwd: os.homedir(),
      // CC§7
      cols: LOGIN_PTY_COLS_WIDER_THAN_TOKEN,
      rows: 50,
      setupCommand: setupLine(),
      launchCommand: installFirst
        ? installThen(
            'claude',
            (claude) => `${MARK_OUTPUT_START}; exec ${claude} setup-token`,
            process.env.KOLOFT_TEST_TOOL_INSTALLER
          )
        : 'claude setup-token'
    })
    loginWatchers.set(handle.id, {
      name,
      again,
      buf: '',
      sawUrl: false,
      done: false,
      giveUp: installFirst
        ? giveUpLoginAfter(
            handle.id,
            cronTestMs(
              'KOLOFT_INSTALL_SILENCE_MS',
              INSTALL_SILENCE_LONGER_THAN_EITHER_SILENT_DOWNLOAD_AT_2_MBIT_MS
            ),
            INSTALL_STALLED
          )
        : giveUpLoginAfter(handle.id, loginTimeoutMs(), LOGIN_TIMED_OUT),
      ...(installFirst && { installing: { carry: '' } })
    })
    loginPtys.add(handle.id)
    if (installFirst) toolInstallPtys.add(handle.id)
    sendLoginProgress({ phase: 'starting', name }, again)
    return handle.id
  }

  async function startLogin(
    name: string,
    reauth?: boolean
  ): Promise<'ok' | 'invalid-name' | 'duplicate' | 'unknown'> {
    const v = reauth
      ? findAccount(name, 'oauth')
        ? 'ok'
        : 'unknown'
      : validateNewAccount(name, 'oauth')
    if (v !== 'ok') return v
    claudeBackend.forgetAvailability()
    const installFirst = !(await claudeBackend.availability()).available
    for (const id of loginWatchers.keys()) cancelGuidedLogin(id)
    startGuidedLogin(name, installFirst, reauth === true)
    return 'ok'
  }

  function cancelLogins(): void {
    for (const id of [...loginWatchers.keys()]) cancelGuidedLogin(id)
  }

  async function completeLogin(
    tabId: string,
    name: string,
    token: string,
    again: boolean
  ): Promise<void> {
    const result = await probeAccount('oauth', token, { timeoutMs: ACCOUNT_PROBE_TIMEOUT_MS })
    if (!result.ok && result.error === 'expired') {
      sendLoginProgress(
        {
          phase: 'failed',
          name,
          tail:
            'The captured token was rejected — usually that means the capture was incomplete. ' +
            'Use “Paste token” instead, or “Show terminal” to see the raw output.',
          tabId,
          cwd: ptyMgr.get(tabId)?.cwd
        },
        again
      )
      return
    }
    const stored = await keychainWrite('oauth', name, token)
    if (!stored) return
    const prev = findAccount(name, 'oauth')
    upsertAccountMeta({
      name,
      kind: 'oauth',
      enabled: prev ? prev.enabled : true,
      fable: result.ok && result.fable ? result.fable : (prev?.fable ?? 'unknown'),
      ...(prev?.fableCheckedAt !== undefined ? { fableCheckedAt: prev.fableCheckedAt } : {}),
      status: result.ok ? 'ok' : 'unverified',
      addedAt: prev?.addedAt ?? Date.now()
    })
    if (result.ok && result.fable) recordFableCapability(name, 'oauth', result.fable)
    const key = viewKey(name, 'oauth')
    if (result.ok) {
      usageViews.set(key, { usage: result.usage })
      picker.probed('oauth', name, result)
    } else {
      usageViews.set(key, { probeError: result.error })
    }
    pushAccounts()
    sendLoginProgress({ phase: 'saved', name }, again)
    try {
      ptyMgr.kill(tabId)
    } catch {}
  }

  const accounts: AgentAccounts = {
    pickForThisStart,
    probeAll,
    addSecret,
    forget: (kind, name) => picker.forget(kind, name),
    folderSaysItRunsOnAKey: () => false,
    signIn: async (_kind, name, again) => {
      const started = await startLogin(name, again)
      return started === 'ok'
        ? { ok: true, progress: { kind: 'oauth', name, again, phase: 'starting' } }
        : { ok: false, error: started }
    },
    cancelSignIn: () => cancelLogins(),
    act: async () => NO_SUCH_ACTION
  }

  return {
    picker,
    pickForLaunch,
    pickedAccountEnv,
    shimAccountRefusals,
    accounts,
    loginWatchers,
    loginPtys,
    feedLoginWatcher,
    failLogin
  }
}
