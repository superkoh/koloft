# What git prints when a worktree cannot be made again

git 2.54.0 (Apple Git-157), throwaway repositories under a temp folder; `<tmp>` stands for
that folder. Each case runs the same `git -C <root> worktree add …` Koloft runs on resume.

| Case | stderr (what `onFailure` gets) |
| --- | --- |
| Locked worktree, its folder deleted: the `worktree remove` step | `fatal: cannot remove a locked working tree;` / `use 'remove -f -f' to override or unlock first` |
| Locked worktree, its folder deleted: `worktree add <tree> <branch>` | `Preparing worktree (checking out 'worktree-feat-x')` / `fatal: '<tmp>/locked/.claude/worktrees/feat-x' is a missing but locked worktree;` / `use 'add -f -f' to override, or 'unlock' and 'prune' or 'remove' to clear` |
| Branch checked out in another worktree | `Preparing worktree (checking out 'worktree-feat-y')` / `fatal: 'worktree-feat-y' is already used by worktree at '<tmp>/elsewhere-other'` |
| No repository at the recorded root | `fatal: not a git repository (or any of the parent directories): .git` |
| Base commit gone | `fatal: invalid reference: 0123456789abcdef0123456789abcdef01234567` |

Node's `execFile` error for the same call has `message` =
`Command failed: git -C <root> worktree add <tree> <branch>` followed by the stderr above;
its `stderr` property is the stderr alone.
