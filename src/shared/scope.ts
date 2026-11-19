import { basename } from './preview'
import { parseRemoteKey } from './remoteKey'

export const GLOBAL_SCOPE = 'global'

export function scopeName(scope: string): string {
  if (scope === GLOBAL_SCOPE) return 'Global'
  return basename(parseRemoteKey(scope)?.path ?? scope)
}
