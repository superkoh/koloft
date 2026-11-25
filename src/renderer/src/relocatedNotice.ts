import { basename } from '@shared/preview'
import { agentManifest } from '@core/agent/registry'
import type { BackendId } from '@shared/types'

export function relocatedNotice(backend: BackendId, dir: string): string {
  return `Workbench followed ${agentManifest(backend).name} to ${basename(dir)}`
}
