export const SLOT_FILLS = {
  'session-send-left-to-its-own-tool': '',
  'session-helper-rules': `1. {{helper-rule-own-worktree}}. {{helper-rule-shared-checkout}}
2. {{helper-rule-watched-session}}
3. A side job that only hands you back an answer, like searching, reading or checking: never a Koloft session. Use a subagent (invoke_subagent) when the owner asked for subagents or for work in the background; otherwise do it yourself. Your subagents share this folder, so never let two of them change files at the same time; use rule 1 for that.
4. {{helper-rule-anything-else}}`,
  // AGY§14
  'session-questions': `

QUESTIONS

When the owner has to choose or answer something, ask with {{question-tool}}: it shows the owner a box with choices and waits for the answer.`
}

export const SLOT_ADDITIONS = {}
