// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import type { ExtensionPermissionRequest } from '../../src/shared/types'
import { ExtensionConfirm } from '../../src/renderer/src/components/ExtensionConfirm'

afterEach(cleanup)

describe('an extension’s ask takes its Esc away from the layers under it', () => {
  it('the Esc that denies the ask reaches neither the web overlay, Settings, nor a full Workbench under it', () => {
    const answers: [string, boolean][] = []
    const heard: string[] = []
    const overlayAndSettings = (e: KeyboardEvent): void => void heard.push(`window ${e.key}`)
    const fullWorkbench = (e: KeyboardEvent): void => void heard.push(`document ${e.key}`)
    window.addEventListener('keydown', overlayAndSettings)
    document.addEventListener('keydown', fullWorkbench, true)
    try {
      const request: ExtensionPermissionRequest = {
        id: 'ext-1',
        kind: 'permission',
        name: 'Helper',
        permissions: ['tabs'],
        origins: []
      }
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
      window.removeEventListener('keydown', overlayAndSettings)
      document.removeEventListener('keydown', fullWorkbench, true)
    }
  })
})
