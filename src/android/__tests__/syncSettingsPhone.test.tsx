// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, SyncStatus, Tab, UIState } from '@shared/types'
import { defaultScope } from '@core/sync/records'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { INTERNAL_PAGES, availableSections } from '@shared/internalPages'

/*
 * Settings › Sync as the phone paints it from the engine's status (ID-32's Android half). The
 * render path this pins, file:line at v0.5.37 + #617 + #628:
 *
 *  - `src/android/platform.ts:1498-1503` – the platform's `sync` is `AndroidSyncHost`, whose
 *    `fetch` is `androidSyncFetch(bridge)` (`src/android/sync.ts:105`), and its `secrets` is
 *    `AndroidSecrets`; the phone publishes no status of its own.
 *  - `src/core/sync/engine.ts:306-331` – `status()` is the one `SyncStatus` the chrome reads;
 *    `webdavAvailable` (:329) is `Boolean(this.host.fetch && this.browser.platform.secrets)`
 *    (:335-337); a round the server answers 401 sets `authRefused`, `lastError` (the engine's raw
 *    line, "WebDAV PROPFIND answered 401") and `lastErrorKind: 'auth'` (:1039-1047).
 *  - `src/renderer/src/components/pages/settings/SettingsPage.tsx:356` – the phone page builds
 *    the section with `buildSection(current, ctx)` and draws `models[0].groups` through
 *    `GroupList` (:420-425, `className="zen-settings-body"`, `headingLevel={2}`) – the same two
 *    calls this test makes, with the same row context shape (`RowContext.open`).
 *  - `sections.tsx:312-315` `buildSection` → `BUILDERS.sync` (:349) → `syncSection` (:4851) →
 *    `syncGroups` (`sync.tsx:83-86`): connected → `connectedGroups`, else `setupGroups`.
 *  - `sync.tsx:104` – the "Sync through" row (`transportRow`, :174-195, label `SYNC_COPY.transport`
 *    = 'Sync through') is in the setup group only while `webdavAvailable`.
 *  - `sync.tsx:323-336` – `authRefused` is the `sync-auth-refused` info row: label 'The server
 *    refused the sign-in', description 'Enter a new app password to keep syncing.', tone danger.
 *  - `sync.tsx:358-363` – the Sync now row's line is `null` while `authRefused` (or `folderLost`),
 *    else `webDavOutcomeLine(lastErrorKind)` for a classified WebDAV error, and the engine's raw
 *    `lastError` only for an error with no class (the folder transport's, a record that would not
 *    decrypt). No other row reads `lastError`.
 *  - `sync.tsx:438-463` – while `authRefused` the App password field stands first in "Server and
 *    device" (`SYNC_COPY.whereServer`, :382), its commit `sync.setWebDavPassword`.
 *  - `rows.tsx:124-177` `GroupList` → `GroupRows` (:186) → `RowView` (:217); a field row on the
 *    phone shows `row.display ?? row.value` (:373-383), so a held app password is the dots
 *    (`appPasswordSet`).
 *
 * The rows' search `keywords` (the refused row lists '401' so "Find in Settings" reaches it)
 * are not painted (`rows.tsx` writes none), which is why these tests read the rendered DOM and
 * not `rowText()`.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { buildSection } = await import('@renderer/components/pages/settings/sections')
const { GroupList } = await import('@renderer/components/pages/settings/rows')
const { idleAutofillSettings } = await import('@renderer/lib/autofillSettings')
const { idleDictionaryWords } = await import('@renderer/lib/spellcheckWords')
const { clearSyncSetup, editWebDavDraft, syncSetupStore } = await import('@renderer/lib/syncSetup')

type SectionModel = ReturnType<typeof buildSection>

const SERVER_URL = 'http://127.0.0.1:8767/dav/'
const RAW_ENGINE_LINE = 'WebDAV PROPFIND answered 401'
/** The demo's fixture password shape; it must never reach the page's text. */
const APP_PASSWORD = 'demo-app-password-1'

function syncStatus(patch: Partial<SyncStatus> = {}): SyncStatus {
  return {
    enabled: false,
    folder: null,
    folderName: null,
    folderLost: false,
    deviceId: 'dev-1',
    deviceName: 'Pixel 8',
    scope: defaultScope(),
    lastSyncAt: null,
    lastError: null,
    lastErrorKind: null,
    syncing: false,
    devices: [],
    pendingMerge: false,
    remoteTabsVersion: 0,
    transport: 'folder',
    webdav: null,
    webdavAvailable: true,
    authRefused: false,
    accountAvailable: false,
    account: null,
    accountLink: null,
    accountLinkFailure: null,
    accountSignedOut: false,
    ...patch
  }
}

