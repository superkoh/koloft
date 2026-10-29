import json
import os
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, "bin", "claude")
HOOK = os.path.join(HOME, "hook.sh")
LOG = os.path.join(HOME, ".koloft", "hook-sessions", "probe.jsonl")
BIG_FILES = int(os.environ.get("BIG_FILES", "60000"))
ENV = dict(os.environ, TERM="xterm-256color", DISABLE_AUTOUPDATER="1", LANG="C.UTF-8")


def run(*args, cwd=None, check=True):
    return subprocess.run(args, cwd=cwd, env=ENV, check=check, capture_output=True, text=True).stdout


def tmux(*args):
    return run("tmux", *args, check=False)


def hook_lines():
    if not os.path.exists(LOG):
        return []
    with open(LOG) as f:
        return [json.loads(line) for line in f if line.strip()]


def transcripts():
    root = os.path.join(HOME, ".claude", "projects")
    out = {}
    for dirpath, _, files in os.walk(root):
        for name in files:
            if name.endswith(".jsonl"):
                p = os.path.join(dirpath, name)
                with open(p) as f:
                    kinds = [json.loads(l).get("type") for l in f if l.strip()]
                out[os.path.relpath(p, root)] = kinds
    return out


def wait_for(pred, timeout, what):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.05)
    print(f"  timeout waiting for {what}")
    return False


def variant(name, with_message, worktree_remove_hook):
    print(f"\n=== variant {name}: message={with_message} WorktreeRemove hook={worktree_remove_hook}")
    repo = os.path.join(HOME, f"repo-{name}")
    os.makedirs(repo)
    run("git", "init", "-q", "-b", "main", cwd=repo)
    with open(os.path.join(repo, ".gitignore"), "w") as f:
        f.write("big/\n")
    with open(os.path.join(repo, "README.md"), "w") as f:
        f.write("probe\n")
    run("git", "add", ".", cwd=repo)
    run("git", "-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "-m", "init", cwd=repo)

    cj = os.path.join(HOME, ".claude.json")
    data = json.load(open(cj)) if os.path.exists(cj) else {}
    data["hasCompletedOnboarding"] = True
    data.setdefault("projects", {})[repo] = {"hasTrustDialogAccepted": True}
    json.dump(data, open(cj, "w"))

    cmd = lambda ev: f"sh {HOOK} {ev}"
    hooks = {
        ev: [{"hooks": [{"type": "command", "command": cmd(tag)}]}]
        for ev, tag in [
            ("SessionStart", "start"),
            ("SessionEnd", "end"),
            ("UserPromptSubmit", "prompt"),
            ("Stop", "stop"),
            ("StopFailure", "stopfailure"),
            ("Notification", "notify"),
            ("PreCompact", "compacting"),
        ]
    }
    if worktree_remove_hook:
        hooks["WorktreeRemove"] = [{"hooks": [{"type": "command", "command": cmd("worktreeremove")}]}]
    settings = os.path.join(HOME, f"settings-{name}.json")
    json.dump(
        {
            "apiKeyHelper": "echo sk-ant-api03-fake-probe-key",
            "skipDangerousModePermissionPrompt": True,
            "hooks": hooks,
        },
        open(settings, "w"),
    )
    mcp = os.path.join(HOME, "mcp.json")
    json.dump({"mcpServers": {}}, open(mcp, "w"))

    if os.path.exists(LOG):
        os.remove(LOG)
    sess = f"v{name}"
    launch = f"cd {repo} && exec {CLAUDE} -w wt --settings {settings} --strict-mcp-config --mcp-config {mcp}"
    tmux("new-session", "-d", "-s", sess, "-x", "120", "-y", "40", launch)
    tmux("set-option", "-t", sess, "remain-on-exit", "on")
    pane_log = os.path.join(HOME, f"pane-{name}.bin")
    tmux("pipe-pane", "-t", sess, f"cat >> {pane_log}")

    if not wait_for(lambda: any(l["event"] == "start" for l in hook_lines()), 60, "SessionStart"):
        print(tmux("capture-pane", "-p", "-t", sess))
        return
    tree = os.path.join(repo, ".claude", "worktrees", "wt")
    big = os.path.join(tree, "big")
    os.makedirs(big)
    for i in range(BIG_FILES):
        d = os.path.join(big, str(i // 1000))
        if i % 1000 == 0:
            os.makedirs(d)
        open(os.path.join(d, str(i)), "w").close()
    print(f"  worktree ready with {BIG_FILES} ignored files")

    if with_message:
        tmux("send-keys", "-t", sess, "-l", "hello")
        time.sleep(0.6)
        tmux("send-keys", "-t", sess, "Enter")
        wait_for(lambda: any(l["event"] in ("stop", "stopfailure") for l in hook_lines()), 60, "turn end")
        time.sleep(1.0)

    time.sleep(1.0)
    tmux("send-keys", "-t", sess, "-l", "/exit")
    time.sleep(0.6)
    t0 = time.time()
    tmux("send-keys", "-t", sess, "Enter")

    seen = {}
    last_hooks = len(hook_lines())
    last_tx = transcripts()
    branch_ref = os.path.join(repo, ".git", "refs", "heads", "worktree-wt")

    def mark(key, detail=""):
        if key not in seen:
            seen[key] = time.time() - t0
            print(f"  +{seen[key]:7.3f}s {key} {detail}")

    end = t0 + 90
    while time.time() < end:
        if not os.path.exists(tree):
            mark("worktree folder gone")
        if not os.path.exists(branch_ref):
            mark("branch ref gone")
        if os.path.exists(pane_log) and b"Removing worktree" in open(pane_log, "rb").read():
            mark("pane printed 'Removing worktree'")
        if os.path.exists(pane_log) and b"Worktree removed" in open(pane_log, "rb").read():
            mark("pane printed 'Worktree removed'")
        hl = hook_lines()
        for l in hl[last_hooks:]:
            mark(f"hook record '{l['event']}' arrived", f"(hook ran at +{l['t'] - t0:.3f}s, reason={(l['input'] or {}).get('reason')})")
        last_hooks = len(hl)
        tx = transcripts()
        if tx != last_tx:
            for k, v in tx.items():
                if last_tx.get(k) != v:
                    mark(f"transcript changed {k} #{len(v)}", f"tail={v[-3:]}")
            for k in last_tx:
                if k not in tx:
                    mark(f"transcript gone {k}")
            last_tx = tx
        if tmux("display", "-p", "-t", sess, "#{pane_dead}").strip() == "1":
            mark("claude exited", tmux("display", "-p", "-t", sess, "#{pane_dead_status}").strip())
            break
        time.sleep(0.02)

    time.sleep(0.5)
    print("  hook records:")
    for l in hook_lines():
        inp = l["input"] or {}
        print(f"    {l['t'] - t0:+8.3f}s {l['event']} reason={inp.get('reason')} cwd={inp.get('cwd')} keys={sorted(inp.keys())}")
    print(f"  worktree still there: {os.path.exists(tree)}; branch still there: {os.path.exists(branch_ref)}")
    print("  transcripts:", json.dumps({k: v[-4:] for k, v in transcripts().items()}))
    print("  last screen lines:")
    for line in tmux("capture-pane", "-p", "-t", sess).splitlines()[-8:]:
        print("    |", line)
    tmux("kill-session", "-t", sess)


print("claude", run(CLAUDE, "--version").strip(), "| tmux", run("tmux", "-V").strip(), "| git", run("git", "--version").strip())
for arg in sys.argv[1:]:
    name, msg, wr = arg.split(":")
    variant(name, msg == "1", wr == "1")
