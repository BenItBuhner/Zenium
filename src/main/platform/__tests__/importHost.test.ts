import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ElectronImportHost } from '../importHost'

const roots: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zenium-import-host-test-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A Firefox-shaped WAL database held open by its writer, the way a running browser holds its
 * own: the row lives in the -wal file until a checkpoint, so a copy without it would miss it.
 */
function writeWalDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA wal_autocheckpoint=0')
  db.exec('CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, stamp INTEGER)')
  db.prepare('INSERT INTO moz_places(id, url, stamp) VALUES (?, ?, ?)').run(
    1,
    'https://www.mozilla.org/',
    13350000000000000n
  )
  return db
}

describe('ElectronImportHost', () => {
  it("stats without following symlinks, so Chrome's dangling SingletonLock shows as one", async () => {
    const root = scratch()
    const host = new ElectronImportHost({ tempRoot: root })
    mkdirSync(join(root, 'Default'))
    writeFileSync(join(root, 'Default', 'Bookmarks'), '{}')
    symlinkSync('host-12345', join(root, 'SingletonLock'))
    expect(await host.stat(join(root, 'Default'))).toBe('dir')
    expect(await host.stat(join(root, 'Default', 'Bookmarks'))).toBe('file')
    expect(await host.stat(join(root, 'SingletonLock'))).toBe('symlink')
    expect(await host.stat(join(root, 'nothing'))).toBe('missing')
    expect(await host.list(root)).toEqual(['Default', 'SingletonLock'])
    expect(await host.list(join(root, 'nothing'))).toEqual([])
    expect(await host.readText(join(root, 'Default', 'Bookmarks'))).toBe('{}')
    expect(Array.from(await host.readBytes(join(root, 'Default', 'Bookmarks')))).toEqual([
      0x7b, 0x7d
    ])
  })

  it('copies a database with the companions that exist into a fresh temp dir and opens the copy read-only', async () => {
    const root = scratch()
    const temp = scratch()
    const host = new ElectronImportHost({ tempRoot: temp })
    const places = join(root, 'places.sqlite')
    const writer = writeWalDatabase(places)
    expect(existsSync(`${places}-wal`)).toBe(true)
    const copy = await host.copyToTemp([
      places,
      `${places}-wal`,
      `${places}-shm`,
      `${places}-journal`
    ])
    expect(copy.dir.startsWith(join(temp, 'zenium-import-'))).toBe(true)
    expect(copy.copies[0]).toBe(join(copy.dir, 'places.sqlite'))
    expect(copy.copies[1]).toBe(join(copy.dir, 'places.sqlite-wal'))
    expect(copy.copies[3]).toBeNull()
    const db = await host.openSqlite(copy.copies[0]!)
    const rows = db.all('SELECT url, stamp FROM moz_places')
    db.close()
    expect(rows).toEqual([{ url: 'https://www.mozilla.org/', stamp: 13350000000000000n }])
    await host.removeTemp(copy.dir)
    expect(existsSync(copy.dir)).toBe(false)
    // The original is untouched and its -wal still there.
    expect(existsSync(`${places}-wal`)).toBe(true)
    writer.close()
  })

  it('leaves no temp dir behind when a copy fails for a reason other than a missing file', async () => {
    const root = scratch()
    const temp = scratch()
    const host = new ElectronImportHost({ tempRoot: temp })
    // Copying a directory as a file fails (EISDIR); a missing companion does not.
    mkdirSync(join(root, 'History'))
    await expect(
      host.copyToTemp([join(root, 'History'), join(root, 'History-wal')])
    ).rejects.toMatchObject({ code: expect.stringMatching(/EISDIR|EPERM|EACCES/) })
    expect(readdirSync(temp)).toEqual([])
  })

  it('only removes directories it created itself', async () => {
    const temp = scratch()
    const other = scratch()
    const host = new ElectronImportHost({ tempRoot: temp })
    writeFileSync(join(other, 'keep'), 'x')
    await host.removeTemp(other)
    await host.removeTemp(join(temp, 'not-ours'))
    expect(existsSync(join(other, 'keep'))).toBe(true)
  })

  it("asks libsecret on Linux and the Keychain on macOS for Chrome's Safe Storage secret, nothing on Windows", async () => {
    const calls: string[][] = []
    const exec = async (command: string, args: string[]): Promise<string | null> => {
      calls.push([command, ...args])
      if (command === 'secret-tool' && args.join(' ') === 'lookup application microsoft-edge')
        return 'edge-secret'
      if (command === 'secret-tool' && args.join(' ') === 'lookup application chrome') return null
      if (command === 'security') return 'mac-secret'
      return null
    }
    const linux = new ElectronImportHost({ os: 'linux', exec })
    expect(await linux.safeStorageSecret('edge')).toBe('edge-secret')
    expect(await linux.safeStorageSecret('chrome')).toBeNull()
    expect(calls).toEqual([
      ['secret-tool', 'lookup', 'application', 'microsoft-edge'],
      ['secret-tool', 'lookup', 'application', 'chrome']
    ])
    calls.length = 0
    const mac = new ElectronImportHost({ os: 'darwin', exec })
    expect(await mac.safeStorageSecret('chrome')).toBe('mac-secret')
    expect(calls).toEqual([
      ['security', 'find-generic-password', '-w', '-a', 'Chrome', '-s', 'Chrome Safe Storage']
    ])
    calls.length = 0
    const windows = new ElectronImportHost({ os: 'win32', exec })
    expect(await windows.safeStorageSecret('chrome')).toBeNull()
    expect(calls).toEqual([])
  })

  it('takes the home directory and environment it is given', () => {
    const host = new ElectronImportHost({ homeDir: '/home/x', env: { XDG_CONFIG_HOME: '/cfg' } })
    expect(host.homeDir).toBe('/home/x')
    expect(host.env.XDG_CONFIG_HOME).toBe('/cfg')
  })
})
