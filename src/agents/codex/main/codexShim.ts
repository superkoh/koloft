// CODEX§18
export const CODEX_FLAGS_FOLLOWED_BY_A_VALUE = [
  '-c',
  '--config',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
  '-i',
  '--image',
  '-m',
  '--model',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-C',
  '--cd',
  '--add-dir',
  '-a',
  '--ask-for-approval'
].join('|')

// CODEX§18
export const CODEX_SUBCOMMANDS_WITHOUT_A_TUI = [
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'plugin',
  'mcp-server',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'a',
  'queue',
  'archive',
  'delete',
  'migrate-rollouts',
  'migrate-nfs-db',
  'unarchive',
  'exec-server',
  'features',
  'help'
].join('|')

export const CODEX_SANDBOX_IS_READ_ONLY =
  'koloft: this sandbox is read-only, so koloft cannot run here.'
