import path from 'path'
import type { SignInFolderKind } from '@shared/types'
import { agyApiKeyRoute, agyHomeOf } from './agyAccounts'
import { codexHomeOf } from './codexAccounts'
import { museHomeOf, readJson } from './museAccounts'

export const homeKeyOnDisk: Record<SignInFolderKind, (userData: string, name: string) => boolean> =
  {
    // CODEX§15
    'codex-home': (userData, name) =>
      readJson(path.join(codexHomeOf(userData, name), 'auth.json')).auth_mode === 'apikey',
    // MUSE§13
    'muse-home': (userData, name) => {
      const auth = readJson(path.join(museHomeOf(userData, name), 'muse', 'auth.json'))
      const meta = (auth.providers as { meta?: { api_key?: unknown; access_token?: unknown } })
        ?.meta
      return typeof meta?.api_key === 'string' && !meta.access_token
    },
    // AGY§6
    'agy-home': (userData, name) => agyApiKeyRoute(agyHomeOf(userData, name))
  }
