export const SLOT_FILLS = {
  'session-helper-rules': `1. {{helper-rule-own-worktree}}. {{helper-rule-shared-checkout}}
2. {{helper-rule-watched-session}}
3. A side job that only hands you back an answer, like searching, reading or checking: never a Koloft session. Use a sub-agent (spawn_agent) when the owner asked for sub-agents or for work in the background; otherwise do it yourself. Your sub-agents share this folder, so never let two of them change files at the same time; use rule 1 for that.
4. {{helper-rule-anything-else}}`,
  'session-questions': `

QUESTIONS

When the owner has to choose or answer something, ask with {{question-tool}}, called as a tool of its own (not inside exec): it shows the owner a box with choices and waits for the answer. Never use {{question-tool}}_async, which does not wait, and never sleep or poll while you wait.`
}