/** Connected through the server and refused since: the status the engine publishes after a 401. */
function refusedStatus(): SyncStatus {
  return syncStatus({
    enabled: true,
    transport: 'webdav',
    webdav: { url: SERVER_URL, username: 'alice', folder: 'Zenium' },
    folder: `${SERVER_URL}Zenium/`,
    folderName: 'Zenium',
    lastSyncAt: Date.now() - 5 * 60_000,
    authRefused: true,
    lastError: RAW_ENGINE_LINE,
    lastErrorKind: 'auth'
  })
}

const SETTINGS_TAB = {
  id: 'settings',
  spaceId: 'space',
  containerId: 'default',
  url: 'zen://settings/sync',
  title: 'Settings'
} as unknown as Tab

/** The phone's Sync section, built the way `SettingsPage` builds it (`formFactor: 'phone'`). */
function phoneSyncSection(sync: SyncStatus): SectionModel {
  const capabilities = { sync: true } as HostCapabilities
  const state = {
    platform: 'android',
    capabilities,
    tabs: { settings: SETTINGS_TAB },
    settings: DEFAULT_SETTINGS,
    sync
  } as unknown as UIState
  // Listed on the phone behind the `sync` capability (`availableSections`, as the page lists it).
  const def = availableSections(INTERNAL_PAGES.settings, capabilities, 'phone', 'android').find(
    (s) => s.id === 'sync'
  )
  if (!def) throw new Error('the Sync section is not listed on the phone')
  return buildSection(def, {
    state,
    tab: SETTINGS_TAB,
    pointer: false,
    formFactor: 'phone',
    set: () => undefined,
    navigate: () => undefined,
    openBarEditor: () => undefined,
    boost: () => undefined,
    autofill: idleAutofillSettings(),
    screenLock: true,
    readAloudVoices: null,
    dictionary: idleDictionaryWords()
  })
}

let root: Root | null = null
let host: HTMLElement | null = null

/** The section's groups painted as the phone page paints them (`SettingsPage.tsx:420-425`). */
function renderPhone(model: SectionModel): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root?.render(
      <GroupList
        groups={model.groups}
        ctx={{ open: () => undefined }}
        className="zen-settings-body"
        headingLevel={2}
      />
    )
  )
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  clearSyncSetup()
})

function rowOf(el: HTMLElement, id: string): HTMLElement {
  const row = el.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!row) throw new Error(`no row ${id} on the page`)
  return row
}

function groupOf(el: HTMLElement, id: string): HTMLElement {
  const group = el.querySelector<HTMLElement>(`[data-group="${id}"]`)
  if (!group) throw new Error(`no group ${id} on the page`)
  return group
}

/** Everything the page says: its text, and the words its elements carry for a reader or a hover. */
function pageWords(el: HTMLElement): string {
  const spoken = Array.from(el.querySelectorAll('[aria-label], [title], [placeholder]')).flatMap(
    (node) => ['aria-label', 'title', 'placeholder'].map((name) => node.getAttribute(name) ?? '')
  )
  return [el.textContent ?? '', ...spoken].join('\n')
}

