import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function isTrustedNavigation(url: string, rendererPath: string, developmentUrl?: string): boolean {
  try {
    if (developmentUrl) {
      const candidate = new URL(url)
      const development = new URL(developmentUrl)
      return ['http:', 'https:'].includes(candidate.protocol) && ['http:', 'https:'].includes(development.protocol) && candidate.origin === development.origin
    }
    const parsed = new URL(url)
    return parsed.protocol === 'file:' && resolve(fileURLToPath(parsed)) === resolve(rendererPath)
  } catch {
    return false
  }
}
