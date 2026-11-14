# #819 item 1: can a remote tab's pty outlive its tmux session?

Question: the heartbeat fallback (`noticeRemoteExits`) checks once, 10 s after a
session leaves the heartbeat's alive list, and drops the exit if the host is
not connected at that moment. That only matters if the tab's own ssh pty can
still be up when the session is gone. If the pty always exits, the tab ends
through the pty path anyway.

Setup (`probe.mjs`): the e2e SSH lab image (`koloft-e2e-sshd`) as a target behind
a jump host, real OpenSSH and real tmux. The tab is the shape of `launchLine`:
`ssh -tt` with Koloft's options (`ControlMaster=auto`, `ControlPersist=yes`,
`ServerAliveInterval=15`, `ServerAliveCountMax=3`) in a reconnect loop that
retries with `attach` on exit 255, in a pty. A heartbeat runs `tmux ls` over the
same options every 2 s. The link is cut with `docker network disconnect` on the
target, the tmux session is killed on the target while the link is down, and
the link comes back after the outage.

Run: `node probe.mjs <koloft-e2e-sshd image> <outage ms> [baseline]`

## Results (2026-11-14)

Baseline, link up:

```
   4.2s tmux session k-x killed on the target
   4.3s pty says LOOP-EXIT 0
   5.3s heartbeat: k-x GONE
```

30 s outage (shorter than ssh's 45 s keepalive limit):

```
   4.2s LINK DOWN: target off the network
   4.2s tmux session k-x killed on the target
  25.2s heartbeat: FAILED(SIGTERM) (20005 ms)
  34.4s LINK UP: target back on the network
  57.7s pty says LOOP-EXIT 0
  60.7s heartbeat: k-x GONE (11505 ms)
```

70 s outage (longer than the keepalive limit):

```
   4.3s LINK DOWN: target off the network
   4.3s tmux session k-x killed on the target
  25.3s heartbeat: FAILED(SIGTERM) (20003 ms)
  62.8s pty says LOOP-RECONNECT          (ssh gave up: exit 255)
  63.0s heartbeat: FAILED(255)
  ...   LOOP-RECONNECT every 2 s
  74.4s LINK UP: target back on the network
  75.8s pty says LOOP-EXIT 1             (attach finds no session)
  76.0s heartbeat: k-x GONE (231 ms)
```

In every run the tab's pty ended no later than the heartbeat first saw the
session gone. The heartbeat and the tab share one ssh master, so the heartbeat
cannot see the session leave while the tab's link is still stuck.
