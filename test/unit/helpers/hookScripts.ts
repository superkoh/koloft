import { setupHooks } from '../../../src/plugins/sessions/main/hooks'
import { writeClaudeHookScript } from '../../../src/agents/claude/main/claudeHooks'
import { writeCodexReplyLanguageScript } from '../../../src/agents/codex/main/codexHooks'

export function setupHookScripts(peerOwnsTab: (tabId: string) => boolean = () => false) {
  const dirs = setupHooks(peerOwnsTab)
  return {
    ...dirs,
    hookScript: writeClaudeHookScript(dirs.hookDir),
    codexReplyLanguage: writeCodexReplyLanguageScript(dirs.hookDir)
  }
}