describe('Settings › Sync on the phone, from the engine’s status (ID-32)', () => {
  it('a refused sign-in paints the status row and its way out over the App password row, and the engine’s raw line – its method and status code – reaches nothing on the page', () => {
    const el = renderPhone(phoneSyncSection(refusedStatus()))
    const words = pageWords(el)

    expect(words).toContain('The server refused the sign-in')
    expect(words).toContain('Enter a new app password to keep syncing.')
    expect(words).not.toContain('PROPFIND')
    expect(words).not.toContain('401')
    expect(words).not.toContain(RAW_ENGINE_LINE)
    expect(el.innerHTML).not.toContain('PROPFIND')
    expect(el.innerHTML).not.toContain('401')

    // The status row (§9.33): the sentence as the label, the way out as the description, the
    // danger ink through the row's one `data-tone`; nothing to press.
    const status = rowOf(el, 'sync-auth-refused')
    expect(status.closest('[data-group]')?.getAttribute('data-group')).toBe('sync-status')
    expect(status.getAttribute('data-tone')).toBe('danger')
    expect(status.querySelector('.zen-settings-label')?.textContent).toBe(
      'The server refused the sign-in'
    )
    expect(status.querySelector('.zen-settings-description')?.textContent).toBe(
      'Enter a new app password to keep syncing.'
    )
    expect(status.hasAttribute('data-static')).toBe(true)

    // Sync now's line is the status line, not the error the engine keeps (the row above says it).
    const syncNow = rowOf(el, 'sync-now')
    expect(syncNow.hasAttribute('data-tone')).toBe(false)
    expect(syncNow.querySelector('.zen-settings-description')?.textContent).toMatch(/^Last synced /)

    // "Server and device": the App password row first – the status row's follow-up (§9.17) –
    // then the server and its folder as facts.
    const where = groupOf(el, 'sync-where')
    expect(where.querySelector('h2')?.textContent).toBe('Server and device')
    const whereRows = Array.from(where.querySelectorAll<HTMLElement>('[data-row]')).map((r) =>
      r.getAttribute('data-row')
    )
    expect(whereRows).toEqual([
      'sync-webdav-password',
      'sync-server',
      'sync-server-folder',
      'sync-device-name'
    ])
    const password = rowOf(el, 'sync-webdav-password')
    expect(password.querySelector('.zen-settings-label')?.textContent).toBe('App password')
    expect(password.querySelector('.zen-settings-description')?.textContent).toBe(
      'The one the server takes now; the old one is forgotten.'
    )
    expect(status.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(rowOf(el, 'sync-server').textContent).toContain('alice')
    expect(rowOf(el, 'sync-server').textContent).toContain('127.0.0.1')
  })

  it('a host with the fetch and the secret store, and no folder yet, opens the setup with the "Sync through" row; without them the row is not painted', () => {
    const el = renderPhone(phoneSyncSection(syncStatus()))
    const setup = groupOf(el, 'sync-setup')
    expect(setup.querySelector('h2')?.textContent).toBe('Set up sync')
    const rows = Array.from(setup.querySelectorAll<HTMLElement>('[data-row]')).map((r) =>
      r.getAttribute('data-row')
    )
    expect(rows).toEqual(['sync-transport', 'sync-folder', 'sync-device-name', 'sync-turn-on'])
    const transport = rowOf(el, 'sync-transport')
    expect(transport.querySelector('.zen-settings-label')?.textContent).toBe('Sync through')
    expect(transport.querySelector('.zen-settings-description')?.textContent).toBe(
      'A folder on this device'
    )
    // The §9.13 picker's row: a button that opens a dialog.
    expect(transport.getAttribute('aria-haspopup')).toBe('dialog')
    expect(pageWords(el)).toContain('WebDAV server such as Nextcloud')

    act(() => root?.unmount())
    host?.remove()
    const folderOnly = renderPhone(phoneSyncSection(syncStatus({ webdavAvailable: false })))
    expect(folderOnly.querySelector('[data-row="sync-transport"]')).toBeNull()
    expect(
      Array.from(groupOf(folderOnly, 'sync-setup').querySelectorAll('[data-row]')).map((r) =>
        r.getAttribute('data-row')
      )
    ).toEqual(['sync-folder', 'sync-device-name', 'sync-turn-on'])
  })

  it('the server form as the phone paints it: the address with its http:// warning, the username, the folder, the App password as dots – the password itself on no line of the page – and Test connection', () => {
    syncSetupStore.set({ transport: 'webdav' })
    editWebDavDraft({
      url: SERVER_URL,
      username: 'alice',
      password: APP_PASSWORD,
      folder: 'Zenium'
    })
    const el = renderPhone(phoneSyncSection(syncStatus()))
    const rows = Array.from(
      groupOf(el, 'sync-setup').querySelectorAll<HTMLElement>('[data-row]')
    ).map((r) => r.getAttribute('data-row'))
    expect(rows).toEqual([
      'sync-transport',
      'sync-webdav-url',
      'sync-webdav-username',
      'sync-webdav-password',
      'sync-webdav-folder',
      'sync-webdav-test',
      'sync-device-name',
      'sync-turn-on'
    ])
    expect(
      rowOf(el, 'sync-transport').querySelector('.zen-settings-description')?.textContent
    ).toBe('A WebDAV server')
    const address = rowOf(el, 'sync-webdav-url')
    expect(address.querySelector('.zen-settings-description')?.textContent).toBe(SERVER_URL)
    expect(address.textContent).toContain('Over http:// the app password is sent unprotected.')
    expect(
      rowOf(el, 'sync-webdav-username').querySelector('.zen-settings-description')?.textContent
    ).toBe('alice')
    expect(
      rowOf(el, 'sync-webdav-password').querySelector('.zen-settings-description')?.textContent
    ).toBe('••••••••')
    expect(
      rowOf(el, 'sync-webdav-folder').querySelector('.zen-settings-description')?.textContent
    ).toBe('Zenium')
    expect(rowOf(el, 'sync-webdav-test').querySelector('.zen-settings-label')?.textContent).toBe(
      'Test connection'
    )
    expect(rowOf(el, 'sync-turn-on').hasAttribute('aria-disabled')).toBe(false)
    expect(pageWords(el)).not.toContain(APP_PASSWORD)
    expect(el.innerHTML).not.toContain(APP_PASSWORD)
  })

  it('the Zenium account on the phone: picked first in Sync through, Sign in → the code with the wait and Cancel → the email with Sign out, Turn on sync pressable once signed in', () => {
    const setupRows = (sync: SyncStatus): Array<string | null> => {
      act(() => root?.unmount())
      host?.remove()
      const el = renderPhone(phoneSyncSection(sync))
      return Array.from(groupOf(el, 'sync-setup').querySelectorAll('[data-row]')).map((r) =>
        r.getAttribute('data-row')
      )
    }
    const available = { accountAvailable: true }
    expect(setupRows(syncStatus(available))).toEqual([
      'sync-transport',
      'sync-account-sign-in',
      'sync-device-name',
      'sync-turn-on'
    ])
    const el0 = host!
    expect(
      rowOf(el0, 'sync-transport').querySelector('.zen-settings-description')?.textContent
    ).toBe('Zenium account')
    expect(rowOf(el0, 'sync-account-sign-in').textContent).toContain(
      'Opens the sign-in page in a new tab.'
    )
    expect(rowOf(el0, 'sync-turn-on').hasAttribute('aria-disabled')).toBe(true)
    expect(pageWords(el0)).toContain('Sign in to your Zenium account first.')

    const link = {
      userCode: 'WXYZ-2345',
      verificationUrl: 'https://example.test/link',
      expiresAt: 0
    }
    expect(setupRows(syncStatus({ ...available, accountLink: link }))).toEqual([
      'sync-transport',
      'sync-account-code',
      'sync-account-cancel',
      'sync-device-name',
      'sync-turn-on'
    ])
    const el1 = host!
    expect(rowOf(el1, 'sync-account-code').querySelector('.zen-settings-label')?.textContent).toBe(
      'WXYZ-2345'
    )
    expect(pageWords(el1)).toContain('Waiting for the sign-in to finish in the new tab…')
    expect(pageWords(el1)).toContain('Cancel sign-in')

    expect(setupRows(syncStatus({ ...available, account: { email: 'ada@example.com' } }))).toEqual([
      'sync-transport',
      'sync-account',
      'sync-account-sign-out',
      'sync-device-name',
      'sync-turn-on'
    ])
    const el2 = host!
    expect(rowOf(el2, 'sync-account').textContent).toContain('ada@example.com')
    expect(rowOf(el2, 'sync-turn-on').hasAttribute('aria-disabled')).toBe(false)
  })

  it('the Zenium account signed out by the service: the message row over Sign in again, and the engine’s raw line reaches nothing on the page', () => {
    const el = renderPhone(
      phoneSyncSection(
        syncStatus({
          enabled: true,
          transport: 'account',
          accountAvailable: true,
          account: { email: 'ada@example.com' },
          folder: 'https://accounts.example.convex.cloud',
          folderName: 'ada@example.com',
          lastSyncAt: Date.now() - 60_000,
          accountSignedOut: true,
          lastError: 'POST /auth/refresh answered 401 (revoked)',
          lastErrorKind: 'signed-out'
        })
      )
    )
    const status = rowOf(el, 'sync-account-signed-out')
    expect(status.getAttribute('data-tone')).toBe('danger')
    expect(status.querySelector('.zen-settings-label')?.textContent).toBe(
      'You were signed out of your Zenium account'
    )
    const where = groupOf(el, 'sync-where')
    expect(where.querySelector('h2')?.textContent).toBe('Account and device')
    expect(
      Array.from(where.querySelectorAll('[data-row]')).map((r) => r.getAttribute('data-row'))
    ).toEqual(['sync-account-sign-in', 'sync-account', 'sync-account-sign-out', 'sync-device-name'])
    expect(
      rowOf(el, 'sync-account-sign-in').querySelector('.zen-settings-label')?.textContent
    ).toBe('Sign in again')
    const words = pageWords(el)
    expect(words).not.toContain('401')
    expect(words).not.toContain('/auth/refresh')
    expect(words).not.toContain('revoked')
  })
})
