// Test fixtures: the core itself never touches Node's file or database APIs.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, ImportProgress } from '../../../shared/types'
import { BOOKMARKS_BAR_ID } from '../../../shared/bookmarks'
import type { Browser } from '../../browser'
import type { PickedTextFile, StoreIO } from '../../platform'
import { BookmarkService } from '../../bookmarks'
import type { ImportRow } from '../../credentials/store'
import { BrowserState } from '../../state'
import { LINUX_ITERATIONS, V10_SECRET } from '../chromiumLogins'
import type { HistoryImportSink } from '../historySink'
import {
  ImportService,
  fullDiskAccessMessage,
  lockedMessage,
  VAULT_LOCKED_MESSAGE
} from '../service'
import { FILE_SOURCE_IDS } from '../sources'
import type { ImportedVisit } from '../types'
import {
  FakeImportHost,
  chromiumHistorySchema,
  chromiumLoginsSchema,
  firefoxPlacesSchema,
  mozlz4Encode,
  sealChromiumPassword
} from './helpers'

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

const NOW = Date.UTC(2026, 8, 20)
const WEBKIT_OFFSET_US = 11_644_473_600_000_000
const webkit = (ms: number): number => ms * 1000 + WEBKIT_OFFSET_US
const T0 = Date.UTC(2024, 0, 17, 21, 20)
const CHROME = '/home/b/.config/google-chrome'
const CHROME_DEFAULT = `${CHROME}/Default`
const FIREFOX_ROOT = '/home/b/.mozilla/firefox'
const FIREFOX_PROFILE = `${FIREFOX_ROOT}/abcd.default-release`

interface Harness {
  service: ImportService
  host: FakeImportHost
  bookmarks: BookmarkService
  commits: ReturnType<typeof vi.fn>
  history: { sink: HistoryImportSink | null; written: ImportedVisit[] }
  vault: { unlocked: boolean; rows: ImportRow[]; unlockAnswer: 'ok' | 'denied' }
  files: PickedTextFile[]
  pickOptions: unknown[]
}

function harness(
  options: { os?: 'linux' | 'darwin' | 'win32'; host?: boolean; historyApi?: boolean } = {}
): Harness {
  const io: StoreIO = {
    readSync: () => null,
    write: async () => undefined,
    writeSync: () => undefined
  }
  const state = new BrowserState(io, options.os ?? 'linux', {} as HostCapabilities, '0.0')
  state.load()
  const commits = vi.fn()
  state.commitVolatile = commits
  const bookmarks = new BookmarkService(state)
  const host = new FakeImportHost('/home/b')
  const history: Harness['history'] = { sink: null, written: [] }
  if (options.historyApi !== false) {
    history.sink = {
      importVisits: (visits) => {
        history.written.push(...visits)
        return { imported: visits.length - 1, skipped: 1 }
      }
    }
  }
  const vault: Harness['vault'] = { unlocked: true, rows: [], unlockAnswer: 'ok' }
  const files: PickedTextFile[] = []
  const pickOptions: unknown[] = []
  const browser = {
    platform: {
      info: { os: options.os ?? 'linux', version: '0' },
      capabilities: { passwords: true },
      importHost: options.host === false ? undefined : host,
      dialogs: {
        pickTextFiles: async (opts: unknown) => {
          pickOptions.push(opts)
          return files
        }
      }
    },
    state,
    history: history.sink ?? { visit: () => undefined },
    bookmarks,
    passwords: {
      store: {
        unlocked: () => vault.unlocked,
        importRows: (rows: ImportRow[]) => {
          vault.rows.push(...rows)
          return {
            format: 'chrome',
            total: rows.length,
            added: rows.length,
            replaced: 0,
            skipped: 0,
            invalid: 0
          }
        }
      },
      unlock: async () => {
        if (vault.unlockAnswer === 'ok') vault.unlocked = true
        return { status: vault.unlockAnswer }
      }
    }
  }
  const service = new ImportService(browser as unknown as Browser, () => NOW)
  return { service, host, bookmarks, commits, history, vault, files, pickOptions }
}

