# Contributing to Koloft

Thanks for looking. Right now Koloft takes **bug reports and ideas, as issues**. It does
not take pull requests yet — the code is here to be read, built and run, and a workflow
closes outside pull requests automatically with a pointer back here. That will change;
when it does, this page will say so.

## What Koloft is for

One idea decides everything: **you pick a folder, and you start or resume Claude Code
sessions in it.** Koloft lists those sessions straight from Claude's own storage, and
hangs one helper panel — the Workbench — off each session.

Ideas are judged against that. A free-floating terminal, a second copy of a transcript,
or a feature that makes Koloft the thing you look at instead of Claude are all outside it,
and get closed even when they are good ideas.

What is planned, and what is deliberately not being done, is in
[docs/roadmap.md](docs/roadmap.md). Worth a look before filing a feature request.

## Filing an issue

Use the templates — they ask for the three versions every report here needs (Koloft,
macOS, Claude Code). Koloft sits between you and Claude Code, so the first thing to sort
out is which of the two did the thing; if you can, check whether the same happens running
`claude` in a plain terminal. That answer alone often settles it.

Found a security problem? Please do not open a public issue — see
[SECURITY.md](SECURITY.md).

## Building it yourself

macOS on Apple Silicon only, Node 22.12 or newer.

```bash
git clone https://github.com/superkoh/koloft.git
cd koloft
npm install
npm run rebuild                        # required — see below
node node_modules/electron/install.js  # once, see below
npm run dev
```

Three steps that each fail **silently** if you skip them:

- **`npm run rebuild`** builds `node-pty` against Electron's own Node version. Skip it
  and the app crashes on launch with a mismatch error. Run it again after any change to
  the `electron` or `node-pty` version.
- **`node node_modules/electron/install.js`** fetches the Electron binary. Since
  Electron 42 that no longer happens during `npm install`, so the first launch otherwise
  stalls on a download with nothing on screen saying so.
- **A fresh git worktree has no `node_modules` of its own**, and Node quietly resolves
  up to the parent checkout's. Run all three — `npm install`, `npm run rebuild` and
  `node node_modules/electron/install.js` — inside each worktree before testing there.
  A Claude Code session started in a worktree of this repo does it for you, through the
  project's SessionStart hook.

Everyday commands:

```bash
npm run dev            # launch in dev mode
npm run typecheck      # main + renderer + tests
npm run build          # typecheck, then build
npm run format         # Prettier over the tree (CI checks it)
npm run check:comments # the comment rule below (CI checks it)
npm run test:unit      # Vitest — pure Node, hermetic, fast
npm run test:e2e       # Playwright drives the real built app (needs npm run build first)
```

## How the code is written

If you read the code, these are the rules it was written under. They are what a change
would be judged against once pull requests open.

**Tests follow behavior, not diffs.** Every behavior change comes with a test that goes
red when that behavior breaks, and never a test just to have one. Before adding a test,
ask: *if this behavior broke, which existing test would fail?* If one would, that test
changes instead. No test for a change with no behavior in it (a refactor, a rename, a
moved file), for something that only restates the implementation, or for a cosmetic value.

**Only what a change can break gets run.** There is no full-suite gate. The unit layer is
picked by import graph (`npm run test:unit:changed`); the e2e layer by flow name — spec
names in `test/e2e` are flow names, and each spec's test titles say what it covers.
Layer-specific traps (`$HOME` sandboxing, why you must never `SIGKILL` a remembered pid,
how to drive native menu shortcuts) are in **`test/CLAUDE.md`**.

**Prettier decides the layout.** The config in `.prettierrc.json` was set from what the
tree already looked like — no semicolons, single quotes, 100 columns. Markdown is
deliberately left out (see `.prettierignore`): Prettier does not reflow paragraphs, so on
prose all it would do is churn emphasis markers, in the one place where a human's line
breaks carry meaning.

**There is no ESLint yet**, and not by choice: it needs `typescript-eslint` to read `.ts`
at all, and that still caps TypeScript at `<6.1.0` while this project is on the native
TypeScript 7, whose compiler API moved.

**No comments.** `npm run check:comments` (run by CI) rejects every comment in the code
except a tool directive (`@ts-expect-error`, `prettier-ignore`, …) or a marker such as
`// ADR-0007` or `// CC§9` that points at an ADR or a section of a contract ledger. What
the code cannot say itself goes, first fit wins, into a name, a test title, a contract
ledger, or an ADR — the full rule is under "Comments" in `CLAUDE.md`.

**No per-feature document survives its feature shipping.** A claim about behavior becomes
a test assertion; a reason the code needs, if it passes the bar in `CLAUDE.md`, becomes an
ADR in `docs/adr/`, cited by a marker where it applies; a measured fact about an outside
tool — something reading Koloft's own code cannot tell you, and that can drift when the
tool updates — goes to its contract ledger (`docs/claude-code-contract.md`,
`docs/codex-cli-contract.md`, or `docs/platform-contract.md` for Electron, Node, macOS, git
and GitHub) with the date, the version, and how it was established.

Code and documentation are in **English**.

## Licence

Koloft is GPL-3.0-or-later.
