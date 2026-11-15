# #1089 probe: does a subagent transcript grow after a Stop that does not name it?

Claude Code 2.1.325 on macOS, 2026-11-15, interactive TUI in a python pty (`drive.py`),
haiku, `--dangerously-skip-permissions`, a scratch `CLAUDE_CONFIG_DIR`, hooks that save
Stop, SubagentStop, UserPromptSubmit and SessionStart input with a timestamp
(`hook.py`). `drive.py` types one prompt asking for one background Agent that runs three
foreground `perl -e "sleep 6"` calls, then starts `perl -e "sleep 25"` with
`run_in_background` and returns; it then samples every `subagents/*.jsonl` size every
0.5 s for 150 s. `timeline.py` merges the two.

```
   0.00  SessionStart
   2.15  UserPromptSubmit 'Launch exactly one Agent (subagent_type general-purpose) with run_in_background '
   4.76  grow agent-ac5adcd13ac2a65c1.jsonl -> 100800
   6.28  grow agent-ac5adcd13ac2a65c1.jsonl -> 102794
   6.29  Stop tasks=['subagent:ac5adcd13ac2a65c1:running']
   7.85  SubagentStop agent_id=a060a871d8eecb262 agent_type='' tasks=['subagent:ac5adcd13ac2a65c1:running']
  12.63  grow agent-ac5adcd13ac2a65c1.jsonl -> 197837
  14.20  grow agent-ac5adcd13ac2a65c1.jsonl -> 199835
  20.01  grow agent-ac5adcd13ac2a65c1.jsonl -> 203394
  21.60  grow agent-ac5adcd13ac2a65c1.jsonl -> 205396
  27.79  grow agent-ac5adcd13ac2a65c1.jsonl -> 208960
  28.83  grow agent-ac5adcd13ac2a65c1.jsonl -> 215087
  29.79  SubagentStop agent_id=ac5adcd13ac2a65c1 agent_type='general-purpose' tasks=['subagent:ac5adcd13ac2a65c1:running', 'shell:b4b3eg0de:running']
  29.84  UserPromptSubmit '<task-notification>\n<task-id>ac5adcd13ac2a65c1</task-id>\n<tool-use-id>toolu_01Q4'
  29.90  grow agent-ac5adcd13ac2a65c1.jsonl -> 216746
  31.30  Stop tasks=['shell:b4b3eg0de:running']
  32.91  SubagentStop agent_id=ad7391bfc947bde10 agent_type='' tasks=['shell:b4b3eg0de:running']
  53.99  grow agent-ac5adcd13ac2a65c1.jsonl -> 222189
  55.67  SubagentStop agent_id=ac5adcd13ac2a65c1 agent_type='general-purpose' tasks=['subagent:ac5adcd13ac2a65c1:running']
  55.71  UserPromptSubmit '<task-notification>\n<task-id>ac5adcd13ac2a65c1</task-id>\n<output-file>…'
  56.12  grow agent-ac5adcd13ac2a65c1.jsonl -> 223987
  57.15  Stop tasks=[]
  58.72  SubagentStop agent_id=afcff316fe68d468d agent_type='' tasks=[]
```

Answer: yes. The Stop at 31.30 names the subagent's shell, not the subagent; at 53.99,
when that shell ends, the subagent's own transcript grows while the last Stop list does
not name it. The main session's next turn starts 1.7 s later. Nothing grows after the
last Stop (`[]`) through 150 s.
