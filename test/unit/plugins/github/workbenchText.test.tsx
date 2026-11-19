// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import type { GithubInfo, PrChecks, SessionInfo } from '../../../../src/shared/types'

let info: GithubInfo | null = null
let checks: PrChecks = { state: 'ok', checks: [] }
let failingText: string | null = null

;(window as unknown as { api: unknown }).api = {
  github: {
    info: async () => info,
    onInfo: () => () => {},
    checks: async () => checks,
    failingChecksText: async () => failingText
  },
  terminal: { paste: async () => {} }
}

const { render, renderHook, cleanup, act, waitFor } = await import('@testing-library/react')
const { useStore } = await import('../../../../src/renderer/src/store')
const { useWorkbenchGithub, GithubButton, GithubMenu } =
  await import('../../../../src/plugins/github/renderer/workbench')

afterEach(cleanup)

const SESSION = { tabId: 'pty-1', alive: true } as SessionInfo
const at = (over: Partial<GithubInfo>): GithubInfo => ({
  repoUrl: 'https://github.com/acme/widgets',
  pullsUrl: 'https://github.com/acme/widgets/pulls',
  branch: 'feature/login',
  pr: 265,
  pending: false,
  failed: false,
  ...over
})
const LINK = 'https://github.com/acme/widgets/actions/runs/1/job/2'

async function hookFor(next: GithubInfo, nextChecks: PrChecks) {
  info = next
  checks = nextChecks
  const hook = renderHook(() =>
    useWorkbenchGithub(
      true,
      '/repo',
      SESSION,
      () => {},
      () => {}
    )
  )
  await waitFor(() => expect(hook.result.current.info).not.toBeNull())
  if (next.pr !== null) await waitFor(() => expect(hook.result.current.checksText).not.toBeNull())
  return hook
}

async function toastAfter(run: () => void): Promise<string> {
  useStore.setState({ toast: null })
  await act(async () => run())
  await waitFor(() => expect(useStore.getState().toast).not.toBeNull())
  return useStore.getState().toast ?? ''
}

describe('the full text of the Workbench GitHub button, its menu and its toasts, pinned so that moving them changes no character', () => {
  it('what the button, its menu and the toasts say', async () => {
    const lines: string[] = []
    const failing: PrChecks = {
      state: 'ok',
      checks: [
        { name: 'test', bucket: 'fail', link: LINK, workflow: 'CI' },
        { name: 'lint', bucket: 'pass', link: LINK, workflow: 'CI' }
      ]
    }
    const cases: [string, GithubInfo, PrChecks][] = [
      ['a pull request whose checks fail', at({}), failing],
      ['no pull request', at({ pr: null }), { state: 'ok', checks: [] }]
    ]
    for (const [name, next, nextChecks] of cases) {
      const hook = await hookFor(next, nextChecks)
      const gh = hook.result.current
      const button = render(
        <GithubButton
          info={next}
          dot={gh.dot}
          label={gh.label}
          onOpen={() => {}}
          onMenu={() => {}}
        />
      )
      const menu = render(
        <GithubMenu
          gh={gh}
          info={next}
          treeRoot="/repo"
          onClose={() => {}}
          onOpen={() => {}}
          onCommit={() => {}}
        />
      )
      lines.push(
        `== ${name}`,
        `button label: ${gh.label}`,
        `button text: ${button.container.textContent}`,
        ...[...menu.container.querySelectorAll('.mi')].map((m) => `menu: ${m.textContent}`)
      )
      hook.unmount()
      button.unmount()
      menu.unmount()
    }

    const sending = await hookFor(at({}), failing)
    failingText = null
    lines.push(
      `send with nothing failing: ${await toastAfter(() => void sending.result.current.sendFailingChecks())}`
    )
    sending.unmount()

    const failed = await hookFor(at({ pr: null }), { state: 'ok', checks: [] })
    info = at({ pr: null, failed: true })
    lines.push(
      `check again, GitHub unreachable: ${await toastAfter(failed.result.current.recheck)}`
    )
    failed.unmount()

    const none = await hookFor(at({ pr: null }), { state: 'ok', checks: [] })
    info = at({ pr: null })
    lines.push(`check again, no pull request: ${await toastAfter(none.result.current.recheck)}`)
    info = at({ pr: null, branch: null })
    lines.push(`check again, detached: ${await toastAfter(none.result.current.recheck)}`)
    none.unmount()

    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./text/workbench.txt')
  })
})
