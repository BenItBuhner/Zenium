import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { moveLegacyDirectory, planLegacyMove, type DirectoryProbe } from '../legacyPaths'

function probe(dirs: Record<string, 'empty' | 'full' | 'file'>): DirectoryProbe {
  return {
    exists: (path) => path in dirs,
    isDirectory: (path) => dirs[path] === 'empty' || dirs[path] === 'full',
    isEmpty: (path) => dirs[path] === 'empty'
  }
}

describe('planLegacyMove', () => {
  it('moves the old directory when the new one does not exist yet', () => {
    expect(planLegacyMove('/data/Zen', '/data/Zenium', probe({ '/data/Zen': 'full' }))).toEqual({
      action: 'move'
    })
  })

  it('moves into a new directory that exists but is still empty', () => {
    const plan = planLegacyMove(
      '/data/Zen',
      '/data/Zenium',
      probe({ '/data/Zen': 'full', '/data/Zenium': 'empty' })
    )
    expect(plan).toEqual({ action: 'move' })
  })

  it('never touches a new directory that already holds data', () => {
    const plan = planLegacyMove(
      '/data/Zen',
      '/data/Zenium',
      probe({ '/data/Zen': 'full', '/data/Zenium': 'full' })
    )
    expect(plan).toEqual({ action: 'skip', reason: 'current-in-use' })
  })

  it('does nothing without an old directory', () => {
    expect(planLegacyMove('/data/Zen', '/data/Zenium', probe({}))).toEqual({
      action: 'skip',
      reason: 'no-legacy'
    })
    expect(planLegacyMove('/data/Zen', '/data/Zenium', probe({ '/data/Zen': 'file' }))).toEqual({
      action: 'skip',
      reason: 'no-legacy'
    })
  })

  it('refuses to move a directory onto itself', () => {
    expect(planLegacyMove('/data/Zen', '/data/Zen', probe({ '/data/Zen': 'full' }))).toEqual({
      action: 'skip',
      reason: 'same-path'
    })
  })

  it('treats a file in the way as data in use', () => {
    const plan = planLegacyMove(
      '/data/Zen',
      '/data/Zenium',
      probe({ '/data/Zen': 'full', '/data/Zenium': 'file' })
    )
    expect(plan).toEqual({ action: 'skip', reason: 'current-in-use' })
  })
})

describe('moveLegacyDirectory', () => {
  function profile(): { root: string; legacy: string; current: string } {
    const root = mkdtempSync(join(tmpdir(), 'zenium-legacy-'))
    const legacy = join(root, 'Zen')
    mkdirSync(join(legacy, 'zen'), { recursive: true })
    writeFileSync(join(legacy, 'zen', 'state.json'), '{"tabs":1}')
    writeFileSync(join(legacy, 'Preferences'), 'chromium')
    return { root, legacy, current: join(root, 'Zenium') }
  }

  it('renames the old directory and keeps every file', () => {
    const { legacy, current } = profile()
    expect(moveLegacyDirectory(legacy, current)).toBe('moved')
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(current, 'zen', 'state.json'), 'utf8')).toBe('{"tabs":1}')
    expect(readFileSync(join(current, 'Preferences'), 'utf8')).toBe('chromium')
  })

  it('replaces an empty new directory', () => {
    const { legacy, current } = profile()
    mkdirSync(current)
    expect(moveLegacyDirectory(legacy, current)).toBe('moved')
    expect(readFileSync(join(current, 'zen', 'state.json'), 'utf8')).toBe('{"tabs":1}')
  })

  it('leaves a populated new directory alone', () => {
    const { legacy, current } = profile()
    mkdirSync(join(current, 'zen'), { recursive: true })
    writeFileSync(join(current, 'zen', 'state.json'), '{"tabs":2}')
    expect(moveLegacyDirectory(legacy, current)).toBe('current-in-use')
    expect(readFileSync(join(current, 'zen', 'state.json'), 'utf8')).toBe('{"tabs":2}')
    expect(readFileSync(join(legacy, 'zen', 'state.json'), 'utf8')).toBe('{"tabs":1}')
  })

  it('is a no-op the second time', () => {
    const { legacy, current } = profile()
    expect(moveLegacyDirectory(legacy, current)).toBe('moved')
    expect(moveLegacyDirectory(legacy, current)).toBe('no-legacy')
  })
})
