import { describe, expect, it } from 'vitest'
import {
  agyToolDid,
  claudeAskLine,
  claudeToolDid,
  codexEditTarget,
  codexItemDid,
  codexTaskName,
  storedAskLine
} from '../../src/main/rowActivity'

const LONG = 'x'.repeat(250)
const KEPT = 'x'.repeat(200)

describe('every tool event of each agent and the line it puts on the row, word for word', () => {
  it.each<[string, Record<string, unknown>, string | undefined]>([
    ['AskUserQuestion', { questions: [] }, undefined],
    ['ExitPlanMode', { plan: 'x' }, undefined],
    ['Bash', { command: 'npm  test\n--watch' }, 'Ran npm test --watch'],
    ['Bash', { command: LONG }, `Ran ${KEPT}`],
    ['Bash', { command: '  npm test  ' }, 'Ran npm test'],
    ['Bash', { command: '   ' }, undefined],
    ['Bash', {}, undefined],
    ['Edit', { file_path: '/r/src/foo.ts' }, 'Edited foo.ts'],
    ['MultiEdit', { file_path: '/r/m.ts' }, 'Edited m.ts'],
    ['NotebookEdit', { notebook_path: '/r/n.ipynb' }, 'Edited n.ipynb'],
    ['Edit', {}, undefined],
    ['Write', { file_path: '/r/a.md' }, 'Wrote a.md'],
    ['Write', {}, undefined],
    ['Read', { file_path: '/r/a.md' }, 'Read a.md'],
    ['Read', { path: '/r/p.md' }, 'Read p.md'],
    ['Read', {}, undefined],
    ['Grep', { pattern: 'TODO' }, 'Searched for TODO'],
    ['Glob', { pattern: '**/*.ts' }, 'Searched for **/*.ts'],
    ['Glob', {}, undefined],
    ['WebSearch', { query: 'vitest  workspaces' }, 'Searched the web for vitest workspaces'],
    ['WebSearch', {}, undefined],
    ['WebFetch', { url: 'https://example.com/a' }, 'Opened https://example.com/a'],
    ['WebFetch', {}, undefined],
    ['Agent', { description: 'Find the bug' }, 'Started a helper: Find the bug'],
    ['Task', { description: 'Run tests' }, 'Started a helper: Run tests'],
    ['Agent', {}, 'Started a helper: helper'],
    ['mcp__github__create_issue', {}, 'Used create_issue'],
    ['mcp__a__b__c', {}, 'Used b__c'],
    ['TodoWrite', { todos: [] }, 'Used TodoWrite']
  ])('Claude Code: %s %j → %s', (name, input, line) => {
    expect(claudeToolDid(name, input)).toBe(line)
  })

  it.each<[string, Record<string, unknown>, string | undefined]>([
    [
      'a file change',
      { type: 'fileChange', changes: [{ path: '/r/a.ts', kind: { type: 'update' } }] },
      'Edited a.ts'
    ],
    [
      'a file change that moves the file',
      {
        type: 'fileChange',
        changes: [{ path: '/r/old.ts', kind: { type: 'update', move_path: '/r/new.ts' } }]
      },
      'Edited new.ts'
    ],
    ['a file change with no changes', { type: 'fileChange', changes: [] }, undefined],
    [
      'a web search',
      { type: 'webSearch', query: '', action: { type: 'search', query: 'vitest  workspaces' } },
      'Searched the web for vitest workspaces'
    ],
    [
      'a web search with only its queries',
      { type: 'webSearch', action: { type: 'search', queries: ['first', 'second'] } },
      'Searched the web for first'
    ],
    [
      'a web search with only the item query',
      { type: 'webSearch', query: 'item query', action: { type: 'search' } },
      'Searched the web for item query'
    ],
    ['a web search with no query', { type: 'webSearch', action: { type: 'other' } }, undefined],
    [
      'an opened page',
      { type: 'webSearch', action: { type: 'openPage', url: 'https://e.com/p' } },
      'Opened https://e.com/p'
    ],
    [
      'an opened page named only by the item query',
      { type: 'webSearch', query: 'https://e.com/q', action: { type: 'openPage' } },
      'Opened https://e.com/q'
    ],
    [
      'an opened page with no address',
      { type: 'webSearch', action: { type: 'openPage' } },
      undefined
    ],
    [
      'a search in a page',
      {
        type: 'webSearch',
        action: { type: 'findInPage', url: 'https://e.com/p', pattern: 'timeout' }
      },
      'Searched https://e.com/p for timeout'
    ],
    [
      'a search in a page with no pattern',
      { type: 'webSearch', action: { type: 'findInPage', url: 'https://e.com/p' } },
      'Opened https://e.com/p'
    ],
    [
      'a spawned helper',
      {
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        receiverThreadIds: ['c1'],
        prompt: 'Check the lint config'
      },
      'Started a helper: Check the lint config'
    ],
    [
      'a spawned helper with no prompt',
      { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['c1'] },
      'Started a helper: helper'
    ],
    [
      'a spawn that started no child',
      { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: [], prompt: 'x' },
      undefined
    ],
    [
      'a wait on a helper',
      { type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: ['c1'] },
      undefined
    ],
    [
      'a sub-agent that started',
      { type: 'subAgentActivity', kind: 'started', agentPath: '/root/lint_checker' },
      'Started a helper: lint_checker'
    ],
    [
      'a sub-agent that started with no path',
      { type: 'subAgentActivity', kind: 'started' },
      'Started a helper: helper'
    ],
    [
      'a sub-agent that finished',
      { type: 'subAgentActivity', kind: 'completed', agentPath: '/root/lint_checker' },
      undefined
    ],
    [
      'a finished read',
      {
        type: 'commandExecution',
        status: 'completed',
        command: 'cat a.md',
        commandActions: [{ type: 'read', command: 'cat a.md', path: '/r/a.md' }]
      },
      'Read a.md'
    ],
    [
      'a failed read',
      {
        type: 'commandExecution',
        status: 'failed',
        command: 'sh -c cat a.md',
        commandActions: [{ type: 'read', command: 'cat  a.md', path: '/r/a.md' }]
      },
      'Ran cat a.md'
    ],
    [
      'a command of several actions',
      {
        type: 'commandExecution',
        status: 'completed',
        command: 'cat a.md && ls',
        commandActions: [
          { type: 'read', command: 'cat a.md', path: '/r/a.md' },
          { type: 'unknown', command: 'ls' }
        ]
      },
      'Ran cat a.md && ls'
    ],
    [
      'a command wrapped in a login shell',
      { type: 'commandExecution', status: 'completed', command: "/bin/zsh -lc 'npm test'" },
      'Ran npm test'
    ],
    [
      'a long command',
      { type: 'commandExecution', status: 'completed', command: LONG },
      `Ran ${KEPT}`
    ],
    ['a command with no text', { type: 'commandExecution', status: 'completed' }, undefined],
    ['a reply', { type: 'agentMessage', text: 'hi', command: 'echo hi' }, undefined]
  ])('Codex: %s', (_case, item, line) => {
    expect(codexItemDid(item)).toBe(line)
  })

  it('Codex: the file an edit names, and the helper name taken from an agent path', () => {
    expect(codexEditTarget({ type: 'commandExecution', changes: [{ path: '/r/a.ts' }] })).toBe(
      undefined
    )
    expect(codexEditTarget({ type: 'fileChange', changes: [{ path: '/r/a.ts', kind: {} }] })).toBe(
      '/r/a.ts'
    )
    expect(codexTaskName('/root/lint_checker')).toBe('lint_checker')
    expect(codexTaskName('/root/')).toBeUndefined()
    expect(codexTaskName(undefined)).toBeUndefined()
  })

  it.each<[string, Record<string, unknown>, string | undefined]>([
    ['ask_question', { Question: 'x' }, undefined],
    ['run_command', { CommandLine: 'make' }, 'Ran make'],
    ['run_command', { CommandLine: LONG }, `Ran ${KEPT}`],
    ['run_command', { CommandLine: '   ' }, undefined],
    ['replace_file_content', { TargetFile: '/r/e.go' }, 'Edited e.go'],
    ['edit_file', { Path: '/r/app.ts' }, 'Edited app.ts'],
    ['edit_file', {}, undefined],
    ['write_to_file', { TargetFile: '/r/e.go' }, 'Wrote e.go'],
    ['write_file', { Path: '/r/new.ts' }, 'Wrote new.ts'],
    ['write_file', {}, undefined],
    ['view_file', { AbsolutePath: '/r/old.md' }, 'Read old.md'],
    ['read_file', { Path: '/r/doc.md' }, 'Read doc.md'],
    ['read_file', {}, undefined],
    ['search_web', { query: 'vitest workspaces' }, 'Searched the web for vitest workspaces'],
    ['search_web', { Query: 'Big query' }, 'Searched the web for Big query'],
    ['search_web', {}, 'Used search_web'],
    [
      'invoke_subagent',
      { Role: 'Reviewer', TypeName: 't', Prompt: 'p' },
      'Started a helper: Reviewer'
    ],
    [
      'invoke_subagent',
      { Subagents: [{ Role: 'Check auth flow', TypeName: 't' }], TypeName: 'top' },
      'Started a helper: Check auth flow'
    ],
    ['invoke_subagent', { TypeName: 'research', Prompt: 'p' }, 'Started a helper: research'],
    [
      'invoke_subagent',
      { Subagents: [{ TypeName: 'inner', Prompt: 'p' }], toolSummary: 's' },
      'Started a helper: inner'
    ],
    [
      'invoke_subagent',
      { toolSummary: 'Look around', Prompt: 'p' },
      'Started a helper: Look around'
    ],
    ['invoke_subagent', { Prompt: 'Inspect' }, 'Started a helper: Inspect'],
    [
      'invoke_subagent',
      { Subagents: [{ Prompt: 'Inner prompt' }] },
      'Started a helper: Inner prompt'
    ],
    ['invoke_subagent', { Subagents: ['not an object'] }, 'Started a helper: helper'],
    ['invoke_subagent', {}, 'Started a helper: helper'],
    ['swarm', { action: 'add', name: 'parser' }, 'Started a helper: parser'],
    ['swarm', { Action: 'add', Name: 'lexer' }, 'Started a helper: lexer'],
    ['swarm', { action: 'kill', name: 'parser' }, 'Stopped helper parser'],
    ['swarm', { action: 'add' }, 'Managed swarm (add)'],
    ['swarm', { action: 'kill' }, 'Managed swarm (kill)'],
    ['swarm', { action: 'list' }, 'Managed swarm (list)'],
    ['swarm', {}, 'Used swarm'],
    ['manage_subagents', { Action: 'kill' }, 'Stopped subagents'],
    ['manage_subagents', { Action: 'kill_all' }, 'Stopped subagents'],
    ['manage_subagents', { Action: 'list' }, 'Managed subagents (list)'],
    ['manage_subagents', {}, 'Used manage_subagents'],
    ['schedule', { Prompt: 'Check build', DurationSeconds: 30 }, 'Scheduled Check build'],
    ['schedule', { toolSummary: 'Nightly run' }, 'Scheduled Nightly run'],
    ['schedule', { CronExpression: '0 3 * * *' }, 'Scheduled 0 3 * * *'],
    ['schedule', { DurationSeconds: 45 }, 'Scheduled 45s timer'],
    ['schedule', { DurationSeconds: Number.NaN }, 'Used schedule'],
    ['schedule', { DurationSeconds: Number.POSITIVE_INFINITY }, 'Used schedule'],
    ['schedule', {}, 'Used schedule'],
    ['manage_task', { Action: 'kill', TaskId: 'task-2' }, 'Stopped task task-2'],
    ['manage_task', { Action: 'kill' }, 'Stopped a task'],
    ['manage_task', { Action: 'list' }, 'Managed task (list)'],
    ['manage_task', {}, 'Used manage_task'],
    ['send_message', { Recipient: 'c2', Message: 'Status?' }, 'Messaged c2'],
    ['send_message', { Message: 'Status?' }, 'Used send_message'],
    ['grep_search', { Query: 'x' }, 'Used grep_search'],
    ['', {}, undefined]
  ])('Antigravity: %s %j → %s', (name, raw, line) => {
    const arg = (k: string): string | undefined =>
      typeof raw[k] === 'string' ? (raw[k] as string) : undefined
    expect(agyToolDid(name, arg, raw)).toBe(line)
  })
})

