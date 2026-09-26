import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STATE_BACKUP_FILE,
  STATE_FILE,
  fromRenameWindow,
  parseStateDocument,
  readProfileState,
  requireStateFile,
  stateAfterKill,
  stateSource
} from './profile-state.mjs'

/** A run's write: the marker false, one tab. */
const running = {
  version: 6,
  windows: [{ id: 1 }],
  tabs: [{ url: 'http://127.0.0.1:1/first.html', title: 'first', id: 't1' }],
  settings: { onboardingDone: true },
  cleanExit: false
}
/** The write a graceful quit ends with: the marker true, two tabs. */
const quit = {
  ...running,
  tabs: [...running.tabs, { url: 'http://127.0.0.1:1/second.html' }],
  cleanExit: true
}

const dirs = []
function zenDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenium-smoke-profile-state-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof text === 'string' ? text : JSON.stringify(text))
  }
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('readProfileState', () => {
  it('reads state.json when it is there, and says so', () => {
    const dir = zenDir({ [STATE_FILE]: running, [STATE_BACKUP_FILE]: quit })
    expect(readProfileState(dir)).toEqual({
      file: STATE_FILE,
      version: 6,
      windows: 1,
      tabs: [{ url: 'http://127.0.0.1:1/first.html', title: 'first' }],
      onboardingDone: true,
      cleanExit: false
    })
  })

  it('falls back to state.json.bak when state.json is missing – the store’s rename window – naming the backup', () => {
    // A kill between the store's two renames: no document, the version before the last in the
    // backup, the new version still under its temp name.
    const dir = zenDir({
      [STATE_BACKUP_FILE]: running,
      [`${STATE_FILE}.4242.7.tmp`]: quit
    })
    const state = readProfileState(dir)
    expect(state).toEqual({
      file: STATE_BACKUP_FILE,
      primary: 'missing',
      version: 6,
      windows: 1,
      tabs: [{ url: 'http://127.0.0.1:1/first.html', title: 'first' }],
      onboardingDone: true,
      cleanExit: false
    })
    expect(fromRenameWindow(state)).toBe(true)
    expect(stateSource(state)).toBe('state.json.bak (state.json missing)')
  })

  it('fails naming both files when neither is there', () => {
    const dir = zenDir({})
    const state = readProfileState(dir)
    expect(state).toEqual({ error: expect.any(String) })
    expect(state.error).toContain(path.join(dir, STATE_FILE))
    expect(state.error).toContain(path.join(dir, STATE_BACKUP_FILE))
    expect(state.error).toMatch(/state\.json missing; .*state\.json\.bak missing/)
    expect(fromRenameWindow(state)).toBe(false)
    expect(stateSource(state)).toMatch(
      /^neither \(neither state\.json nor state\.json\.bak is readable/
    )
  })

  it('takes the backup for an empty or corrupt state.json as the core does, and says why', () => {
    const empty = readProfileState(zenDir({ [STATE_FILE]: '', [STATE_BACKUP_FILE]: quit }))
    expect(empty.file).toBe(STATE_BACKUP_FILE)
    expect(empty.primary).toBe('empty')
    expect(empty.cleanExit).toBe(true)
    expect(fromRenameWindow(empty)).toBe(false)

    const corrupt = readProfileState(zenDir({ [STATE_FILE]: '{"v":', [STATE_BACKUP_FILE]: quit }))
    expect(corrupt.file).toBe(STATE_BACKUP_FILE)
    expect(corrupt.primary).toMatch(/^corrupt \(/)
    expect(corrupt.tabs).toHaveLength(2)
    expect(stateSource(corrupt)).toMatch(/^state\.json\.bak \(state\.json corrupt \(/)

    const nul = readProfileState(zenDir({ [STATE_FILE]: 'null', [STATE_BACKUP_FILE]: quit }))
    expect(nul.file).toBe(STATE_BACKUP_FILE)
    expect(nul.primary).toBe('corrupt (the document is null)')
  })

  it('names what was wrong with each file when both are unreadable', () => {
    const state = readProfileState(zenDir({ [STATE_FILE]: '', [STATE_BACKUP_FILE]: '{' }))
    expect(state.error).toMatch(/state\.json empty; .*state\.json\.bak corrupt \(/)
  })

  it('reads through the reader it is given and reports a read that throws', () => {
    const seen = []
    const read = (file) => {
      seen.push(path.basename(file))
      if (file.endsWith(STATE_FILE))
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return JSON.stringify(quit)
    }
    const state = readProfileState('/profile/zen', read)
    expect(seen).toEqual([STATE_FILE, STATE_BACKUP_FILE])
    expect(state.file).toBe(STATE_BACKUP_FILE)
    expect(state.primary).toBe('unreadable (EACCES: permission denied)')
    expect(state.cleanExit).toBe(true)
  })

  it('summarises a document without windows, tabs or settings without failing', () => {
    const dir = zenDir({ [STATE_FILE]: { version: 2, settings: {} } })
    expect(readProfileState(dir)).toEqual({
      file: STATE_FILE,
      version: 2,
      windows: 0,
      tabs: [],
      onboardingDone: undefined,
      cleanExit: undefined
    })
  })
})

describe('parseStateDocument', () => {
  it('follows JsonStore.parse: a document, else missing, empty, corrupt or unreadable', () => {
    const texts = { '/a': '{"x":1}', '/empty': '', '/bad': '{', '/null': 'null' }
    const read = (file) => (file in texts ? texts[file] : null)
    expect(parseStateDocument('/a', read)).toEqual({ ok: true, doc: { x: 1 } })
    expect(parseStateDocument('/none', read)).toEqual({ ok: false, reason: 'missing' })
    expect(parseStateDocument('/empty', read)).toEqual({ ok: false, reason: 'empty' })
    expect(parseStateDocument('/bad', read).reason).toMatch(/^corrupt \(/)
    expect(parseStateDocument('/null', read).reason).toBe('corrupt (the document is null)')
    expect(
      parseStateDocument('/x', () => {
        throw new Error('EIO')
      })
    ).toEqual({ ok: false, reason: 'unreadable (EIO)' })
  })
})

describe('stateAfterKill', () => {
  const fromDocument = { file: STATE_FILE, cleanExit: false, tabs: [{}] }
  const fromWindow = { file: STATE_BACKUP_FILE, primary: 'missing', cleanExit: false, tabs: [{}] }

  it('takes state.json, and the backup from the rename window, as the next launch does', () => {
    expect(stateAfterKill(fromDocument)).toBe(fromDocument)
    expect(stateAfterKill(fromWindow)).toBe(fromWindow)
  })

  it('refuses a backup standing in for a state.json that is there but unreadable, naming both', () => {
    const corrupt = {
      file: STATE_BACKUP_FILE,
      primary: 'corrupt (x)',
      cleanExit: false,
      tabs: [{}, {}]
    }
    expect(() => stateAfterKill(corrupt)).toThrow(
      /^state\.json corrupt \(x\) after the kill \(the store's rename leaves a whole document or none\); state\.json\.bak holds cleanExit false with 2 tab\(s\)$/
    )
    expect(() => stateAfterKill({ ...corrupt, primary: 'empty' }, 'before the launch')).toThrow(
      /^state\.json empty before the launch/
    )
  })

  it('refuses no state at all, with both files named', () => {
    const none = readProfileState('/nowhere/zen', () => null)
    expect(() => stateAfterKill(none)).toThrow(
      /^no readable state after the kill: neither state\.json nor state\.json\.bak is readable: .*state\.json missing; .*state\.json\.bak missing$/
    )
    expect(() => stateAfterKill(undefined)).toThrow(/no state read/)
  })
})

describe('requireStateFile', () => {
  it('passes state.json through', () => {
    const state = { file: STATE_FILE, cleanExit: true, tabs: [] }
    expect(requireStateFile(state)).toBe(state)
  })

  it('refuses the backup after a graceful quit, saying what it holds', () => {
    const state = { file: STATE_BACKUP_FILE, primary: 'missing', cleanExit: true, tabs: [{}] }
    expect(() => requireStateFile(state)).toThrow(
      /^state\.json missing after the quit; state\.json\.bak holds the write before the last \(cleanExit true, 1 tab\(s\)\): the run's last write never landed$/
    )
    expect(() => requireStateFile(state, 'before the launch')).toThrow(/missing before the launch;/)
  })

  it('refuses no state at all', () => {
    expect(() =>
      requireStateFile({ error: 'neither state.json nor state.json.bak is readable: …' })
    ).toThrow(/^no readable state after the quit: neither state\.json nor state\.json\.bak/)
  })
})

describe('stateSource', () => {
  it('names the file that answered', () => {
    expect(stateSource({ file: STATE_FILE })).toBe('state.json')
    expect(stateSource({ file: STATE_BACKUP_FILE, primary: 'missing' })).toBe(
      'state.json.bak (state.json missing)'
    )
    expect(stateSource({ error: 'x' })).toBe('neither (x)')
    expect(stateSource(undefined)).toBe('neither (no state read)')
  })
})