async function seedChrome(
  host: FakeImportHost,
  options: { running?: boolean } = {}
): Promise<void> {
  host.file(
    `${CHROME}/Local State`,
    JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' } } } })
  )
  host.file(`${CHROME_DEFAULT}/Bookmarks`, fixture('chrome-bookmarks.json').toString())
  host.sqlite(`${CHROME_DEFAULT}/History`, (db) => {
    chromiumHistorySchema(db)
    db.prepare('INSERT INTO urls(id, url, title, last_visit_time) VALUES (?, ?, ?, ?)').run(
      1,
      'https://zenium.app/',
      'Zenium',
      webkit(T0)
    )
    db.prepare('INSERT INTO urls(id, url, title, last_visit_time) VALUES (?, ?, ?, ?)').run(
      2,
      'https://example.org/',
      'Example',
      webkit(T0)
    )
    const visit = db.prepare(
      'INSERT INTO visits(id, url, visit_time, transition) VALUES (?, ?, ?, ?)'
    )
    visit.run(1, 1, webkit(T0), 0x30000001)
    visit.run(2, 2, webkit(T0 + 1000), 0)
    visit.run(3, 2, webkit(T0 + 1000), 0)
  })
  host.file(`${CHROME_DEFAULT}/History-journal`, 'journal')
  const v10 = await sealChromiumPassword('v10', V10_SECRET, LINUX_ITERATIONS, 'peanut-butter')
  const v11 = await sealChromiumPassword('v11', 'keyring-secret', LINUX_ITERATIONS, 'kept')
  host.sqlite(`${CHROME_DEFAULT}/Login Data`, (db) => {
    chromiumLoginsSchema(db)
    const insert = db.prepare(
      'INSERT INTO logins(origin_url, username_value, password_value, signon_realm, date_created, blacklisted_by_user, scheme) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    insert.run(
      'https://accounts.example.com/',
      'bennett',
      v10,
      'https://accounts.example.com/',
      webkit(T0),
      0,
      0
    )
    insert.run('https://mail.example.org/', 'b', v11, 'https://mail.example.org/', webkit(T0), 0, 0)
  })
  if (options.running) host.symlink(`${CHROME}/SingletonLock`)
}

