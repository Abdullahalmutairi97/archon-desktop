import { WebContentsView, type BrowserWindow } from 'electron'
import type { WorkspacePreviewBounds } from '../shared/bridge/types'

/**
 * Owns at most one sandboxed native preview view. The view runs in its own
 * storage partition with no Node integration and no Archon preload, may not open
 * windows, and may only navigate within the same preview origin/path.
 */
export class WorkspacePreviewController {
  private view: WebContentsView | undefined

  constructor(private readonly getWindow: () => BrowserWindow | undefined) {}

  async open(url: string, bounds: WorkspacePreviewBounds): Promise<void> {
    this.close()
    const window = this.getWindow()
    if (!window || window.isDestroyed()) throw new Error('No window is available for a preview')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('Preview URL is invalid')
    }
    const ticket = parsed.pathname.split('/')[4] ?? 'view'
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: `preview:${ticket}`,
      },
    })
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', (event, target) => {
      if (!this.isSamePreview(target, url)) event.preventDefault()
    })
    view.setBounds(bounds)
    window.contentView.addChildView(view)
    this.view = view
    try {
      await view.webContents.loadURL(url)
    } catch (error) {
      this.close()
      throw error
    }
  }

  setBounds(bounds: WorkspacePreviewBounds): boolean {
    if (!this.view) return false
    this.view.setBounds(bounds)
    return true
  }

  close(): boolean {
    const view = this.view
    if (!view) return false
    const window = this.getWindow()
    try {
      window?.contentView.removeChildView(view)
    } catch {
      // The window may already be gone during shutdown.
    }
    try {
      view.webContents.close()
    } catch {
      // The contents may already be destroyed.
    }
    this.view = undefined
    return true
  }

  private isSamePreview(target: string, base: string): boolean {
    try {
      const candidate = new URL(target)
      const origin = new URL(base)
      return candidate.origin === origin.origin && candidate.pathname.startsWith(origin.pathname)
    } catch {
      return false
    }
  }
}
