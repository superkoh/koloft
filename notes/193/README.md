# #193 probe: a reverse port forward on Koloft's ssh master

Run: `node notes/193/probe-reverse-forward.mjs` (needs Docker and Google Chrome; it builds
the e2e `sshd.Dockerfile` image, starts a bastion and a target on their own network,
and removes everything at the end). Output of the last run: `probe-output.txt`.

Setup: Mac ssh OpenSSH_10.3p1, machine sshd OpenSSH_9.2 (Debian bookworm), the target
reached through a ProxyJump bastion, the master opened with the same options as
`sshOptions()` in `src/main/remote/ssh.ts`. A WebSocket server on the Mac stands in
for the CDP relay: 127.0.0.1, fresh port, one 32-hex path, close 1008 on any other
path (ADR-0008).

What it showed:

1. `ssh -O forward -R 0:127.0.0.1:<relay port> <host>` on the live master works and
   prints the port sshd picked on the machine. sshd listens on 127.0.0.1 and ::1 only.
   Normal commands keep running over the same master. A second forward on the same
   master works too.
2. From the machine, `ws://127.0.0.1:<that port>/cdp/<path>` reaches the Mac: an 8 MiB
   reply took 37 ms; a wrong path gets 1008 "unknown endpoint". Both the `ws` package
   and Node 22's built-in WebSocket work.
3. Real CDP across the tunnel: playwright-core `connectOverCDP` on the machine drove a
   headless Chrome on the Mac (page, title, screenshot), and the `@playwright/cli`
   Koloft bundles (18 MB of plain JS, `engines.node >= 18`), copied to the machine and
   run with its node 22, did `attach --cdp`, `goto`, `snapshot` and `detach`.
4. Another account on the same machine (tuser) can connect to the forwarded port.
   Only the path keeps it out, as ADR-0008 already assumes for other local processes.
5. `-O cancel` must repeat the spec exactly as it was asked (`0:127.0.0.1:<port>`);
   with the port sshd picked it fails ("port not forwarded") and the forward stays.
6. When the master goes, the forward goes; the tmux session on the machine (and the
   agent in it) stays, with the old address in its env. A new master can ask for the
   same machine port by number, and the old address works again.
7. Asking for a port number that another program already holds on 127.0.0.1 still
   returns 0: sshd got ::1 only, and a client to 127.0.0.1 or `localhost` reaches the
   other program. So a re-asked port must be checked from the machine before use.
8. A server with `AllowTcpForwarding no`: `-O forward` exits 255 with "remote port
   forwarding failed for listen port 0"; the master stays up for everything else.
9. A port already forwarded on the master cannot be asked for twice (exit 255).