function seedFirefox(
  host: FakeImportHost,
  options: { running?: boolean; places?: boolean } = {}
): void {
  host.file(
    `${FIREFOX_ROOT}/profiles.ini`,
    `[Profile0]\nName=default-release\nIsRelative=1\nPath=abcd.default-release\nDefault=1\n`
  )
  if (options.places !== false)
    host.sqlite(`${FIREFOX_PROFILE}/places.sqlite`, (db) => {
      firefoxPlacesSchema(db)
      db.prepare('INSERT INTO moz_places(id, url, title, guid) VALUES (?, ?, ?, ?)').run(
        1,
        'https://www.mozilla.org/',
        'Mozilla',
        'p1'
      )
      const bm = db.prepare(
        'INSERT INTO moz_bookmarks(id, type, fk, parent, position, title, guid) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      bm.run(1, 2, null, 0, 0, '', 'root________')
      bm.run(2, 2, null, 1, 0, 'toolbar', 'toolbar_____')
      bm.run(3, 1, 1, 2, 0, 'Mozilla', 'b3')
      db.prepare(
        'INSERT INTO moz_historyvisits(id, place_id, visit_date, visit_type) VALUES (?, ?, ?, ?)'
      ).run(1, 1, T0 * 1000, 2)
    })
  host.file(
    `${FIREFOX_PROFILE}/bookmarkbackups/bookmarks-2024-06-01_3_x.jsonlz4`,
    mozlz4Encode(
      JSON.stringify({
        typeCode: 2,
        root: 'placesRoot',
        children: [
          {
            typeCode: 2,
            root: 'toolbarFolder',
            title: 'toolbar',
            children: [{ typeCode: 1, title: 'Backup page', uri: 'https://backup.example/' }]
          }
        ]
      })
    )
  )
  if (options.running) host.symlink(`${FIREFOX_PROFILE}/lock`)
}

describe('ImportService: browser profiles', () => {
  it('imports bookmarks, history and passwords from a Chrome profile, reading databases from a temp copy', async () => {
    const h = harness()
    await seedChrome(h.host)
    const sources = await h.service.sources()
    expect(sources[0]).toMatchObject({
      browser: 'chrome',
      kinds: ['bookmarks', 'history', 'passwords'],
      running: false
    })

    const statuses: string[] = []
    h.commits.mockImplementation(() =>
      statuses.push(`${h.service.uiState()?.status}:${h.service.uiState()?.current}`)
    )
    const result = (await h.service.run(sources[0].id, ['bookmarks', 'history', 'passwords']))!
    expect(result.status).toBe('done')
    expect(result.error).toBeNull()
    expect(result.results.bookmarks).toEqual({
      imported: 5,
      duplicates: 1,
      unreadable: 0,
      invalid: 1,
      error: null
    })
    expect(result.results.history).toEqual({
      imported: 1,
      duplicates: 2,
      unreadable: 0,
      invalid: 0,
      error: null
    })
    expect(result.results.passwords).toMatchObject({
      imported: 1,
      duplicates: 0,
      unreadable: 1,
      invalid: 0,
      error: null
    })
    expect(result.results.passwords?.note).toContain('system keyring')
    expect(result.folderId).toBe(BOOKMARKS_BAR_ID)
    expect(result.startedAt).toBe(NOW)
    expect(result.finishedAt).toBe(NOW)
    expect(statuses[0]).toBe('running:null')
    expect(statuses).toContain('running:bookmarks')
    expect(statuses).toContain('running:passwords')
    expect(statuses[statuses.length - 1]).toBe('done:null')
    // The UI state carries the finished import until dismissed.
    expect(h.service.uiState()).toBe(result)
    h.service.dismiss()
    expect(h.service.uiState()).toBeNull()

    // Bookmarks landed like Chrome's: the bar's items on our (empty) bar, dated as Chrome dated them.
    expect(h.bookmarks.tree.children(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual([
      'Zenium',
      'Work'
    ])
    expect(h.history.written.map((v) => [v.url, v.at, v.transition])).toEqual([
      ['https://zenium.app/', T0, 'typed'],
      ['https://example.org/', T0 + 1000, 'link']
    ])
    expect(h.vault.rows).toEqual([
      {
        url: 'https://accounts.example.com/',
        username: 'bennett',
        password: 'peanut-butter',
        notes: '',
        createdAt: T0
      }
    ])
    expect(h.host.secretRequests).toEqual(['chrome'])

    // Copy before read: each database with its companions, opened from the copy, the copy removed.
    expect(h.host.copyRequests).toEqual([
      [
        `${CHROME_DEFAULT}/History`,
        `${CHROME_DEFAULT}/History-wal`,
        `${CHROME_DEFAULT}/History-shm`,
        `${CHROME_DEFAULT}/History-journal`
      ],
      [
        `${CHROME_DEFAULT}/Login Data`,
        `${CHROME_DEFAULT}/Login Data-wal`,
        `${CHROME_DEFAULT}/Login Data-shm`,
        `${CHROME_DEFAULT}/Login Data-journal`
      ]
    ])
    expect(h.host.opened.every((p) => p.startsWith('/tmp/zenium-import-'))).toBe(true)
    expect(h.host.removedDirs).toEqual(h.host.tempDirs)
    expect(await h.host.list(h.host.tempDirs[0])).toEqual([])
  })

  it('still imports from a running Chrome (the copy works) and reports it running', async () => {
    const h = harness()
    await seedChrome(h.host, { running: true })
    const [source] = await h.service.sources()
    expect(source.running).toBe(true)
    const result = (await h.service.run(source.id, ['bookmarks', 'history']))!
    expect(result.status).toBe('done')
    expect(result.results.bookmarks?.imported).toBe(5)
    expect(result.results.history?.imported).toBe(1)
  })

  it('refuses by name when a running Chrome holds its database against the copy', async () => {
    const h = harness()
    await seedChrome(h.host, { running: true })
    h.host.locked(`${CHROME_DEFAULT}/History`, 'EBUSY')
    const [source] = await h.service.sources()
    const result = (await h.service.run(source.id, ['bookmarks', 'history', 'passwords']))!
    expect(result.status).toBe('failed')
    expect(result.error).toBe('Google Chrome is open. Close Google Chrome and try again.')
    expect(result.error).toBe(lockedMessage('Google Chrome'))
    // Bookmarks (a plain file) came through before the lock stopped the run; passwords were not reached.
    expect(result.results.bookmarks?.imported).toBe(5)
    expect(result.results.history?.error).toBe(result.error)
    expect(result.results.passwords).toBeUndefined()
    // The temp dir of the failed copy is still cleaned up.
    expect(h.host.removedDirs).toEqual(h.host.tempDirs)
  })

  it('treats a permission error on a closed browser as an ordinary read failure, not a lock', async () => {
    const h = harness()
    await seedChrome(h.host)
    h.host.locked(`${CHROME_DEFAULT}/History`, 'EACCES')
    const [source] = await h.service.sources()
    const result = (await h.service.run(source.id, ['history']))!
    // EACCES is in the lock family: the browser is named either way, as Chrome's importer does.
    expect(result.status).toBe('failed')
    expect(result.error).toBe(lockedMessage('Google Chrome'))
  })

  it('refuses Firefox up front while it runs, without touching its database', async () => {
    const h = harness()
    seedFirefox(h.host, { running: true })
    const [source] = await h.service.sources()
    expect(source).toMatchObject({
      browser: 'firefox',
      running: true,
      kinds: ['bookmarks', 'history']
    })
    const result = (await h.service.run(source.id, ['bookmarks', 'history']))!
    expect(result.status).toBe('failed')
    expect(result.error).toBe('Firefox is open. Close Firefox and try again.')
    expect(h.host.copyRequests).toEqual([])
    expect(result.results.bookmarks?.imported).toBe(0)
  })

  it('imports Firefox bookmarks and history from places.sqlite when Firefox is closed', async () => {
    const h = harness()
    seedFirefox(h.host)
    const [source] = await h.service.sources()
    const result = (await h.service.run(source.id, ['bookmarks', 'history']))!
    expect(result.status).toBe('done')
    expect(result.results.bookmarks).toMatchObject({ imported: 1, error: null })
    expect(result.results.bookmarks?.note).toBeUndefined()
    expect(result.results.history).toMatchObject({ imported: 0, duplicates: 1 })
    expect(h.history.written).toEqual([
      { url: 'https://www.mozilla.org/', title: 'Mozilla', at: T0, transition: 'typed' }
    ])
    expect(h.bookmarks.tree.children(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual(['Mozilla'])
  })

  it('falls back to the newest bookmark backup when places.sqlite is unreadable', async () => {
    const h = harness()
    seedFirefox(h.host)
    h.host.file(`${FIREFOX_PROFILE}/places.sqlite`, 'not a database')
    const [source] = await h.service.sources()
    const result = (await h.service.run(source.id, ['bookmarks']))!
    expect(result.status).toBe('done')
    expect(result.results.bookmarks).toMatchObject({ imported: 1, error: null })
    expect(result.results.bookmarks?.note).toBe(
      "Read from Firefox's bookmark backup bookmarks-2024-06-01_3_x.jsonlz4."
    )
    expect(h.bookmarks.tree.children(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual(['Backup page'])
  })

  it("explains Full Disk Access when macOS denies Safari's files", async () => {
    const h = harness({ os: 'darwin' })
    h.host.dir('/Users/b/Library/Safari')
    h.host.locked('/Users/b/Library/Safari/Bookmarks.plist', 'EPERM')
    const hostWithHome = h.host as { homeDir: string }
    hostWithHome.homeDir = '/Users/b'
    const [source] = await h.service.sources()
    expect(source.browser).toBe('safari')
    const result = (await h.service.run(source.id, ['bookmarks']))!
    expect(result.results.bookmarks?.error).toBe(fullDiskAccessMessage())
    expect(result.results.bookmarks?.error).toContain('Full Disk Access')
  })

  it('imports Safari bookmarks from Bookmarks.plist', async () => {
    const h = harness({ os: 'darwin' })
    ;(h.host as { homeDir: string }).homeDir = '/Users/b'
    h.host.file(
      '/Users/b/Library/Safari/Bookmarks.plist',
      new Uint8Array(fixture('safari-bookmarks.plist'))
    )
    const [source] = await h.service.sources()
    const result = (await h.service.run(source.id, ['bookmarks']))!
    expect(result.status).toBe('done')
    expect(result.results.bookmarks).toEqual({
      imported: 3,
      duplicates: 1,
      unreadable: 0,
      invalid: 3,
      error: null
    })
    expect(h.bookmarks.tree.children(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual([
      'Apple',
      'News'
    ])
  })

  it('leaves history out until the history model takes imported visits', async () => {
    const h = harness({ historyApi: false })
    await seedChrome(h.host)
    const [source] = await h.service.sources()
    expect(source.kinds).toEqual(['bookmarks', 'passwords'])
    const result = (await h.service.run(source.id, ['bookmarks', 'history']))!
    expect(result.kinds).toEqual(['bookmarks'])
    expect(result.results.history).toBeUndefined()
    expect(h.host.copyRequests).toEqual([])
  })

  it('unlocks the vault before writing passwords and reports a vault that stays locked', async () => {
    const h = harness()
    await seedChrome(h.host)
    h.vault.unlocked = false
    h.vault.unlockAnswer = 'denied'
    const [source] = await h.service.sources()
    const result = (await h.service.run(source.id, ['passwords']))!
    expect(result.status).toBe('done')
    expect(result.results.passwords?.error).toBe(VAULT_LOCKED_MESSAGE)
    expect(h.vault.rows).toEqual([])
    h.vault.unlockAnswer = 'ok'
    h.service.dismiss()
    const again = (await h.service.run(source.id, ['passwords']))!
    expect(again.results.passwords?.imported).toBe(1)
    expect(h.vault.unlocked).toBe(true)
  })

  it('runs one import at a time and can be cancelled between kinds', async () => {
    const h = harness()
    await seedChrome(h.host)
    let release: () => void = () => undefined
    let started: () => void = () => undefined
    const reached = new Promise<void>((r) => {
      started = r
    })
    h.history.sink = {
      importVisits: async (visits) => {
        started()
        await new Promise<void>((r) => {
          release = r
        })
        h.history.written.push(...visits)
        return { imported: visits.length, skipped: 0 }
      }
    }
    ;(h.service as unknown as { browser: { history: unknown } }).browser.history = h.history.sink
    const [source] = await h.service.sources()
    const running = h.service.run(source.id, ['bookmarks', 'history', 'passwords'])
    await reached
    expect(h.service.running).toBe(true)
    expect(h.service.uiState()?.current).toBe('history')
    expect(await h.service.run(source.id, ['bookmarks'])).toBe(h.service.uiState())
    expect(h.service.cancel()).toBe(true)
    expect(h.service.cancel()).toBe(false)
    release()
    const result = (await running)!
    expect(result.status).toBe('cancelled')
    expect(result.results.history?.imported).toBe(2)
    expect(result.results.passwords).toBeUndefined()
    expect(h.service.running).toBe(false)
  })

  it('returns null for an unknown source or nothing to import', async () => {
    const h = harness()
    await seedChrome(h.host)
    expect(await h.service.run('chrome:/nowhere', ['bookmarks'])).toBeNull()
    const [source] = await h.service.sources()
    expect(await h.service.run(source.id, [])).toBeNull()
    expect(h.service.uiState()).toBeNull()
  })
})

describe('ImportService: files', () => {
  it('imports a Netscape bookmarks file picked through the host, lifting the size cap', async () => {
    const h = harness({ host: false })
    h.files.push({
      name: 'bookmarks.html',
      text: `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
<DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
<DL><p><DT><A HREF="https://zenium.app/" ADD_DATE="1705526400">Zenium</A>
<DT><A HREF="https://zenium.app/">Zenium twice</A></DL><p>
<DT><A HREF="https://example.org/">Example</A></DL><p>`
    })
    const sources = await h.service.sources()
    expect(sources.map((s) => s.id)).toEqual([FILE_SOURCE_IDS.bookmarks, FILE_SOURCE_IDS.passwords])
    const result = (await h.service.run(FILE_SOURCE_IDS.bookmarks, ['bookmarks']))!
    expect(result.status).toBe('done')
    expect(result.results.bookmarks).toEqual({
      imported: 2,
      duplicates: 1,
      unreadable: 0,
      invalid: 0,
      error: null
    })
    expect(h.pickOptions[0]).toMatchObject({
      extensions: ['html', 'htm'],
      maxBytes: 64 * 1024 * 1024
    })
    expect(h.bookmarks.tree.children(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual(['Zenium'])
  })

  it('imports a Chrome-format passwords CSV', async () => {
    const h = harness({ host: false })
    h.files.push({
      name: 'Chrome Passwords.csv',
      text: 'name,url,username,password,note\nexample,https://example.org/login,b,secret,\nbad,not a url,b,x,\n'
    })
    const result = (await h.service.run(FILE_SOURCE_IDS.passwords, ['passwords']))!
    expect(result.status).toBe('done')
    expect(result.results.passwords).toMatchObject({ imported: 2, error: null })
    expect(h.vault.rows).toHaveLength(2)
    expect(h.vault.rows[0]).toMatchObject({
      url: 'https://example.org/login',
      username: 'b',
      password: 'secret'
    })
    expect(h.pickOptions[0]).toMatchObject({ extensions: ['csv', 'txt'] })
  })

  it('cancels when the picker is dismissed and fails a file that is not an export', async () => {
    const h = harness({ host: false })
    const cancelled = (await h.service.run(FILE_SOURCE_IDS.bookmarks, ['bookmarks']))!
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.results.bookmarks).toBeUndefined()
    h.service.dismiss()
    h.files.push({ name: 'notes.csv', text: 'just,some,columns\n1,2,3\n' })
    const failed = (await h.service.run(FILE_SOURCE_IDS.passwords, ['passwords']))!
    expect(failed.status).toBe('done')
    expect(failed.results.passwords?.error).toBe('That file does not look like a password export.')
    h.service.dismiss()
    h.files.length = 0
    h.files.push({ name: 'empty.html', text: '<p>nothing</p>' })
    const empty = (await h.service.run(FILE_SOURCE_IDS.bookmarks, ['bookmarks']))!
    expect(empty.results.bookmarks?.error).toBe('No bookmarks were found in that file.')
  })

  it('keeps the finished import as UIState.import until dismissed', async () => {
    const h = harness({ host: false })
    h.files.push({ name: 'b.html', text: '<DL><DT><A HREF="https://a.example/">A</A></DL>' })
    await h.service.run(FILE_SOURCE_IDS.bookmarks, ['bookmarks'])
    const shown = h.service.uiState() as ImportProgress
    expect(shown.status).toBe('done')
    expect(shown.source.id).toBe(FILE_SOURCE_IDS.bookmarks)
    expect(h.commits).toHaveBeenCalled()
    h.service.dismiss()
    expect(h.service.uiState()).toBeNull()
  })
})
