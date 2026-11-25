import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  claudePlaywrightServers,
  claudeServers,
  codexServers,
  foldersUpToRepoTop,
  foldersUpToRoot,
  jsonServers,
  mcpServersIn
} from '../../src/main/mcpServers'

describe('the MCP servers koloft todo lists for the workspaces on this Mac', () => {
  // CC§22 AGY§30 CODEX§15
  it('reads each agent’s own files for each workspace: Claude Code’s ~/.claude.json and every .mcp.json up to /, Codex’s config.toml, Antigravity’s own settings and every .agents/mcp_config.json up to the repository’s top, in that order', async () => {
    const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-mcp-')))
    const json = (file: string, value: unknown): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(value))
    }
    const servers = (...names: string[]): unknown => ({
      mcpServers: Object.fromEntries(names.map((n) => [n, { command: n }]))
    })
    const repo = path.join(top, 'mono')
    const inRepo = path.join(repo, 'app')
    const lone = path.join(top, 'lone')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(inRepo, { recursive: true })
    fs.mkdirSync(lone, { recursive: true })
    json(path.join(top, 'home', '.claude.json'), {
      mcpServers: { everywhere: {}, off: { disabled: true } },
      projects: {
        [repo]: servers('underTheRepoKey'),
        [inRepo]: servers('underItsOwnPath'),
        [lone]: servers('underLone')
      }
    })
    json(path.join(inRepo, '.mcp.json'), servers('appFile'))
    json(path.join(repo, '.mcp.json'), servers('repoFile'))
    json(path.join(top, '.mcp.json'), servers('aboveFile'))
    fs.writeFileSync(path.join(top, 'config.toml'), '[mcp_servers.cx]\ncommand = "cx"\n')
    json(path.join(top, 'gemini', 'config', 'mcp_config.json'), servers('agyEverywhere'))
    json(path.join(inRepo, '.agents', 'mcp_config.json'), servers('agyApp'))
    json(path.join(repo, '.agents', 'mcp_config.json'), servers('agyRepo'))
    json(path.join(top, '.agents', 'mcp_config.json'), servers('agyAbove'))
    json(path.join(lone, '.agents', 'mcp_config.json'), servers('agyLone'))
    const homeBefore = process.env.HOME
    process.env.HOME = path.join(top, 'home')
    try {
      expect(
        await mcpServersIn(
          [inRepo, lone],
          () => path.join(top, 'config.toml'),
          () => path.join(top, 'gemini')
        )
      ).toEqual([
        { name: 'everywhere', backend: 'claude' },
        { name: 'underTheRepoKey', backend: 'claude', onlyIn: inRepo },
        { name: 'underLone', backend: 'claude', onlyIn: lone },
        { name: 'appFile', backend: 'claude', onlyIn: inRepo },
        { name: 'repoFile', backend: 'claude', onlyIn: inRepo },
        { name: 'aboveFile', backend: 'claude', onlyIn: inRepo },
        { name: 'aboveFile', backend: 'claude', onlyIn: lone },
        { name: 'cx', backend: 'codex' },
        { name: 'agyEverywhere', backend: 'agy' },
        { name: 'agyApp', backend: 'agy', onlyIn: inRepo },
        { name: 'agyRepo', backend: 'agy', onlyIn: inRepo },
        { name: 'agyLone', backend: 'agy', onlyIn: lone }
      ])
    } finally {
      process.env.HOME = homeBefore
      fs.rmSync(top, { recursive: true, force: true })
    }
  })
})

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

  // ADR-0048 CC§22 CC§24
  it('Claude: the Playwright MCP servers a folder reaches are those in ~/.claude.json’s own list, under its project key there and in the .mcp.json files given, each once, never one turned off, one that runs something else, or one under another project', () => {
    const playwright = { command: 'npx', args: ['@playwright/mcp@latest'] }
    const claudeJson = JSON.stringify({
      mcpServers: { playwright, linear: { command: 'linear-mcp' } },
      projects: {
        '/work/shop': {
          mcpServers: {
            browser: { command: '/opt/bin/playwright-mcp' },
            off: { ...playwright, disabled: true }
          }
        },
        '/work/blog': { mcpServers: { elsewhere: playwright } }
      }
    })
    expect(
      claudePlaywrightServers(
        claudeJson,
        [JSON.stringify({ mcpServers: { team: playwright, playwright } }), null, 'not json'],
        '/work/shop'
      )
    ).toEqual(['playwright', 'team', 'browser'])
    expect(claudePlaywrightServers(null, [], '/work/shop')).toEqual([])
  })

  // CC§24
  it('Claude: when two places name a server alike, the one Claude Code loads decides — the project entry in ~/.claude.json over a .mcp.json, the nearer .mcp.json over one further up, any .mcp.json over ~/.claude.json’s own list', () => {
    const playwright = { command: 'npx', args: ['@playwright/mcp'] }
    const other = { command: 'deploy-mcp' }
    const mcp = (servers: Record<string, unknown>): string =>
      JSON.stringify({ mcpServers: servers })
    const claudeJson = JSON.stringify({
      mcpServers: { a: playwright, b: other, c: playwright },
      projects: { '/w': { mcpServers: { a: other } } }
    })
    expect(
      claudePlaywrightServers(
        claudeJson,
        [mcp({ b: other, c: other, d: playwright }), mcp({ b: playwright })],
        '/w'
      )
    ).toEqual(['b', 'd'])
  })

  // AGY§30
  it('Antigravity: the mcpServers of its own settings reach every folder, a project file’s only that project, and one turned off is left out', () => {
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

  // CC§22 AGY§30
  it('a workspace in a sub-folder: Claude reads the project file of every folder up to /, Antigravity only up to the nearest folder holding .git even inside another repository, or only the workspace’s own outside a repository', async () => {
    expect(foldersUpToRoot('/work/mono/app')).toEqual([
      '/work/mono/app',
      '/work/mono',
      '/work',
      '/'
    ])
    const inRepo = async (folder: string): Promise<boolean> =>
      folder === '/work/mono' || folder === '/work'
    expect(await foldersUpToRepoTop('/work/mono/app', inRepo)).toEqual([
      '/work/mono/app',
      '/work/mono'
    ])
    expect(await foldersUpToRepoTop('/work/mono/app', async () => false)).toEqual([
      '/work/mono/app'
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
