# ADRs (architecture decision records)

One file per decision that the code cannot carry. The bar an ADR must pass, and how
numbers are taken, are under "Comments" in the root `CLAUDE.md`. Every ADR is cited
by a marker (`// ADR-0007`) at each code site it governs; `npm run check:comments`
fails on an ADR no code cites, and on a marker that points at no ADR or ledger section.

An obsolete ADR is edited or deleted, never marked superseded — git keeps the history.

File name: `NNNN-short-slug.md`. Shape — a few lines each:

```markdown
# 0007 Short title of the decision

**Constraint**: the outside fact or policy the code cannot show.
**Decision**: what Koloft does.
**Rejected**: the better-looking alternative, and why it fails here.
```
