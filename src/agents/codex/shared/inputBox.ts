const CODEX_COMPOSER_MARK = '›'

// CODEX§21
export function codexComposerDraft(lines: string[]): string | undefined {
  return lines
    .findLast((line) => line.startsWith(CODEX_COMPOSER_MARK))
    ?.slice(CODEX_COMPOSER_MARK.length)
    .trim()
}

const CODEX_PANEL_KEY_HINT = /\b(esc (back|close|exit)|q close)\b/

// CODEX§21
export function codexShowsAPanel(lines: string[]): true | undefined {
  const lastMarkedRow = lines.findLastIndex((line) => line.startsWith(CODEX_COMPOSER_MARK))
  return lines.slice(lastMarkedRow + 1).some((line) => CODEX_PANEL_KEY_HINT.test(line)) || undefined
}

export function codexShowsAPanelOnItsScreen(
  screenLines: (tabId: string) => Promise<string[] | undefined>
): (tabId: string, screen?: string[]) => Promise<boolean | undefined> {
  return async (tabId, screen) => {
    const lines = screen ?? (await screenLines(tabId))
    const somethingDrawn = lines?.some((line) => line.trim())
    return lines && somethingDrawn ? codexShowsAPanel(lines) : undefined
  }
}
