import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeCodexProjectId, makeCodexTaskId, toCodexSessionId } from './ids'
import { CODEX_METADATA_FILENAME, OwnedCodexMetadataStore } from './metadata'

const directories: string[] = []

async function profileDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archon-codex-core-'))
  directories.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('owned Codex metadata v1', () => {
  it('loads empty state and atomically stores only owned ids and nonsecret metadata', async () => {
    const dir = await profileDir()
    const store = new OwnedCodexMetadataStore(dir)
    const empty = await store.load()
    expect(empty).toEqual({ version: 1, sessions: [], projects: [] })

    await store.replace({
      ...empty,
      retainedPreference: { theme: 'dark' },
      projects: [{ id: makeCodexProjectId('p1'), name: 'Workspace', primary_path: dir, runtime: 'codex' }],
      sessions: [{
        id: toCodexSessionId('thread-1'), threadId: 'thread-1', title: 'Example',
        cwd: dir, projectId: makeCodexProjectId('p1'), turns: [{ id: makeCodexTaskId('t1'), turnId: 'turn-1' }],
      }],
    })

    const saved = await store.read()
    expect(saved.retainedPreference).toEqual({ theme: 'dark' })
    expect(saved.sessions[0].turns[0].id).toBe('codex-task:t1')
    const file = join(dir, CODEX_METADATA_FILENAME)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).not.toContain('conversation text')
  })

  it('fails closed on future/corrupt versions without replacing their source', async () => {
    const dir = await profileDir()
    const file = join(dir, CODEX_METADATA_FILENAME)
    const original = '{"version":2,"sessions":[],"projects":[]}\n'
    await writeFile(file, original)
    const store = new OwnedCodexMetadataStore(dir)
    await expect(store.load()).rejects.toThrow(/metadata/i)
    expect(await readFile(file, 'utf8')).toBe(original)
  })

  it('rejects a token field and a symlinked metadata file', async () => {
    const dir = await profileDir()
    const store = new OwnedCodexMetadataStore(dir)
    const empty = await store.load()
    await expect(store.replace({ ...empty, token: 'codex-token-sentinel' })).rejects.toThrow(/metadata/i)

    const real = join(dir, 'actual.json')
    await writeFile(real, JSON.stringify(empty))
    const file = join(dir, CODEX_METADATA_FILENAME)
    const { symlink } = await import('node:fs/promises')
    await symlink(real, file)
    await expect(new OwnedCodexMetadataStore(dir).load()).rejects.toThrow(/metadata/i)
    expect(await readFile(real, 'utf8')).toBe(JSON.stringify(empty))
  })

  it('rejects credential-shaped unknown keys while preserving unrelated compatibility fields', async () => {
    const dir = await profileDir()
    const store = new OwnedCodexMetadataStore(dir)
    const empty = await store.load()

    await expect(store.replace({ ...empty, retainedPreference: { theme: 'dark' } })).resolves.toMatchObject({
      retainedPreference: { theme: 'dark' },
    })
    await expect(store.replace({ ...empty, sessionCookie: 'fixture-secret' })).rejects.toThrow(/metadata/i)
    await expect(store.replace({ ...empty, oauth_access_token: 'fixture-secret' })).rejects.toThrow(/metadata/i)
  })
})
