// AGY§1
export const AGY_FLAGS_FOLLOWED_BY_A_VALUE = [
  '--add-dir',
  '--agent',
  '--conversation',
  '--effort',
  '-i',
  '--prompt-interactive',
  '--input-format',
  '--json-schema',
  '--log-file',
  '--mode',
  '--model',
  '--output-format',
  '--print-timeout',
  '--project'
].join('|')

// AGY§1
export const AGY_SUBCOMMANDS_WITHOUT_A_TUI = [
  'agent',
  'agents',
  'changelog',
  'help',
  'install',
  'mcp',
  'mic-serve',
  'models',
  'plugin',
  'plugins',
  'remote-control',
  'update'
].join('|')

export const exportsOf = (env: Record<string, string>): string =>
  `export ${Object.entries(env)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')}`

export const AGY_PRINT_OUTSIDE_A_SUBCOMMAND = `valflag=0
  for a in "$@"; do
    if [ "$valflag" = "1" ]; then valflag=0; continue; fi
    case "$a" in
      -p|--print|--prompt) pick=1 ;;
      ${AGY_FLAGS_FOLLOWED_BY_A_VALUE}) valflag=1 ;;
    esac
  done
  case "$sub" in ${AGY_SUBCOMMANDS_WITHOUT_A_TUI}) pick=0 ;; esac`
