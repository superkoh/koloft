import fs from 'fs'
import path from 'path'
import { assertFixtureDir } from './fixtureGuard'
import { runGit } from './gitFixture'

/**
 * The in-panel file editor's fixture kit).
 *
 * It runs ON TOP of `setupChangeFixture` rather than inside helpers/env.ts's workspace
 * seed, and that ordering is forced: `seedBrowseTree` OVERWRITES `.gitignore` with its own
 * four lines and then commits, so a `.env` rule written at workspace-creation time is gone
 * by the time any spec looks for it. Appending here — after the baseline commit, in a
 * commit of its own — is the only spelling where both rule sets survive.
 *
 * What it adds, and the one case each entry exists for:
 *  - `.env`, a gitignored FILE: invisible until the switch goes on (A-01/A-02).
 *  - `.venv/x.txt`, a file inside a gitignored DIRECTORY: hidden with the switch off, and
 *    with it on the folder appears marked and opens onto the (marked) file — the
 *    directory half of A-02.
 *  - `config/app.json`, committed and all-LF: the ⌘S subject, so a save is a one-line diff
 *    against a real baseline rather than an untracked all-additions blob.
 *  - `config/win.ini`, committed and all-CRLF: the `.ed-eol` oracle (B-10). Committed as
 *    bytes — no `.gitattributes`, and macOS git defaults `core.autocrlf` to false, so what
 *    is written is what stays on disk.
 *  - `config/big.txt`, 600 KB: over the 512 KB open cap and under the 2 MB read cap, so ✎
 *    is disabled for the SIZE reason and not for "the panel cannot read it" (N-01/B-04).
 */
export interface EditFixture {
  /** the workspace root, realpath'd */
  root: string
  /** `<root>/.env` — a gitignored file (A-01/A-02) */
  env: string
  /** `<root>/.venv` — a gitignored directory, and one file inside it (A-02) */
  venvDir: string
  venvFile: string
  /** `<root>/config` — the folder `New File…` is invoked on (B-06) */
  configDir: string
  /** `<root>/config/app.json` — committed, LF, small (B-15/B-17) */
  config: string
  /** the exact bytes `config` was committed with, so a save assertion can compare the
   *  whole file rather than search it (B-18's "nothing else moved") */
  configBody: string
  /** `<root>/config/win.ini` — committed, every line CRLF (B-10) */
  crlf: string
  /** `<root>/config/big.txt` — 600 KB of plain text (N-01) */
  big: string
  /** repo-relative form, which is the key Changes' `.cv-blk[data-path]` uses */
  rel(abs: string): string
}

/** 6000 lines × 100 bytes = 600,000 bytes: comfortably over the 512 KiB (524,288 byte)
 *  editing cap and nowhere near the 2 MB read cap, so the ✎ that stays disabled can only
 *  be disabled for the size. */
const BIG_LINES = 6000

export const EDIT_CONFIG_BODY =
  '{\n' +
  '  "name": "koloft-e2e-edit-fixture",\n' +
  '  "requestTimeoutMs": 30000,\n' +
  '  "retries": 3\n' +
  '}\n'

/** All-CRLF on purpose, including the last line: a single stray LF would put the file in
 *  B-04's mixed-endings bucket and the ✎ under test would be disabled for that instead. */
const EDIT_CRLF_BODY = '; koloft-e2e-crlf fixture\r\nkey=value\r\nother=2\r\n'

export function seedEditFixture(dir: string): EditFixture {
  assertFixtureDir('seedEditFixture', dir)
  const root = fs.realpathSync(dir)
  const at = (rel: string): string => path.join(root, rel)

  // APPEND, never rewrite: `seedBrowseTree`'s four rules are load-bearing for every other
  // Files spec, and `NOTES.md` in particular keeps fake-claude's own startup write out of
  // the change set.
  const ignoreFile = at('.gitignore')
  fs.appendFileSync(ignoreFile, '.env\n.venv/\n')

  // The CRLF file has to stay CRLF in the WORKING TREE no matter whose machine this runs
  // on: `runGit` pins the identity and the default branch but not `core.autocrlf`, and the
  // developer's own ~/.gitconfig is still read (git warns about it out loud). `-text` turns
  // every conversion off for that one file, so no later git command can flatten it.
  fs.writeFileSync(at('.gitattributes'), 'config/win.ini -text\n')

  fs.mkdirSync(at('config'), { recursive: true })
  fs.mkdirSync(at('.venv'), { recursive: true })

  fs.writeFileSync(
    at('.env'),
    'DATABASE_URL=postgres://dev:dev@localhost:5432/app\nSESSION_SECRET=change-me\n'
  )
  fs.writeFileSync(at('.venv/x.txt'), 'koloft-e2e-venv-inner\n')
  fs.writeFileSync(at('config/app.json'), EDIT_CONFIG_BODY)
  fs.writeFileSync(at('config/win.ini'), EDIT_CRLF_BODY)
  fs.writeFileSync(
    at('config/big.txt'),
    Array.from(
      { length: BIG_LINES },
      (_, i) => `line ${String(i).padStart(5, '0')} ` + 'x'.repeat(88)
    ).join('\n') + '\n'
  )

  // Added by PATH rather than with `-A`: `.env` and `.venv/` are ignored and would need a
  // `-f` to land, and naming the four files makes it impossible for a stray file another
  // helper wrote to ride into this commit unnoticed.
  runGit(
    root,
    'add',
    '--',
    '.gitignore',
    '.gitattributes',
    'config/app.json',
    'config/win.ini',
    'config/big.txt'
  )
  runGit(root, 'commit', '-q', '-m', 'edit fixture')

  return {
    root,
    env: at('.env'),
    venvDir: at('.venv'),
    venvFile: at('.venv/x.txt'),
    configDir: at('config'),
    config: at('config/app.json'),
    configBody: EDIT_CONFIG_BODY,
    crlf: at('config/win.ini'),
    big: at('config/big.txt'),
    rel: (abs: string) => path.relative(root, abs)
  }
}
