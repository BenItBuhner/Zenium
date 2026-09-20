import { describe, expect, it } from 'vitest'
import {
  chromiumLockPaths,
  chromiumUserDataDirs,
  firefoxLockPaths,
  firefoxRoots,
  joinPath,
  parseLocalState,
  parseProfilesIni,
  safariDir,
  sqliteCompanions
} from '../locations'
import { FILE_SOURCE_IDS, discoverSources, isRunning, passwordLimit } from '../sources'
import { FakeImportHost } from './helpers'

const LOCAL_STATE = JSON.stringify({
  profile: {
    info_cache: {
      Default: { name: 'Person 1', is_using_default_name: false },
      'Profile 2': {
        name: 'Person 2',
        gaia_name: 'Bennett Buhner',
        user_name: 'bennett@example.com',
        is_using_default_name: true
      },
      'Guest Profile': { name: 'Guest' },
      'System Profile': { name: 'System' }
    },
    last_used: 'Profile 2'
  }
})

const PROFILES_INI = `[Install4F96D1932A9F858E]
Default=abcd1234.default-release
Locked=1

[Profile1]
Name=default
IsRelative=1
Path=wxyz5678.default
Default=1

[Profile0]
Name=default-release
IsRelative=1
Path=abcd1234.default-release

[Profile2]
Name=Work
IsRelative=0
Path=/data/firefox/work

[General]
StartWithLastProfile=1
Version=2
`

const OPTIONS = { os: 'linux' as const, historyWritable: true, passwordsAvailable: true }

describe('profile locations', () => {
  it('knows the User Data directories per OS, sandboxed packagings included', () => {
    const linux = { os: 'linux' as const, homeDir: '/home/b', env: {} }
    expect(chromiumUserDataDirs('chrome', linux)).toEqual([
      '/home/b/.config/google-chrome',
      '/home/b/.var/app/com.google.Chrome/config/google-chrome'
    ])
    expect(chromiumUserDataDirs('chromium', linux)).toContain(
      '/home/b/snap/chromium/common/chromium'
    )
    expect(chromiumUserDataDirs('edge', { ...linux, env: { XDG_CONFIG_HOME: '/cfg' } })[0]).toBe(
      '/cfg/microsoft-edge'
    )
    const mac = { os: 'darwin' as const, homeDir: '/Users/b', env: {} }
    expect(chromiumUserDataDirs('chrome', mac)).toEqual([
      '/Users/b/Library/Application Support/Google/Chrome'
    ])
    expect(chromiumUserDataDirs('edge', mac)).toEqual([
      '/Users/b/Library/Application Support/Microsoft Edge'
    ])
    const win = {
      os: 'win32' as const,
      homeDir: 'C:/Users/b',
      env: {
        LOCALAPPDATA: 'C:\\Users\\b\\AppData\\Local',
        APPDATA: 'C:\\Users\\b\\AppData\\Roaming'
      }
    }
    expect(chromiumUserDataDirs('chrome', win)).toEqual([
      'C:\\Users\\b\\AppData\\Local/Google/Chrome/User Data'
    ])
    expect(chromiumUserDataDirs('edge', win)).toEqual([
      'C:\\Users\\b\\AppData\\Local/Microsoft/Edge/User Data'
    ])
    expect(firefoxRoots(win)).toEqual(['C:\\Users\\b\\AppData\\Roaming/Mozilla/Firefox'])
    expect(firefoxRoots(linux)[0]).toBe('/home/b/.mozilla/firefox')
    expect(firefoxRoots(mac)).toEqual(['/Users/b/Library/Application Support/Firefox'])
    expect(safariDir(mac)).toBe('/Users/b/Library/Safari')
    expect(safariDir(linux)).toBeNull()
    expect(chromiumUserDataDirs('chrome', { ...linux, os: 'android' })).toEqual([])
  })

  it('names the lock markers Chrome and Firefox leave while running', () => {
    expect(chromiumLockPaths('/ud', 'linux')).toEqual([
      '/ud/SingletonLock',
      '/ud/SingletonSocket',
      '/ud/SingletonCookie'
    ])
    expect(chromiumLockPaths('/ud', 'win32')).toEqual(['/ud/lockfile'])
    expect(firefoxLockPaths('/p', 'darwin')).toEqual(['/p/lock', '/p/.parentlock'])
    expect(firefoxLockPaths('/p', 'win32')).toEqual(['/p/parent.lock'])
    expect(sqliteCompanions('/p/History')).toEqual([
      '/p/History',
      '/p/History-wal',
      '/p/History-shm',
      '/p/History-journal'
    ])
    expect(joinPath('/a/', '/b', 'c/')).toBe('/a/b/c')
  })

  it("reads Chrome's Local State: last used first, account names, no guest or system profile", () => {
    const { profiles, lastUsed } = parseLocalState(LOCAL_STATE)
    expect(lastUsed).toBe('Profile 2')
    expect(profiles).toEqual([
      { dir: 'Profile 2', name: 'Bennett Buhner', email: 'bennett@example.com' },
      { dir: 'Default', name: 'Person 1' }
    ])
    expect(parseLocalState('not json').profiles).toEqual([])
    expect(parseLocalState('{}').profiles).toEqual([])
  })

  it("reads Firefox's profiles.ini: install default first, relative paths resolved", () => {
    const profiles = parseProfilesIni(PROFILES_INI, '/home/b/.mozilla/firefox')
    expect(profiles.map((p) => [p.name, p.path, p.isDefault])).toEqual([
      ['default', '/home/b/.mozilla/firefox/wxyz5678.default', true],
      ['default-release', '/home/b/.mozilla/firefox/abcd1234.default-release', true],
      ['Work', '/data/firefox/work', false]
    ])
  })
})

