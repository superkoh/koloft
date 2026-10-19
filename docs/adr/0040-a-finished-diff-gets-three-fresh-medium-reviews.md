# 0040 A finished diff gets three fresh `/code-review medium` runs, merged

**Constraint**: one `/code-review` run finds only some of a diff's bugs, and a fresh run
of the same level on the same diff finds a different few (CC§20). A review has to end
in minutes, not half an hour, and costs the owner's usage on every PR.
**Decision**: `scripts/code-review.mjs` runs `/code-review medium` on Opus 5.5 in three
fresh `claude -p` processes at once and prints their three reports; the session merges
them. Measured 2026-10-17 to 10-19 on 26 past Koloft PRs (8 that brought in 12 bugs
fixed later, 9 with an old fix reverted into them, 9 that never needed a fix), a Fable
judge marking which findings named a known bug:

| | later-fixed bugs caught, of 12 | per PR (list price) | slowest run |
|---|---|---|---|
| `low` ×1 | 0 | $0.22 | under 1 min |
| `medium` ×1 | 1.0 | $0.89 | 9.4 min |
| `medium` ×3 | 2.3–3.0 | $2.66 | 9.4 min |
| `high` ×2 | 2.4–2.7 | $3.07 | 20.1 min |
| `high` ×3 | 2.9–3.5 | $4.61 | 20.1 min |
| `xhigh` ×1 | 2.5 | $6.31 | 29 min |

The ranges come from two ways of counting the same runs: every 3-of-4 subset of four
runs (the higher number), and each bug's chance per run treated as independent. Among
`medium`'s findings, a blind sample of 35 held 2 real defects, 19 right but minor, 8
suggestions and 6 wrong ones.
**Rejected**:
- One `low` run, the step before: it caught none of the 12 and stops part way on a
  big diff (CC§20).
- One run of any level: half or less of what three `medium` runs catch.
- `high` ×2 or ×3: about the same catch for 15–75% more, and its slowest run takes 20
  minutes.
- `xhigh` and `max`: `xhigh` costs 2.4× as much for no more than three `medium` runs,
  and `max` ran about $130 and 90 minutes per run, 3 of 5 runs hitting a usage limit.
- A custom review skill (two to four Opus readers, each reading its part of the diff to
  the end): about 76% of its findings were real, but it caught none of the 12 bugs in
  two runs.
