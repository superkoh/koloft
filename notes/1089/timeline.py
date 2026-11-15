import json
import os
import sys

B = os.path.dirname(os.path.abspath(__file__))
rows = []
for line in open(os.path.join(B, "hooks.jsonl")):
    h = json.loads(line)
    i = h["input"]
    if h["event"] in ("Stop", "SubagentStop"):
        tasks = [
            "%s:%s:%s" % (t.get("type"), t.get("id"), t.get("status")) for t in i.get("background_tasks", [])
        ]
        extra = "agent_id=%s agent_type=%r " % (i.get("agent_id"), i.get("agent_type")) if h["event"] == "SubagentStop" else ""
        rows.append((h["t"], "%s %stasks=%s" % (h["event"], extra, tasks)))
    elif h["event"] == "UserPromptSubmit":
        rows.append((h["t"], "UserPromptSubmit %r" % i.get("prompt", "")[:80]))
    else:
        rows.append((h["t"], h["event"]))
for line in open(os.path.join(B, "samples.jsonl")):
    s = json.loads(line)
    if "/subagents/" in s["file"] or len(sys.argv) > 1:
        rows.append((s["t"], "grow %s -> %d" % (s["file"].split("/")[-1], s["size"])))
rows.sort()
t0 = rows[0][0]
for t, what in rows:
    print("%7.2f  %s" % (t - t0, what))
