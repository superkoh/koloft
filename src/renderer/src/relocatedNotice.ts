import { basename } from '@shared/preview'

export function relocatedNotice(dir: string): string {
  return `Workbench followed Claude to ${basename(dir)}`
}
