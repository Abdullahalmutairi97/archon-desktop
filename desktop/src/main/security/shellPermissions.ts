/**
 * Permission decisions for the trusted app window. Everything is denied except
 * writing text to the clipboard (the Copy buttons), and only from the top
 * frame of the trusted app document - never a subframe or another page.
 * Reading the clipboard is never allowed.
 */
export const SHELL_ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

export function allowShellPermission(
  permission: string,
  details: { isMainFrame?: boolean; requestingUrl?: string } | undefined,
  trustedDocumentUrl: string,
): boolean {
  if (!SHELL_ALLOWED_PERMISSIONS.has(permission) || details?.isMainFrame !== true) return false
  const requestingUrl = details.requestingUrl ?? ''
  try {
    const requested = new URL(requestingUrl)
    const trusted = new URL(trustedDocumentUrl)
    if (requested.protocol === 'file:') return requested.pathname === trusted.pathname && trusted.protocol === 'file:'
    return requested.origin === trusted.origin && trusted.protocol !== 'file:'
  } catch {
    return false
  }
}
