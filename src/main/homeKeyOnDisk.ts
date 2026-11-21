import path from 'path'
import type { SignInFolderKind } from '@shared/types'
import { agyApiKeyRoute, agyHomeOf } from './agyAccounts'
import { codexHomeOf } from './codexAccounts'
import { readJson } from './jsonDrops'

export const homeKeyOnDisk: Record<SignInFolderKind, (userData: string, name: string) => boolean> =
  {
    // CODEX§15
    'codex-home': (userData, name) =>
      readJson(path.join(codexHomeOf(userData, name), 'auth.json')).auth_mode === 'apikey',
    // AGY§6
    'agy-home': (userData, name) => agyApiKeyRoute(agyHomeOf(userData, name))
  }
