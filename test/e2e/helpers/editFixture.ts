import fs from 'fs'
import path from 'path'
import { assertFixtureDir } from './fixtureGuard'
import { runGit } from './gitFixture'

export interface EditFixture {
  root: string
  env: string
  venvDir: string
  venvFile: string
  configDir: string
  config: string
  configBody: string
  crlf: string
  big: string
  rel(abs: string): string
}

const BIG_LINES_FOR_600KB_OVER_512KIB_EDIT_CAP_UNDER_2MB_READ_CAP = 6000

export const EDIT_CONFIG_BODY =
  '{\n' +
  '  "name": "koloft-e2e-edit-fixture",\n' +
  '  "requestTimeoutMs": 30000,\n' +
  '  "retries": 3\n' +
  '}\n'

const EDIT_ALL_CRLF_BODY_EVEN_LAST_LINE = '; koloft-e2e-crlf fixture\r\nkey=value\r\nother=2\r\n'

const CRLF_FILE_IMMUNE_TO_AUTOCRLF_ATTRIBUTES = 'config/win.ini -text\n'

export function seedEditFixture(dir: string): EditFixture {
  assertFixtureDir('seedEditFixture', dir)
  const root = fs.realpathSync(dir)
  const at = (rel: string): string => path.join(root, rel)

  const ignoreFile = at('.gitignore')
  fs.appendFileSync(ignoreFile, '.env\n.venv/\n')

  fs.writeFileSync(at('.gitattributes'), CRLF_FILE_IMMUNE_TO_AUTOCRLF_ATTRIBUTES)

  fs.mkdirSync(at('config'), { recursive: true })
  fs.mkdirSync(at('.venv'), { recursive: true })

  fs.writeFileSync(
    at('.env'),
    'DATABASE_URL=postgres://dev:dev@localhost:5432/app\nSESSION_SECRET=change-me\n'
  )
  fs.writeFileSync(at('.venv/x.txt'), 'koloft-e2e-venv-inner\n')
  fs.writeFileSync(at('config/app.json'), EDIT_CONFIG_BODY)
  fs.writeFileSync(at('config/win.ini'), EDIT_ALL_CRLF_BODY_EVEN_LAST_LINE)
  fs.writeFileSync(
    at('config/big.txt'),
    Array.from(
      { length: BIG_LINES_FOR_600KB_OVER_512KIB_EDIT_CAP_UNDER_2MB_READ_CAP },
      (_, i) => `line ${String(i).padStart(5, '0')} ` + 'x'.repeat(88)
    ).join('\n') + '\n'
  )

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
