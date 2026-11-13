# Issue 679: run the sync pulls together

`measure-pulls.mjs` times one remote sync round on the e2e sshd image
(`test/e2e/fixtures/sshd.Dockerfile`): the real heartbeat, then the transcript, hook and
agy-brain pulls (or all seven pulls with `--pulls 7`), with one file appended in each
folder before every round so every pull is due. Rounds alternate one after another /
together; the first two of each are thrown away. `--rtt-list` adds delay with `tc netem`
in the container.

`heartbeat.sh` and `bell.sh` are `heartbeatCmd([], [], ['-home-kuser-proj'],
[AGY_REMOTE_BRAIN], [])` and `hookBellCmd()` from `src/main/remote/install.ts` on main
668a5d18, written out by a throwaway vitest file.

Run: `node notes/679/measure-pulls.mjs [--docker-host <socket>] [--rtt-list 0,30,100]
[--rounds 15] [--pulls 3|7] [--at-once 7|3] [--shape pool|chain] [--user kuser|muser]`

`--shape chain` is what the branch ships: the transcripts and then the hooks in turn,
the extras beside them at most `at-once - 1` at a time (`result-*-chain.txt`).

Results: `result-3-pulls.txt`, `result-7-pulls.txt`, `result-7-pulls-3-at-once.txt`,
`result-maxsessions-2.txt` (`muser` has `MaxSessions 2` in the image).
