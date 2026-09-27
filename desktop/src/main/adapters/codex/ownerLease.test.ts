import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireCodexOwnerLease } from './ownerLease'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'archon-codex-lease-'))
  roots.push(parent)
  return join(parent, 'metadata')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Codex metadata owner lease', () => {
  it('creates a private root and exclusive 0600 lock, then releases it', async () => {
    const root = await temporaryRoot()
    const lease = await acquireCodexOwnerLease(root, 'electron-main')
    const directory = await stat(root)
    const lock = await stat(join(root, '.archon-codex-owner.lock'))

    expect(directory.mode & 0o777).toBe(0o700)
    expect(lock.mode & 0o777).toBe(0o600)
    await expect(acquireCodexOwnerLease(root, 'backend-worker')).rejects.toThrow(/Another process owns/)

    await lease.release()
    await expect(lstat(join(root, '.archon-codex-owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    const nextLease = await acquireCodexOwnerLease(root, 'backend-worker')
    nextLease.releaseSync()
  })

  it('leaves an existing or stale lock untouched and fails closed', async () => {
    const root = await temporaryRoot()
    await (await acquireCodexOwnerLease(root, 'seed')).release()
    const lockPath = join(root, '.archon-codex-owner.lock')
    const stale = Buffer.from('{"format":"old-owner"}\n')
    await writeFile(lockPath, stale, { mode: 0o600 })

    await expect(acquireCodexOwnerLease(root, 'new-owner')).rejects.toThrow(/Another process owns/)
    expect(await readFile(lockPath)).toEqual(stale)
  })

  it('rejects symlinked path components and lock symlinks', async () => {
    const root = await temporaryRoot()
    const parent = join(root, '..')
    const target = join(parent, 'real-metadata')
    const link = join(parent, 'metadata-link')
    await mkdir(target, { mode: 0o700 })
    await symlink(target, link)
    await expect(acquireCodexOwnerLease(join(link, 'child'), 'owner')).rejects.toThrow(/symbolic link/)

    const lockPath = join(root, '.archon-codex-owner.lock')
    const targetFile = join(parent, 'lock-target')
    await mkdir(root, { mode: 0o700 })
    await writeFile(targetFile, 'leave this file alone')
    await symlink(targetFile, lockPath)
    await expect(acquireCodexOwnerLease(root, 'owner')).rejects.toThrow(/Another process owns/)
    expect(await readFile(targetFile, 'utf8')).toBe('leave this file alone')
    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true)
  })

  it('does not remove a replacement lock when releasing', async () => {
    const root = await temporaryRoot()
    const lease = await acquireCodexOwnerLease(root, 'owner')
    const lockPath = join(root, '.archon-codex-owner.lock')
    await unlink(lockPath)
    const replacement = Buffer.from('replacement owner\n')
    await writeFile(lockPath, replacement, { mode: 0o600 })

    lease.releaseSync()
    expect(await readFile(lockPath)).toEqual(replacement)
  })

  it('requires an absolute root and a bounded safe owner label', async () => {
    await expect(acquireCodexOwnerLease('relative/codex', 'owner')).rejects.toThrow(/absolute/)
    await expect(acquireCodexOwnerLease(await temporaryRoot(), '../owner')).rejects.toThrow(/owner label/)
    expect(constants.O_NOFOLLOW).toBeTypeOf('number')
  })
})
