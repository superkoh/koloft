export const SLOT_FILLS = {
  'session-helper-rules': `1. {{helper-rule-own-worktree}}, and instead of giving a subagent or a workflow agent a worktree of its own. {{helper-rule-shared-checkout}}
2. {{helper-rule-watched-session}}
3. Dozens of similar small jobs, like checking 40 files the same way: do not start a workflow yourself. Suggest one to the owner, say about how many agents it would run, and start it only when the owner asks for it.
4. A side job that finishes on its own and only hands you back an answer, like searching or reading many files: a subagent. Use Explore to search and read, or a fork when it needs what this conversation already knows.
5. {{helper-rule-anything-else}}`,
  'session-questions': '',
  // CC§13
  'session-send-left-to-its-own-tool':
    'a Claude session talks to another Claude session on the same machine with its SendMessage tool; ListAgents shows their names.'
}

export const SLOT_ADDITIONS = {
  'koloft-help-session-new-examples': `
    Example: koloft session new --name "Fix docs links" --backend claude --model sonnet --effort low -- "Fix the broken links in docs/."`,
  'koloft-help-own-message-tool': `
    Claude to Claude on the same machine: use your SendMessage tool with its name. ListAgents shows the sessions on this machine; SendMessage cannot reach one on another machine, so use "koloft session send" for that.`,
  'koloft-help-send-but-own-message-tool':
    ', except from one open Claude session to another on the same machine, which uses SendMessage',
  'koloft-help-command-arguments-example': ' (like /model haiku)',
  // CC§3
  'koloft-help-git-at-the-main-checkout-refused-by':
    ' (Claude Code refuses it, and a ! command too)'
}
