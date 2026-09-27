import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeCodexTaskId, toCodexSessionId } from './ids'
import { OwnedCodexMetadataStore } from './metadata'
import { CodexOwnedFileService, CodexOwnedPathAccess } from './pathAccess'

const directories: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archon-codex-path-'))
  directories.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('owned Codex file access', () => {
  it('reads and writes only files beneath the selected owned root', async () => {
    const root = await workspace()
    const outside = join(root, '..', 'outside.txt')
    const access = new CodexOwnedPathAccess()
    await writeFile(join(root, 'hello.ts'), 'hello')
    await mkdir(join(root, 'nested'))

    expect((await access.readText(root, 'hello.ts')).content).toBe('hello')
    await access.writeText(root, 'nested/new.ts', 'new')
    expect(await readFile(join(root, 'nested/new.ts'), 'utf8')).toBe('new')
    await expect(access.readText(root, '../outside.txt')).rejects.toThrow(/outside/i)
    await expect(access.readText(root, outside)).rejects.toThrow(/outside/i)
  })

  it('rejects symlinks, traversal, and protected credential paths for reads and writes', async () => {
    const root = await workspace()
    const elsewhere = await workspace()
    const access = new CodexOwnedPathAccess()
    await writeFile(join(root, 'safe.ts'), 'safe')
    await writeFile(join(elsewhere, 'secret.txt'), 'outside')
    await symlink(join(elsewhere, 'secret.txt'), join(root, 'linked.ts'))
    await writeFile(join(root, '.env.local'), 'fake-secret')
    await mkdir(join(root, '.ssh'))
    await writeFile(join(root, '.ssh', 'id_ed25519'), 'fake-key')

    await expect(access.readText(root, 'linked.ts')).rejects.toThrow(/symbolic link/i)
    await expect(access.writeText(root, 'linked.ts', 'overwrite')).rejects.toThrow(/symbolic link/i)
    await expect(access.readText(root, '.env.local')).rejects.toThrow(/private/i)
    await expect(access.writeText(root, '.ssh/id_ed25519', 'overwrite')).rejects.toThrow(/private/i)
    expect(await readFile(join(elsewhere, 'secret.txt'), 'utf8')).toBe('outside')
  })

  it('rejects a FIFO without waiting for a reader or writer', async () => {
    const root = await workspace()
    const fifo = join(root, 'fixture.pipe')
    execFileSync('mkfifo', [fifo])
    const access = new CodexOwnedPathAccess()
    const { open: openFile } = await import('node:fs/promises')

    const read = access.readText(root, 'fixture.pipe')
    const readResult = await Promise.race([
      read.then(() => 'opened', () => 'rejected'),
      new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), 100)),
    ])
    if (readResult === 'timed out') {
      const writer = await openFile(fifo, 'w')
      await Promise.allSettled([read, writer.close()])
    }
    expect(readResult).toBe('rejected')

    const write = access.writeText(root, 'fixture.pipe', 'fixture')
    const writeResult = await Promise.race([
      write.then(() => 'opened', () => 'rejected'),
      new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), 100)),
    ])
    if (writeResult === 'timed out') {
      const reader = await openFile(fifo, 'r')
      await Promise.allSettled([write, reader.close()])
    }
    expect(writeResult).toBe('rejected')
  })

  it('marks protected files and links restricted in listings without following them', async () => {
    const root = await workspace()
    const outside = await workspace()
    const access = new CodexOwnedPathAccess()
    await writeFile(join(root, 'visible.txt'), 'visible')
    await writeFile(join(root, 'auth.json'), 'fake-auth')
    await writeFile(join(outside, 'target.txt'), 'outside')
    await symlink(join(outside, 'target.txt'), join(root, 'shortcut.txt'))

    const rows = await access.list(root, '.')
    expect(rows.find((row) => row.name === 'visible.txt')?.restricted).toBe(false)
    expect(rows.find((row) => row.name === 'auth.json')?.restricted).toBe(true)
    expect(rows.find((row) => row.name === 'shortcut.txt')?.restricted).toBe(true)
  })

  it('resolves file roots from known owned Codex sessions only', async () => {
    const root = await workspace()
    const profile = await workspace()
    const store = new OwnedCodexMetadataStore(profile)
    const sessionId = toCodexSessionId('thread-owned')
    await store.replace({
      version: 1,
      projects: [],
      sessions: [{
        id: sessionId,
        threadId: 'thread-owned',
        title: 'Owned session',
        cwd: root,
        projectId: null,
        turns: [{ id: makeCodexTaskId('task-owned'), turnId: 'turn-owned' }],
      }],
    })
    await writeFile(join(root, 'owned.ts'), 'owned')
    const files = new CodexOwnedFileService(store)

    expect((await files.read(sessionId, 'owned.ts')).content).toBe('owned')
    await expect(files.read('prime:thread-owned', 'owned.ts')).rejects.toThrow(/owned Codex session/i)
    await expect(files.read('codex:foreign-thread', 'owned.ts')).rejects.toThrow(/owned Codex session/i)
    await expect(files.read(sessionId, '../outside')).rejects.toThrow(/outside/i)
  })
})
