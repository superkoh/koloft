import { openWebPage } from './store'

/**
 * What a click on a URL the terminal printed does (§05B row 6 / F1) — the same
 * user-source route a tree click or a preview link takes, so the page lands in the
 * session's Browser as a foreground tab. Handed to the web-links addon in place of its
 * own handler, which asks the OS for the URL: the escape this feature exists to close.
 */
export function activateTerminalLink(_event: MouseEvent, uri: string): void {
  openWebPage(uri)
}
