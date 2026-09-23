# 0004 Startup never wipes files that other Koloft instances share

**Constraint**: several Koloft installs can run at once on one userData folder (a dev
build, the packaged app, a worktree's release build under test), and a peer may have
been running for days.
**Decision**: startup never wipes the shared folders. Each install writes its own
statusline wrapper, named by a hash of its binary path, and deletes a wrapper only when
the binary baked into it is gone from disk. Registration and pick files are deleted only
once they are older than a fixed age.
**Rejected**: one shared `run.sh` — the last instance to write it wins, and when that
build is deleted every other instance's statusline goes blank. Wiping at startup, or
pruning wrappers by age, deletes files a live peer still uses.
