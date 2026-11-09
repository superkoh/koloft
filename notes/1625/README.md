# Probe for #1625: OSC 8 links through tmux 3.3a, 3.4, 3.5a and 3.8

`probe.py <label> <tmux.conf> <direct|tmux> <plain|pt>`: the outer terminal is a python
pty answering like xterm.js; a pane script prints 160 lines, each with one OSC 8 link
around `doc N`. `pt` wraps each link in a tmux passthrough. `tmux.conf` is Koloft's
(`TMUX_CONF` in `src/main/remote/install.ts`). Each image runs it as root with
`--network none`, the files copied in with `docker cp`.

| tmux (image)          | mode, conf          | links out | around their words | runs |
| --------------------- | ------------------- | --------- | ------------------ | ---- |
| none (any image)      | direct              | 160       | 160                | 1 each |
| 3.3a (Debian 12)      | plain, Koloft's     | 0         | 0                  | 7    |
| 3.3a (Debian 12)      | pt, Koloft's        | 160       | 0                  | 5    |
| 3.4 (Ubuntu 24.04)    | plain, Koloft's     | 160       | 160                | 8    |
| 3.4 (Ubuntu 24.04)    | plain, no hyperlinks line | 0   | 0                  | 3    |
| 3.5a (Debian 13)      | plain, Koloft's     | 160       | not counted        | 5    |
| 3.8 (release tarball) | plain, Koloft's     | 160       | not counted        | 5    |

`#{client_termfeatures}` has `hyperlinks` on 3.4, 3.5a and 3.8 with Koloft's conf, and
not on 3.3a (which still lists the line in `show -s terminal-features`).
