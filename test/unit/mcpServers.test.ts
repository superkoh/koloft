import { describe, it, expect } from 'vitest'
import { claudeServers, codexServers } from '../../src/main/mcpServers'

describe('the MCP servers koloft todo reads from each agent’s own config', () => {
  it('Claude: a server in ~/.claude.json’s own list reaches every folder; one under a project there, or in a project’s .mcp.json, only that project', () => {
    const claudeJson = JSON.stringify({
      mcpServers: { linear: { command: 'linear-mcp' } },
      projects: { '/work/shop': { mcpServers: { jira: { type: 'http' } } }, '/work/blog': {} }
    })
    expect(
      claudeServers(claudeJson, [
        { folder: '/work/shop', text: JSON.stringify({ mcpServers: { notion: {} } }) },
        { folder: '/work/blog', text: null }
      ])
    ).toEqual([
      { name: 'linear', backend: 'claude' },
      { name: 'jira', backend: 'claude', onlyIn: '/work/shop' },
      { name: 'notion', backend: 'claude', onlyIn: '/work/shop' }
    ])
    expect(claudeServers(null, [])).toEqual([])
    expect(claudeServers('not json', [])).toEqual([])
  })

  it('Codex: each [mcp_servers.<name>] table in config.toml, its sub-tables and quoted names included, once', () => {
    const toml = [
      'model = "gpt"',
      '[mcp_servers.linear]',
      'command = "linear-mcp"',
      '[mcp_servers.linear.env]',
      'TOKEN_VAR = "X"',
      '[mcp_servers."my tasks"]',
      'url = "https://example.com"',
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
