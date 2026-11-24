export const SLOT_FILLS = {
  'session-helper-rules': `1. {{helper-rule-own-worktree}}, and instead of giving a subagent or a workflow agent a worktree of its own. {{helper-rule-shared-checkout}}
2. {{helper-rule-watched-session}}
3. Dozens of similar small jobs, like checking 40 files the same way: do not start a workflow yourself. Suggest one to the owner, say about how many agents it would run, and start it only when the owner asks for it.
4. A side job that finishes on its own and only hands you back an answer, like searching or reading many files: a subagent. Use Explore to search and read, or a fork when it needs what this conversation already knows.
5. {{helper-rule-anything-else}}`,
  'session-questions': ''
}
