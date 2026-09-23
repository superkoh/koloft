import { openWebPage } from './store'

export function activateTerminalLink(_event: MouseEvent, uri: string): void {
  openWebPage(uri)
}
