# 0021 `quitAndClose` waits for the close only when the quit approval got through

**Constraint**: main quits inside the approval's own handler, and a crashed renderer
cannot send the approval at all.
**Decision**: start waiting for the close event before sending the approval, wait on it
only when the approval call worked, then call `app.close()`.
**Rejected**: always waiting for the close event — a spec whose renderer crashed sits
out the full 15 s timeout in teardown every run, and nothing turns red.
