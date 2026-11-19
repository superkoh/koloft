// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import type { SecretAskView } from '../../../../src/shared/types'

;(window as unknown as { api: unknown }).api = {
  secret: { answer: () => {}, done: () => {}, decline: () => {} }
}

const { render, cleanup } = await import('@testing-library/react')
const { SudoDialog, SecretPageBar } =
  await import('../../../../src/plugins/passwords/renderer/SecretAsk')

afterEach(cleanup)

const SUDO: Extract<SecretAskView, { kind: 'sudo' }> = {
  id: 's1',
  tabId: 'pty-1',
  kind: 'sudo',
  command: 'sudo make install',
  prompt: '[sudo] password for you:'
}
const PAGE = { id: 'p1', tabId: 'pty-1', guestId: 3, url: 'https://example.com/login' }

function textOf(el: Element): string[] {
  const lines = [`text: ${el.textContent}`]
  for (const labelled of el.querySelectorAll('[aria-label]'))
    lines.push(`aria-label: ${labelled.getAttribute('aria-label')}`)
  if (el.getAttribute('aria-label')) lines.push(`own aria-label: ${el.getAttribute('aria-label')}`)
  for (const titled of el.querySelectorAll('[title]'))
    lines.push(`title: ${titled.getAttribute('title')}`)
  return lines
}

describe('the full text of the sudo box and the bar above a Workbench page, pinned so that moving them changes no character', () => {
  it('what the sudo box and each kind of page bar say', async () => {
    const lines: string[] = []
    const cases: [string, () => ReturnType<typeof render>][] = [
      ['sudo box', () => render(<SudoDialog ask={SUDO} shown />)],
      [
        'sudo box, sudo printed no prompt',
        () => render(<SudoDialog ask={{ ...SUDO, prompt: '' }} shown />)
      ],
      [
        'page bar, a password field',
        () => render(<SecretPageBar ask={{ ...PAGE, kind: 'page', label: 'GitHub password' }} />)
      ],
      [
        'page bar, a click',
        () => render(<SecretPageBar ask={{ ...PAGE, kind: 'tap', label: 'the Approve button' }} />)
      ],
      [
        'page bar, a sign-in',
        () =>
          render(
            <SecretPageBar
              ask={{ id: 'u1', tabId: 'pty-1', kind: 'url', signIn: 'https://example.com/auth' }}
            />
          )
      ]
    ]
    for (const [name, draw] of cases) {
      const view = draw()
      lines.push(`== ${name}`, ...textOf(view.container.firstElementChild as Element))
      view.unmount()
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./text/window.txt')
  })
})