describe('what a row says each agent did, in plain words', () => {
  it('Claude Code: a command, a file it changed, wrote or read, a search, a helper, any other tool', () => {
    expect(claudeToolDid('Bash', { command: 'npm  test\n--watch' })).toBe('Ran npm test --watch')
    expect(claudeToolDid('Edit', { file_path: '/r/src/foo.ts' })).toBe('Edited foo.ts')
    expect(claudeToolDid('Write', { file_path: '/r/a.md' })).toBe('Wrote a.md')
    expect(claudeToolDid('Read', { file_path: '/r/a.md' })).toBe('Read a.md')
    expect(claudeToolDid('Grep', { pattern: 'TODO' })).toBe('Searched for TODO')
    expect(claudeToolDid('Agent', { description: 'Find the bug' })).toBe(
      'Started a helper: Find the bug'
    )
    expect(claudeToolDid('mcp__github__create_issue', {})).toBe('Used create_issue')
  })

  it('Claude Code: asking you is not something it did', () => {
    expect(claudeToolDid('AskUserQuestion', { questions: [] })).toBeUndefined()
    expect(claudeToolDid('ExitPlanMode', { plan: 'x' })).toBeUndefined()
  })

  it('Antigravity: its own tool names, and no line for its question tool', () => {
    const args: Record<string, string> = { CommandLine: 'make', TargetFile: '/r/e.go' }
    const arg = (k: string): string | undefined => args[k]
    expect(agyToolDid('run_command', arg)).toBe('Ran make')
    expect(agyToolDid('replace_file_content', arg)).toBe('Edited e.go')
    expect(agyToolDid('write_to_file', arg)).toBe('Wrote e.go')
    expect(agyToolDid('search_web', arg)).toBe('Used search_web')
    expect(agyToolDid('ask_question', arg)).toBeUndefined()

    const modern = (name: string, raw: Record<string, unknown>): string | undefined =>
      agyToolDid(name, (k) => (typeof raw[k] === 'string' ? raw[k] : undefined), raw)
    expect(modern('write_file', { Path: '/r/new.ts' })).toBe('Wrote new.ts')
    expect(modern('edit_file', { Path: '/r/app.ts' })).toBe('Edited app.ts')
    expect(modern('read_file', { Path: '/r/doc.md' })).toBe('Read doc.md')
    expect(modern('view_file', { AbsolutePath: '/r/old.md' })).toBe('Read old.md')
    expect(modern('search_web', { query: 'vitest workspaces' })).toBe(
      'Searched the web for vitest workspaces'
    )
    expect(
      modern('invoke_subagent', {
        TypeName: 'teamwork',
        Role: 'Teamwork Multi-Agent Team',
        Prompt: 'Inspect'
      })
    ).toBe('Started a helper: Teamwork Multi-Agent Team')
    expect(
      modern('invoke_subagent', {
        Subagents: [{ TypeName: 'research', Role: 'Check auth flow', Prompt: 'Inspect' }]
      })
    ).toBe('Started a helper: Check auth flow')
    expect(modern('swarm', { action: 'add', name: 'parser' })).toBe('Started a helper: parser')
    expect(modern('swarm', { action: 'kill', name: 'parser' })).toBe('Stopped helper parser')
    expect(modern('manage_subagents', { Action: 'kill', ConversationIds: ['c1'] })).toBe(
      'Stopped subagents'
    )
    expect(modern('schedule', { DurationSeconds: 30, Prompt: 'Check build' })).toBe(
      'Scheduled Check build'
    )
    expect(modern('schedule', { DurationSeconds: 45 })).toBe('Scheduled 45s timer')
    expect(modern('manage_task', { Action: 'kill', TaskId: 'task-2' })).toBe('Stopped task task-2')
    expect(modern('send_message', { Recipient: 'c2', Message: 'Status?' })).toBe('Messaged c2')
    expect(modern('run_command', { CommandLine: '   ' })).toBeUndefined()
    expect(modern('schedule', { DurationSeconds: Number.NaN })).toBe('Used schedule')
    expect(modern('schedule', { DurationSeconds: Number.POSITIVE_INFINITY })).toBe('Used schedule')
  })
})

