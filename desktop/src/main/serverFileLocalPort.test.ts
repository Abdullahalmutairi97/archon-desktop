import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServerFileLocalPort, safeDownloadName, UPLOAD_PICK_TTL_MS } from './serverFileLocalPort'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'archon-server-files-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('server file local port', () => {
  it('hands out a one-use pick id and never the local path', async () => {
    const source = join(directory, 'photo.png')
    await writeFile(source, new Uint8Array([1, 2, 3]))
    const port = createServerFileLocalPort({ chooseOpenFile: async () => source, chooseSaveFile: async () => null, downloadsDirectory: () => directory })
    const picked = await port.pickUpload()
    expect(picked).toEqual({ pickId: expect.stringMatching(/^upload-[0-9a-f]{32}$/u), name: 'photo.png', size: 3 })
    expect(JSON.stringify(picked)).not.toContain(directory)
    expect(port.hasUpload(picked!.pickId)).toBe(true)
    const file = await port.takeUpload(picked!.pickId)
    expect(new Uint8Array(await file!.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(port.hasUpload(picked!.pickId)).toBe(false)
    await expect(port.takeUpload(picked!.pickId)).resolves.toBeNull()
  })

  it('expires a pick that waited too long', async () => {
    const source = join(directory, 'a.txt')
    await writeFile(source, 'a')
    let clock = 1_000
    const port = createServerFileLocalPort({ chooseOpenFile: async () => source, chooseSaveFile: async () => null, downloadsDirectory: () => directory }, () => clock)
    const picked = await port.pickUpload()
    clock += UPLOAD_PICK_TTL_MS + 1
    expect(port.hasUpload(picked!.pickId)).toBe(false)
  })

  it('writes a download beside the chosen path and renames it only on commit', async () => {
    const chooseSaveFile = vi.fn(async () => join(directory, 'report.pdf'))
    const port = createServerFileLocalPort({ chooseOpenFile: async () => null, chooseSaveFile, downloadsDirectory: () => directory })
    const sink = await port.chooseDownloadTarget('../evil\n.pdf')
    expect(chooseSaveFile).toHaveBeenCalledWith(join(directory, '.._evil_.pdf'))
    await sink!.write(new Uint8Array([65, 66]))
    expect(await readdir(directory)).not.toContain('report.pdf')
    await sink!.commit()
    expect(await readFile(join(directory, 'report.pdf'), 'utf8')).toBe('AB')
    expect(await readdir(directory)).toEqual(['report.pdf'])

    const failed = await port.chooseDownloadTarget('x')
    await failed!.write(new Uint8Array([1]))
    await failed!.abort()
    expect(await readdir(directory)).toEqual(['report.pdf'])
  })

  it('never offers an empty or dot name as a save default', () => {
    expect(safeDownloadName('')).toBe('download')
    expect(safeDownloadName('..')).toBe('download')
    expect(safeDownloadName('a/b')).toBe('a_b')
  })
})
