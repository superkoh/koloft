# 0025 A remote workspace is keyed `ssh://<machine>/<path>` in the same field as a local path

**Constraint**: a remote workspace's folder, and a remote session's `cwd` and
`treeRoot`, are paths on another machine. Read on this Mac they name nothing, or the
wrong folder, and nothing fails loudly.
**Decision**: the key is `ssh://<machine>/<absolute path>` (`@shared/remoteKey`), kept in
the layout's `path` field like a local path. Every disk, git or `ps` call on a
workspace path checks `parseRemoteKey` or `SessionInfo.remote` first. A remote session
never gets `SessionInfo.worktree`, even when the same path exists on this Mac.
**Rejected**: a separate field or type for remote workspaces — every place keyed by the
workspace string (sidebar grouping, the note folder, tab ownership) would have to learn
about it, where today only the places that touch a disk do.