describe('what a row says while the session waits on you', () => {
  it('Claude Code: the first question it asks, a plan to approve, a command or a file edit it wants', () => {
    expect(
      claudeAskLine({
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            { question: 'English or Chinese?', options: ['English', 'Chinese'] },
            { question: 'Second?', options: ['a'] }
          ]
        }
      })
    ).toBe('Asks: English or Chinese?')
    expect(claudeAskLine({ tool_name: 'ExitPlanMode', tool_input: { plan: '1. a' } })).toBe(
      'Asks: Approve this plan?'
    )
    expect(claudeAskLine({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })).toBe(
      'Wants to run: rm -rf build'
    )
    expect(claudeAskLine({ tool_name: 'Edit', tool_input: { file_path: '/r/x.ts' } })).toBe(
      'Wants to edit: x.ts'
    )
  })

  it('Claude Code: the verb for a file follows the tool, so a read never says edit', () => {
    const ask = (tool_name: string, tool_input: Record<string, unknown>): string =>
      claudeAskLine({ tool_name, tool_input })
    expect(ask('Write', { file_path: '/r/w.ts' })).toBe('Wants to edit: w.ts')
    expect(ask('MultiEdit', { file_path: '/r/m.ts' })).toBe('Wants to edit: m.ts')
    expect(ask('NotebookEdit', { notebook_path: '/r/n.ipynb' })).toBe('Wants to edit: n.ipynb')
    expect(ask('Read', { file_path: '/etc/hosts' })).toBe('Wants to read: hosts')
    expect(ask('Grep', { pattern: 'x', path: '/elsewhere' })).toBe('Wants to read: elsewhere')
    expect(ask('Glob', { pattern: '*.ts', path: '/elsewhere' })).toBe('Wants to read: elsewhere')
    expect(ask('mcp__fs__read_file', { path: '/a/b.txt' })).toBe('Wants to use: read_file')
  })

  it('an ask kept for Codex or Antigravity: a question, a command, a file edit, a file read or a plan', () => {
    expect(
      storedAskLine({
        id: 1,
        questions: [
          { question: 'Which one?', options: [{ label: 'A' }] },
          { question: 'And then?', options: [{ label: 'B' }] }
        ]
      })
    ).toBe('Asks: Which one?')
    expect(storedAskLine({ id: 2, command: 'rm -rf build' })).toBe('Wants to run: rm -rf build')
    expect(storedAskLine({ id: 3, command: '/r/e.go', file: '/r/e.go' })).toBe(
      'Wants to edit: e.go'
    )
    expect(storedAskLine({ id: 6, command: '/etc/hosts', file: '/etc/hosts', read: true })).toBe(
      'Wants to read: hosts'
    )
    expect(
      storedAskLine({ id: 4, command: 'plan.md', reason: 'Approve the plan', plan: true })
    ).toBe('Asks: Approve this plan?')
    expect(storedAskLine({ id: 5, reason: 'Write outside the folder' })).toBe(
      'Asks: Write outside the folder'
    )
  })
})
