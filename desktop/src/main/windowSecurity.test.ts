import { describe, expect, it } from 'vitest'
import {
  isAllowedReconstructionNavigation,
  reconstructionWindowSecurity,
} from './windowSecurity'

describe('isolated reconstruction window', () => {
  it('keeps Node disabled, context isolation enabled, and the renderer sandboxed', () => {
    expect(reconstructionWindowSecurity).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    })
  })

  it('allows only the exact local file or the configured loopback shell document', () => {
    const fileUrl = 'file:///tmp/archon-desktop-reconstruction/out/renderer/index.html'
    expect(isAllowedReconstructionNavigation(fileUrl, undefined, fileUrl)).toBe(true)
    expect(
      isAllowedReconstructionNavigation(
        'http://127.0.0.1:5173/',
        'http://127.0.0.1:5173',
      ),
    ).toBe(true)
    expect(
      isAllowedReconstructionNavigation(
        'http://127.0.0.1:5173/projects',
        'http://127.0.0.1:5173',
      ),
    ).toBe(false)
    expect(
      isAllowedReconstructionNavigation(
        'http://127.0.0.1:5173/?impersonate=1',
        'http://127.0.0.1:5173',
      ),
    ).toBe(false)
    expect(
      isAllowedReconstructionNavigation('https://example.test/', 'http://127.0.0.1:5173'),
    ).toBe(false)
    expect(
      isAllowedReconstructionNavigation(
        'file:///tmp/unrelated.html',
        undefined,
        fileUrl,
      ),
    ).toBe(false)
  })
})
