export const SLOT_FILLS = {
  'session-send-left-to-its-own-tool': '',
  'session-helper-rules': `1. {{helper-rule-own-worktree}}. {{helper-rule-shared-checkout}}
2. {{helper-rule-watched-session}}
3. A side job that only hands you back an answer, like searching, reading or checking: never a Koloft session. Use a sub-agent (spawn_agent) when the owner asked for sub-agents or for work in the background; otherwise do it yourself. Your sub-agents share this folder, so never let two of them change files at the same time; use rule 1 for that.
4. {{helper-rule-anything-else}}`,
  // CODEX§20
  'session-questions': `

QUESTIONS

When the owner has to choose or answer something, ask with {{question-tool}}, called as a tool of its own (not inside exec): it shows the owner a box with choices and waits for the answer. Never use {{question-tool}}_async, which does not wait, and never sleep or poll while you wait.`
}

export const SLOT_ADDITIONS = {
  'koloft-help-session-new-examples': `
    Example: koloft session new --workspace koloft --backend codex --model astra --effort high -- "Find why the latest release is missing files."`,
  // CODEX§21
  'koloft-help-new-conversation-also': ' (or /new in Codex)',
  'koloft-help-secret-url-like': ', like codex login',
  'koloft-help-secret-url-examples': `
    Example: koloft secret url "https://auth.openai.com/oauth/authorize?..."`
}
