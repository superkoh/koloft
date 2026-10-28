import { describe, it, expect } from 'vitest'
import { claudeServers, codexServers, jsonServers } from '../../src/main/mcpServers'

describe('the MCP servers koloft todo reads from each agent’s own config', () => {
  // CC§22
  it('Claude: a server in ~/.claude.json’s own list reaches every folder; one under a project there, or in a project’s .mcp.json, only that project, and only a folder Koloft asks about counts', () => {
    const claudeJson = JSON.stringify({
      mcpServers: { linear: { command: 'linear-mcp' } },
      projects: {
        '/work/shop': { mcpServers: { jira: { type: 'http' } } },
        '/tmp/old-worktree': { mcpServers: { stale: {} } },
        '/work/blog': {}
      }
    })
    expect(
      claudeServers(
        claudeJson,
        [
          { onlyIn: '/work/shop', text: JSON.stringify({ mcpServers: { notion: {} } }) },
          { onlyIn: '/work/blog', text: null }
        ],
        [
          { folder: '/work/shop', projectKey: '/work/shop' },
          { folder: '/work/blog', projectKey: '/work/blog' }
        ]
      )
    ).toEqual([
      { name: 'linear', backend: 'claude' },
      { name: 'jira', backend: 'claude', onlyIn: '/work/shop' },
      { name: 'notion', backend: 'claude', onlyIn: '/work/shop' }
    ])
    expect(claudeServers(null, [], [])).toEqual([])
    expect(claudeServers('not json', [], [])).toEqual([])
  })

  // CC§22
  it('Claude: a folder whose projects key is another folder (inside a repository) gets the servers kept under that key, not those left under its own path, which Claude Code does not load there', () => {
    const claudeJson = JSON.stringify({
      projects: {
        '/work/mono': { mcpServers: { jira: {} } },
        '/work/mono/app': { mcpServers: { notion: {} } }
      }
    })
    expect(
      claudeServers(claudeJson, [], [{ folder: '/work/mono/app', projectKey: '/work/mono' }])
    ).toEqual([{ name: 'jira', backend: 'claude', onlyIn: '/work/mono/app' }])
  })

  // MUSE§18 AGY§30
  it('Muse and Antigravity: the mcpServers of their own settings reach every folder, a project file’s only that project, and one turned off is left out', () => {
    expect(
      jsonServers('agy', [
        {
          text: JSON.stringify({
            mcpServers: { linear: { command: 'x', disabled: false }, old: { disabled: true } }
          })
        },
        { onlyIn: '/work/shop', text: JSON.stringify({ mcpServers: { jira: {} } }) },
        { onlyIn: '/work/blog', text: '{' }
      ])
    ).toEqual([
      { name: 'linear', backend: 'agy' },
      { name: 'jira', backend: 'agy', onlyIn: '/work/shop' }
    ])
  })

  it('Codex: each [mcp_servers.<name>] table in config.toml, quoted names included, once, and not one turned off with enabled = false', () => {
    const toml = [
      'model = "gpt"',
      '[mcp_servers.linear]',
      'command = "linear-mcp"',
      '[mcp_servers.linear.env]',
      'TOKEN_VAR = "X"',
      '[mcp_servers."my tasks"]',
      'url = "https://example.com"',
      '[mcp_servers.old]',
      'command = "old-mcp"',
      'enabled = false',
      '[projects."/work/shop"]',
      'trust_level = "trusted"'
    ].join('\n')
    expect(codexServers(toml)).toEqual([
      { name: 'linear', backend: 'codex' },
      { name: 'my tasks', backend: 'codex' }
    ])
    expect(codexServers(null)).toEqual([])
  })
})