describe('discoverSources', () => {
  function chromeMachine(): FakeImportHost {
    const host = new FakeImportHost('/home/b')
    const ud = '/home/b/.config/google-chrome'
    host.file(`${ud}/Local State`, LOCAL_STATE)
    host.file(`${ud}/Default/Bookmarks`, '{"roots":{}}')
    host.file(`${ud}/Default/History`, 'sqlite')
    host.file(`${ud}/Default/Login Data`, 'sqlite')
    host.file(`${ud}/Profile 2/Bookmarks`, '{"roots":{}}')
    host.dir(`${ud}/Guest Profile`)
    return host
  }

  it('lists Chrome profiles with what each holds, then the file sources', async () => {
    const host = chromeMachine()
    const sources = await discoverSources(host, OPTIONS)
    expect(sources.map((s) => s.id)).toEqual([
      'chrome:/home/b/.config/google-chrome/Profile 2',
      'chrome:/home/b/.config/google-chrome/Default',
      FILE_SOURCE_IDS.bookmarks,
      FILE_SOURCE_IDS.passwords
    ])
    const [second, first] = sources
    expect(first).toMatchObject({
      browser: 'chrome',
      browserName: 'Google Chrome',
      profileId: 'Default',
      name: 'Person 1',
      running: false,
      kinds: ['bookmarks', 'history', 'passwords'],
      limits: {}
    })
    expect(second).toMatchObject({
      name: 'Bennett Buhner',
      email: 'bennett@example.com',
      kinds: ['bookmarks']
    })
    expect(sources[2]).toMatchObject({ browser: 'file', kinds: ['bookmarks'], running: false })
    expect(sources[3]).toMatchObject({ browser: 'file', kinds: ['passwords'] })
  })

  it('sees Chrome running from its SingletonLock symlink and still offers the profile', async () => {
    const host = chromeMachine()
    host.symlink('/home/b/.config/google-chrome/SingletonLock')
    const sources = await discoverSources(host, OPTIONS)
    expect(sources.filter((s) => s.browser === 'chrome').every((s) => s.running)).toBe(true)
    expect(sources[0].kinds).toContain('bookmarks')
    host.remove('/home/b/.config/google-chrome/SingletonLock')
    expect((await discoverSources(host, OPTIONS))[0].running).toBe(false)
  })

  it('treats any of the markers as the lock (socket, cookie, lockfile on Windows)', async () => {
    const host = new FakeImportHost()
    host.file('/ud/SingletonCookie', '1234')
    expect(await isRunning(host, chromiumLockPaths('/ud', 'linux'))).toBe(true)
    expect(await isRunning(host, chromiumLockPaths('/ud', 'win32'))).toBe(false)
    host.file('/ud/lockfile', '')
    expect(await isRunning(host, chromiumLockPaths('/ud', 'win32'))).toBe(true)
  })

  it('falls back to Default / Profile N directories when Local State is missing', async () => {
    const host = new FakeImportHost('/home/b')
    const ud = '/home/b/.config/chromium'
    host.file(`${ud}/Default/Bookmarks`, '{}')
    host.file(`${ud}/Profile 7/Bookmarks`, '{}')
    host.file(`${ud}/Crashpad/settings.dat`, '')
    const sources = await discoverSources(host, OPTIONS)
    expect(sources.filter((s) => s.browser === 'chromium').map((s) => s.name)).toEqual([
      'Default',
      'Profile 7'
    ])
    expect(sources[0].browserName).toBe('Chromium')
  })

  it('withholds history until the history model can take imported visits', async () => {
    const host = chromeMachine()
    const sources = await discoverSources(host, { ...OPTIONS, historyWritable: false })
    expect(sources[1].kinds).toEqual(['bookmarks', 'passwords'])
  })

  it('records the Windows DPAPI limit instead of offering Chrome passwords there', async () => {
    const host = new FakeImportHost('C:/Users/b', { LOCALAPPDATA: 'C:/Users/b/AppData/Local' })
    const profile = 'C:/Users/b/AppData/Local/Google/Chrome/User Data/Default'
    host.file(`${profile}/Bookmarks`, '{}')
    host.file(`${profile}/Login Data`, 'sqlite')
    const sources = await discoverSources(host, { ...OPTIONS, os: 'win32' })
    expect(sources[0].kinds).toEqual(['bookmarks'])
    expect(sources[0].limits.passwords).toBe(passwordLimit('chrome', 'win32'))
    expect(sources[0].limits.passwords).toContain('Export passwords')
    expect(sources[0].limits.passwords).toContain('Windows account')
  })

  it('lists Firefox profiles from profiles.ini with the lock and the CSV route for passwords', async () => {
    const host = new FakeImportHost('/home/b')
    const root = '/home/b/.mozilla/firefox'
    host.file(`${root}/profiles.ini`, PROFILES_INI)
    host.file(`${root}/abcd1234.default-release/places.sqlite`, 'sqlite')
    host.symlink(`${root}/abcd1234.default-release/lock`)
    host.file(`${root}/wxyz5678.default/bookmarkbackups/bookmarks-2024-05-01_12_abc.jsonlz4`, 'x')
    host.dir('/data/firefox/work')
    const sources = await discoverSources(host, OPTIONS)
    const firefox = sources.filter((s) => s.browser === 'firefox')
    expect(firefox.map((s) => [s.name, s.running, s.kinds])).toEqual([
      ['default', false, ['bookmarks']],
      ['default-release', true, ['bookmarks', 'history']]
    ])
    expect(firefox[0].browserName).toBe('Firefox')
    expect(firefox[0].profileId).toBe('wxyz5678.default')
    expect(firefox[0].limits.passwords).toContain('Export passwords')
  })

  it('offers Safari on macOS only, bookmarks kept on offer when the directory is unreadable', async () => {
    const host = new FakeImportHost('/Users/b')
    host.file('/Users/b/Library/Safari/Bookmarks.plist', 'bplist')
    host.file('/Users/b/Library/Safari/History.db', 'sqlite')
    const mac = await discoverSources(host, { ...OPTIONS, os: 'darwin' })
    expect(mac[0]).toMatchObject({
      browser: 'safari',
      name: 'Safari',
      kinds: ['bookmarks', 'history'],
      running: false
    })
    expect(mac[0].limits.passwords).toContain('Keychain')
    expect((await discoverSources(host, OPTIONS)).every((s) => s.browser !== 'safari')).toBe(true)
    // Without Full Disk Access the directory exists and lists empty.
    const hidden = new FakeImportHost('/Users/b')
    hidden.dir('/Users/b/Library/Safari')
    const sources = await discoverSources(hidden, { ...OPTIONS, os: 'darwin' })
    expect(sources[0]).toMatchObject({ browser: 'safari', kinds: ['bookmarks', 'history'] })
  })

  it('offers only files without a host, and no passwords file without a vault', async () => {
    expect((await discoverSources(undefined, OPTIONS)).map((s) => s.id)).toEqual([
      FILE_SOURCE_IDS.bookmarks,
      FILE_SOURCE_IDS.passwords
    ])
    expect(
      (await discoverSources(undefined, { ...OPTIONS, passwordsAvailable: false })).map((s) => s.id)
    ).toEqual([FILE_SOURCE_IDS.bookmarks])
  })
})
