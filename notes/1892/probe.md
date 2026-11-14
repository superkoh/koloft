# #1892 probe: width of a remote tab that was never opened

Build: `main` at 79f3de43 (v0.72.0, after #1891).

## Steps

1. `npm run build`
2. `npm run handtest -- start --remote --port 9431` (Docker SSH lab, real `claude` 2.1.325 on the machine)
3. In the app: click the remote workspace `proj` (kt-key), press "New Claude session".
4. In that tab type `!koloft session new -- "Say OK and stop."` and Enter.
   Koloft answers `Started session "Reply OK and stop" in a new tab.` The new tab
   shows in the sidebar and is never clicked or shown.
5. On the lab machine, read every Koloft tmux pane and the new tab's tty.

## Output

```
$ docker exec -u kuser <target> tmux -L koloft list-panes -a \
    -F '#{session_name} #{pane_width}x#{pane_height} #{pane_tty} clients=#{session_attached}'
k-c175b3a8-e501-4f29-9f1f-a74c55bdb1df 107x49 /dev/pts/1 clients=1   <- the tab on screen
k-d326efbb-6fc1-4c00-b496-3be2a492842e 107x49 /dev/pts/4 clients=1   <- never opened

$ docker exec -u kuser <target> stty -F /dev/pts/4 size
49 107
```

`tmux capture-pane` of the never-opened tab: Claude Code wrapped its first prompt at
about 105 columns and drew its prompt rule across the full 107, not at 80.

## Why this holds for every agent

Every remote tab, whatever its agent, starts through the same `tabScript`
(`src/main/remote/launch.ts`): `tmux new-session -A -D` attached, so the tmux session
takes the size of the ssh client's terminal, which is the local pty that #1891 now
spawns at the session screen's size. Only the program inside (`program.run`) differs by
agent. A tab that is never opened has no terminal view to fit it, so nothing else
resized it to 107.
