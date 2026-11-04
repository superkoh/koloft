// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import type { ExtensionPermissionRequest } from '../../src/shared/types'
import { ExtensionConfirm } from '../../src/renderer/src/components/ExtensionConfirm'

afterEach(cleanup)

describe('an extension’s ask takes its Esc away from what sits behind it', () => {
  it('the Esc that denies the ask reaches nothing behind it, so a web overlay or a full Workbench stays open', () => {
    const answers: [string, boolean][] = []
    const heard: string[] = []
    const onWindow = (e: KeyboardEvent): void => void heard.push(`window ${e.key}`)
    const onDocument = (e: KeyboardEvent): void => void heard.push(`document ${e.key}`)
    window.addEventListener('keydown', onWindow)
    document.addEventListener('keydown', onDocument, true)
    try {
      const request = {
        id: 'ext-1',
        kind: 'permissions',
        name: 'Helper',
        permissions: ['tabs'],
        origins: []
      } as unknown as ExtensionPermissionRequest
      render(
        <ExtensionConfirm
          request={request}
          onAnswer={(id, granted) => answers.push([id, granted])}
        />
      )
      fireEvent.keyDown(screen.getByRole('button', { name: 'Deny' }), { key: 'Escape' })
      expect(answers).toEqual([['ext-1', false]])
      expect(heard).toEqual([])
    } finally {
      window.removeEventListener('keydown', onWindow)
      document.removeEventListener('keydown', onDocument, true)
    }
  })
})
