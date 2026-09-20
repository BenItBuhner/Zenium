import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ShareMenu: class {
    popup(): void {
      /* macOS only; never reached here */
    }
  }
}))

import { sharedFileName, writeShared } from '../shareSheet'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('sharedFileName', () => {
  it('keeps a plain name, strips paths and unsafe characters, names the nameless by type', () => {
    expect(sharedFileName({ name: 'photo.png', type: 'image/png' })).toBe('photo.png')
    expect(sharedFileName({ name: '../../etc/passwd', type: 'text/plain' })).toBe('passwd')
    expect(sharedFileName({ name: 'a:b*c?.txt', type: 'text/plain' })).toBe('a_b_c_.txt')
    expect(sharedFileName({ name: '', type: 'image/jpeg' })).toBe('shared.jpg')
    expect(sharedFileName({ name: '..', type: 'application/octet-stream' })).toBe('shared')
  })
})

describe('writeShared', () => {
  it('writes the bytes under the folder and never overwrites what is there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zenium-share-test-'))
    dirs.push(dir)
    const file = {
      name: 'note.txt',
      type: 'text/plain',
      size: 5,
      data: Buffer.from('hello').toString('base64')
    }
    const first = await writeShared([file], dir)
    const second = await writeShared(
      [file, { ...file, data: Buffer.from('again').toString('base64') }],
      dir
    )
    expect(first.map((p) => basename(p))).toEqual(['note.txt'])
    expect(second.map((p) => basename(p))).toEqual(['note (1).txt', 'note (2).txt'])
    expect(await readFile(first[0], 'utf8')).toBe('hello')
    expect(await readFile(second[1], 'utf8')).toBe('again')
    expect((await readdir(dir)).sort()).toEqual(['note (1).txt', 'note (2).txt', 'note.txt'])
  })
})
