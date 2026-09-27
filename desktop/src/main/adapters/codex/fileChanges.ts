import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isProtectedCodexPath } from './pathAccess'

export type CodexFileChangeKind = 'add' | 'delete' | 'update'

export interface CodexFileChange {
  path: string
  kind: CodexFileChangeKind
  diff: string
  movePath?: string
}

export const MAX_CODEX_FILE_CHANGES = 16
export const MAX_CODEX_FILE_DIFF_CHARS = 16_000
export const MAX_CODEX_FILE_CHANGE_BYTES = 24 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

export function isRepresentableCodexDiff(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CODEX_FILE_DIFF_CHARS
    || !isWellFormedText(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return false
  }
  return true
}

function canonicalOwnedFilePath(root: string, input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length < 1 || input.length > 4096 || !isWellFormedText(input)
    || /[\u0000-\u001f\u007f]/.test(input) || !isAbsolute(input) || resolve(input) !== input) return undefined
  if (root.length > 4096 || !isAbsolute(root) || resolve(root) !== root) return undefined
  let actualRoot: string
  try {
    const rootDetails = lstatSync(root)
    if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) return undefined
    actualRoot = realpathSync(root)
    if (actualRoot !== root) return undefined
  } catch {
    return undefined
  }

  if (!isWithin(actualRoot, input) || actualRoot === input || isProtectedCodexPath(input)) return undefined
  const rel = relative(actualRoot, input)
  const parts = rel ? rel.split(sep) : []
  if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) return undefined

  let cursor = actualRoot
  for (let index = 0; index < parts.length; index += 1) {
    cursor = resolve(cursor, parts[index])
    let details
    try {
      details = lstatSync(cursor)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (index === parts.length - 1 && code === 'ENOENT' && isWithin(actualRoot, cursor)
        && !isProtectedCodexPath(cursor)) return cursor
      return undefined
    }
    if (details.isSymbolicLink() || (index < parts.length - 1 && !details.isDirectory())
      || (index === parts.length - 1 && !details.isFile())) return undefined
    try {
      const canonical = realpathSync(cursor)
      if (!isWithin(actualRoot, canonical) || isProtectedCodexPath(canonical)) return undefined
      cursor = canonical
    } catch {
      return undefined
    }
  }
  return isWithin(actualRoot, cursor) && !isProtectedCodexPath(cursor) ? cursor : undefined
}

function validateChanges(value: unknown, root: string, normalized: boolean): readonly CodexFileChange[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > MAX_CODEX_FILE_CHANGES) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key !== 'string')) return undefined

  const result: CodexFileChange[] = []
  const changedPaths = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const itemDescriptor = descriptors[String(index)]
    if (!itemDescriptor || !('value' in itemDescriptor) || !itemDescriptor.enumerable || !isRecord(itemDescriptor.value)) return undefined
    const change = itemDescriptor.value
    const changeKeys = Reflect.ownKeys(Object.getOwnPropertyDescriptors(change))
    const changeDescriptors = Object.getOwnPropertyDescriptors(change)
    const allowedChangeKeys = normalized ? ['path', 'kind', 'diff', 'movePath'] : ['path', 'kind', 'diff']
    if (changeKeys.some((key) => typeof key !== 'string' || !allowedChangeKeys.includes(key))) return undefined
    if (changeKeys.length < 3 || changeKeys.length > (normalized ? 4 : 3) || !['path', 'kind', 'diff'].every((key) => {
      const descriptor = changeDescriptors[key]
      return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable
    })) return undefined
    let kind: unknown
    let movePathInput: unknown
    if (normalized) {
      kind = change.kind
      const moveDescriptor = changeDescriptors.movePath
      if (moveDescriptor && (!('value' in moveDescriptor) || !moveDescriptor.enumerable)) return undefined
      movePathInput = moveDescriptor && 'value' in moveDescriptor ? moveDescriptor.value : undefined
    } else {
      if (!isRecord(change.kind)) return undefined
      const kindKeys = Reflect.ownKeys(Object.getOwnPropertyDescriptors(change.kind))
      if (kindKeys.some((key) => typeof key !== 'string' || !['type', 'move_path'].includes(key))) return undefined
      const kindDescriptors = Object.getOwnPropertyDescriptors(change.kind)
      if (!kindDescriptors.type || !('value' in kindDescriptors.type) || !kindDescriptors.type.enumerable) return undefined
      kind = kindDescriptors.type.value
      const moveDescriptor = kindDescriptors.move_path
      if (kind === 'update') {
        if (moveDescriptor && (
          !('value' in moveDescriptor) || !moveDescriptor.enumerable
          || (moveDescriptor.value !== null && typeof moveDescriptor.value !== 'string')
        )) return undefined
        movePathInput = moveDescriptor && 'value' in moveDescriptor && typeof moveDescriptor.value === 'string'
          ? moveDescriptor.value
          : undefined
      } else if (moveDescriptor !== undefined) {
        return undefined
      }
    }
    if (kind !== 'add' && kind !== 'delete' && kind !== 'update') return undefined
    if (movePathInput !== undefined && kind !== 'update') return undefined
    const path = canonicalOwnedFilePath(root, change.path)
    if (!path || changedPaths.has(path) || !isRepresentableCodexDiff(change.diff)) return undefined
    changedPaths.add(path)
    const movePath = movePathInput === undefined ? undefined : canonicalOwnedFilePath(root, movePathInput)
    if (movePathInput !== undefined && (!movePath || changedPaths.has(movePath))) return undefined
    if (movePath) changedPaths.add(movePath)
    result.push(Object.freeze({ path, kind, diff: change.diff, ...(movePath === undefined ? {} : { movePath }) }))
  }

  const frozen = Object.freeze(result)
  try {
    if (Buffer.byteLength(JSON.stringify(frozen), 'utf8') > MAX_CODEX_FILE_CHANGE_BYTES) return undefined
  } catch {
    return undefined
  }
  return frozen
}

/** Parse and canonicalize the complete item-start diff; any loss or ambiguity rejects the item. */
export function validateCodexFileChanges(value: unknown, root: string): readonly CodexFileChange[] | undefined {
  return validateChanges(value, root, false)
}

/** Revalidate the immutable normalized shape carried through the approval broker. */
export function validateCanonicalCodexFileChanges(value: unknown, root: string): readonly CodexFileChange[] | undefined {
  return validateChanges(value, root, true)
}

export function fileChangePaths(changes: readonly CodexFileChange[]): readonly string[] {
  const paths: string[] = []
  for (const change of changes) {
    paths.push(change.path)
    if (change.movePath) paths.push(change.movePath)
  }
  return Object.freeze(paths)
}
