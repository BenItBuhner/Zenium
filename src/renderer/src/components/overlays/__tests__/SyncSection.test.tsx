// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncStatus, UIState } from '@shared/types'
import { defaultScope } from '@core/sync/records'

/*
 * The desktop Sync pane (ID-08): the folder-lost notice is the §9.17 / §9.33 message row on the
 * shared static row primitive – the state's glyph and the way out in the danger ink, the label
 * in the text's, one trailing secondary action, no card and no hue of its own – and the toggle
 * list runs in Chrome's order from the list the phone page shares.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { SyncSection } = await import('../SyncSection')

function sync(patch: Partial<SyncStatus> = {}): SyncStatus {
  return {
    enabled: true,
    folder: '/home/ben/Dropbox/Zenium',
    folderName: '/home/ben/Dropbox/Zenium',
    folderLost: false,
    deviceId: 'dev-1',
    deviceName: 'Work laptop',
    scope: defaultScope(),
    lastSyncAt: Date.now() - 60_000,
    lastError: null,
    syncing: false,
    devices: [],
    pendingMerge: false,
    ...patch
  }
}

function state(status: SyncStatus): UIState {
  return { platform: 'linux', sync: status } as unknown as UIState
}

function markup(status: SyncStatus): string {
  return renderToStaticMarkup(createElement(SyncSection, { state: state(status) }))
}

let root: Root | null = null
let mount: HTMLElement | null = null

beforeEach(() => invoke.mockClear())
afterEach(() => {
  if (root) act(() => root!.unmount())
  mount?.remove()
  root = null
  mount = null
})

describe('the desktop Sync pane', () => {
  it('draws no notice while the folder is reachable, and the status card names the folder', () => {
    const html = markup(sync())
    expect(html).not.toContain('data-testid="sync-folder-lost"')
    expect(html).not.toContain('The sync folder is no longer accessible')
    expect(html).toContain('/home/ben/Dropbox/Zenium')
    expect(html).toMatch(/<button[^>]*>[^<]*<svg[^>]*>[\s\S]*?<\/svg> Sync\s+now<\/button>/)
  })

  it('folder lost: the message row on the shared static row in the danger ink with Choose folder trailing; Sync now waits and the status card does not repeat the sentence', () => {
    const html = markup(
      sync({
        folderLost: true,
        lastError: 'The sync folder is no longer accessible. Choose it again to keep syncing.'
      })
    )
    const notice = html.match(
      /<div class="zen-v2" data-testid="sync-folder-lost">([\s\S]*?)<\/div><\/div>/
    )?.[1]
    expect(notice).toBeTruthy()
    // The shared row, static, toned – not a card: no border or fill class of its own. The tone
    // is the row's one attribute; the lead and the description carry none of their own (the
    // row rule in main.css paints them through it).
    expect(notice).toMatch(
      /<div class="zen-v2-row" data-static="" data-lines="2" data-tone="danger">/
    )
    expect(notice).toContain('class="lucide lucide-folder-x zen-v2-row-lead"')
    expect(notice).toContain(
      '<span class="zen-v2-label">The sync folder is no longer accessible</span>'
    )
    expect(notice).toContain(
      '<span class="zen-v2-description">Choose it again to keep syncing.</span>'
    )
    expect(notice?.match(/data-tone/g)).toHaveLength(1)
    expect(notice).toMatch(/<button type="button" class="zen-v2-button">Choose folder<\/button>/)
    expect(notice).not.toMatch(/red-|border-|rounded-|bg-/)
    // The engine's error is the sentence the row says: the status card shows the folder instead.
    expect(html.match(/The sync folder is no longer accessible/g)).toHaveLength(1)
    expect(html).not.toContain('<span class="text-[var(--v2-danger)]">')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Sync\s+now<\/button>/)
  })

  it('another error keeps the status card’s error line in the danger ink and Sync now pressable', () => {
    const html = markup(sync({ lastError: 'Could not read the folder' }))
    // The line takes the §1 status ink through its token, not a literal hue.
    expect(html).toContain('<span class="text-[var(--v2-danger)]">Could not read the folder</span>')
    expect(html).not.toContain('<span class="text-red-500">')
    expect(html).not.toContain('data-testid="sync-folder-lost"')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Sync\s+now<\/button>/)
  })

  it('reads the status line the phone page reads: the age lower case after "Last synced" (§9.1)', () => {
    expect(markup(sync())).toContain('Last synced 1 min ago')
    expect(markup(sync({ lastSyncAt: Date.now() }))).toContain('Last synced just now')
    expect(markup(sync({ syncing: true }))).toContain('Syncing…')
    expect(markup(sync({ lastSyncAt: null }))).toContain('Waiting for first sync')
  })

  it('Choose folder on the notice runs the picker and hands the chosen folder to the engine; a dismissed picker does nothing', async () => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
    act(() => {
      root!.render(createElement(SyncSection, { state: state(sync({ folderLost: true })) }))
    })
    const button = Array.from(mount.querySelectorAll('button')).find(
      (b) => b.textContent === 'Choose folder'
    )
    expect(button).toBeTruthy()
    invoke.mockResolvedValueOnce(null)
    await act(async () => {
      button!.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(invoke).toHaveBeenCalledWith('sync.chooseFolder', undefined)
    expect(invoke).not.toHaveBeenCalledWith('sync.setFolder', expect.anything())
    invoke.mockResolvedValueOnce('/media/drive/Zenium')
    await act(async () => {
      button!.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(invoke).toHaveBeenCalledWith('sync.setFolder', { folder: '/media/drive/Zenium' })
  })

  it('lists the toggles in Chrome’s order – Bookmarks, Open tabs, Passwords, Settings – then Zenium’s own, every scope key once', () => {
    const html = markup(sync())
    const list = html.slice(html.indexOf('What to sync'))
    const labels = Array.from(
      list.matchAll(/<div class="text-\[13px\]">([^<]+)<\/div>/g),
      (m) => m[1]
    )
    expect(labels.slice(0, 4)).toEqual(['Bookmarks', 'Open tabs', 'Passwords', 'Settings'])
    expect(labels).toHaveLength(Object.keys(defaultScope()).length)
    expect(labels).toContain('Spaces')
    expect(labels).toContain('Folders')
  })
})
