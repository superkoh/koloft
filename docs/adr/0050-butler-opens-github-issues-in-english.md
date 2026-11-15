# 0050 Koloft refuses a butler's GitHub issue or pull request that is not in English

**Constraint**: the owner decided that an issue or pull request the butler opens on GitHub is
written in English, even when the owner writes to the butler in another language (#859,
#1591). The butler's prompt says so, yet a real Codex butler still wrote one in Chinese about
1 run in 6, and 2 in 3 when it had just read the `koloft-docs` skill: the rule was in its
context every time.
**Decision**: `koloft gh issue create` and `koloft gh pr create` from the butler or a helper
in its folder are refused when the title or body (a `--body-file` too) holds Chinese,
Japanese or Korean script, with one line asking for English. The model writes it again in
English. A session in a project's workspace is not checked: that project may write in its
own language.
**Rejected**: a sentence in a prompt only. Three placements were measured — the butler's
role, the `koloft gh` entry of the koloft skill, and the `koloft-docs` language rule — and
none brought the rate down. The cost taken: the butler cannot open an issue in Chinese even
when the owner asks for one.
