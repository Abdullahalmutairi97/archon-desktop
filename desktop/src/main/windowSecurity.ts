export const reconstructionWindowSecurity = Object.freeze({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
})

export function isAllowedReconstructionNavigation(
  destination: string,
  rendererDevOrigin?: string,
  rendererFileUrl?: string,
): boolean {
  try {
    const target = new URL(destination)
    if (rendererDevOrigin && target.origin === rendererDevOrigin) return true
    return target.protocol === 'file:' && destination === rendererFileUrl
  } catch {
    return false
  }
}
