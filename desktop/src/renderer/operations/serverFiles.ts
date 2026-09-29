import type { ServerFileItem } from '../../shared/bridge/types'
import { isServerFilePath, isServerFileText, SERVER_FILE_READ_MAX_BYTES } from '../../shared/bridge/validation'
import type { LiveScope } from '../live/useLiveServer'

export { isServerFilePath, isServerFileText, SERVER_FILE_READ_MAX_BYTES }

/** Plain-language messages for the transport's stable error codes. */
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  restricted_path: 'The server does not expose this path. Secret files and paths outside the file root are blocked.',
  not_found: 'That file or folder no longer exists on the server.',
  already_exists: 'Something with that name already exists there.',
  not_a_directory: 'That path is not a folder on the server.',
  too_large: 'The file is larger than the 100 MiB transfer limit.',
  binary_file: 'This looks like a binary file, so it cannot be opened as text. Download it instead.',
  upload_expired: 'Choose the file to upload again.',
  local_file_error: 'The file on this PC could not be read or written.',
  connection_changed: 'The server connection changed. Nothing more was sent.',
  not_connected: 'No server connection is configured.',
  unauthorized: 'The server did not accept the connection.',
  network_error: 'Could not reach the server. The change may or may not have been made; refresh to check.',
  response_too_large: 'The server reply was too large to show.',
  invalid_response: 'The server returned a reply this app could not verify.',
  unsupported_operation: 'This action is not available in this build.',
}

/** A stable transport code, read from the error or from Electron's forwarded message. */
export function serverFileErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')
    if (code && 'value' in code && typeof code.value === 'string') return code.value
    const message = Object.getOwnPropertyDescriptor(error, 'message')
    if (message && 'value' in message && typeof message.value === 'string') {
      // Electron forwards only the message; the transport's messages are fixed text.
      for (const [key, text] of Object.entries(TRANSPORT_MESSAGE_HINTS)) if (message.value.includes(text)) return key
    }
  } catch {
    return null
  }
  return null
}

/** Distinctive fragments of the main process's fixed messages. */
const TRANSPORT_MESSAGE_HINTS: Readonly<Record<string, string>> = {
  restricted_path: 'does not expose this path',
  not_found: 'does not exist on the server',
  already_exists: 'already exists on the server',
  not_a_directory: 'is not a folder on the server',
  too_large: '100 MiB transfer limit',
  binary_file: 'Binary files cannot be previewed',
  upload_expired: 'Choose the file to upload again',
  local_file_error: 'on this PC could not be read or written',
  connection_changed: 'connection changed while this request',
  unauthorized: 'did not accept the connection',
  network_error: 'Could not reach the configured server',
}

export function serverFileErrorMessage(error: unknown, fallback: string): string {
  const code = serverFileErrorCode(error)
  return (code && ERROR_MESSAGES[code]) || fallback
}

export class StaleConnectionError extends Error {
  readonly code = 'connection_changed'
  constructor() { super('The server connection changed.') }
}

/** Refuse a change when the connection moved on since this view loaded. */
export async function ensureCurrentConnection(scope: LiveScope): Promise<void> {
  const description = await scope.bridge.connection.describe()
  if (!description.configured || description.generation !== scope.generation) throw new StaleConnectionError()
}

export function joinServerPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name
}

export function parentServerPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

export function serverBaseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** A single new name typed by the user: one path segment the server will take as-is. */
export function isServerFileName(value: string): boolean {
  return !value.includes('/') && isServerFilePath(value)
}

/** The server lists its root as '.'; entries at the root have bare names. */
export function itemIsAddressable(item: ServerFileItem): boolean {
  return isServerFilePath(item.path)
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** Why a read file must stay read-only, or null when it can be saved back safely. */
export function readOnlyReason(content: string, truncated: boolean): string | null {
  if (truncated) return 'Only the first 1 MiB is shown, so saving is disabled. Download the file to see all of it.'
  if (content.includes('�')) return 'This file has bytes that are not UTF-8 text. Saving would change them, so editing is disabled.'
  if (!isServerFileText(content)) return 'This file is too large to save from here.'
  return null
}
