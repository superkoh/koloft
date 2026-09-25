# 0017 The GitHub-button store flag is set by an effect with no cleanup

**Constraint**: React runs an effect's cleanup before every re-run, and every store
write re-runs the whole hint queue (`useHints`).
**Decision**: the effect that writes `setGithubBtn(visible && !!github.info)` has no
cleanup. The flag cannot get stuck true: the panel never unmounts, and both ways the
button can go away change one of the effect's inputs.
**Rejected**: a cleanup that clears the flag — the usual React habit, but it writes
false then true on every input change and runs the hint queue twice for nothing.
