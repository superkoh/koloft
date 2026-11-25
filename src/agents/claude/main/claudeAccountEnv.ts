import type { AccountKind } from '@shared/types'
import { keychainRead } from '../../../main/accounts'
import type { PickResponse } from './claudeAccountPicker'
import type { MachineAccount } from './claudeLaunch'

// CC§7
export function claudeCodeGuessesWindowOf(model: string): boolean {
  return !/claude/i.test(model) && !/\[1m\]$/i.test(model)
}

export function accountEnv(
  kind: AccountKind,
  name: string,
  secret: string,
  endpoint?: { baseUrl?: string; model?: string }
): Record<string, string> {
  const env: Record<string, string> = { ANT_ACCOUNT: name }
  if (kind === 'apikey') env.ANTHROPIC_API_KEY = secret
  else if (kind === 'custom') {
    env.ANTHROPIC_AUTH_TOKEN = secret
    if (endpoint?.baseUrl) env.ANTHROPIC_BASE_URL = endpoint.baseUrl
    // CC§7
    if (endpoint?.model) {
      for (const k of [
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_FABLE_MODEL',
        'CLAUDE_CODE_SUBAGENT_MODEL'
      ]) {
        env[k] = endpoint.model
      }
      env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1'
      if (claudeCodeGuessesWindowOf(endpoint.model)) env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    }
  } else env.CLAUDE_CODE_OAUTH_TOKEN = secret
  return env
}

export async function pickMachineAccount(
  pick: () => Promise<{ res: PickResponse; endpoint?: { baseUrl?: string; model?: string } }>
): Promise<MachineAccount | undefined> {
  const { res, endpoint } = await pick()
  if (!res.account) return undefined
  const secret = await keychainRead(res.kind, res.account)
  if (!secret) return undefined
  return {
    env: accountEnv(res.kind, res.account, secret, endpoint),
    banner: res.warning ? `${res.banner}\n${res.warning}` : res.banner
  }
}
