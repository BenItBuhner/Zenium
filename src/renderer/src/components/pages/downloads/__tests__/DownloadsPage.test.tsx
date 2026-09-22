// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadItem, Tab, UIState } from '@shared/types'
import { downloadItem } from '@shared/__tests__/downloadFixtures'

/*
 * The Downloads page tab (design language v2 §10.1; Chrome's chrome://downloads): the title
 * block with Open downloads folder and Clear all, the search field that filters the list and
 * moves the tab's URL to `zen://downloads?q=` without a history entry, the day groups as §9.27
 * headings over §9.21 two-line rows with #166's states, the rows' icon actions in the trailing
 * slot – the state's verb at rest, Open, Show in folder and the ⋮ on approach – the core's row
 * menu from the ⋮ and a right click, drag-out for a finished file, the Clear all prompt on the
 * frame's dialog host, and the §9.17 empty states.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.now()
/** Local midnight today: the day buckets are local days, so the rows are seeded from it. */
const TODAY = new Date(NOW).setHours(0, 0, 0, 0)
const YESTERDAY = TODAY - DAY

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { DownloadsPage } = await import('../DownloadsPage')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore } = await import('@renderer/lib/browserStore')

const done = downloadItem({
  id: 'done',
  filename: 'report-final-v2.pdf',
  url: 'https://files.example.com/reports/report-final-v2.pdf',
  referrer: 'https://www.example.com/reports',
  totalBytes: 2048,
  receivedBytes: 2048,
  startedAt: TODAY + HOUR,
  completedAt: TODAY + HOUR + 10_000,
  endedAt: TODAY + HOUR + 10_000
})
const running: DownloadItem = downloadItem({
  id: 'running',
  filename: 'video.mp4',
  url: 'https://cdn.example.org/video.mp4',
  state: 'progressing',
  totalBytes: 10_000_000,
  receivedBytes: 2_500_000,
  bytesPerSecond: 500_000,
  etaMs: 15_000,
  startedAt: TODAY + 2 * HOUR,
  completedAt: 0,
  endedAt: 0
})
const failed: DownloadItem = downloadItem({
  id: 'failed',
  filename: 'archive.zip',
  url: 'https://downloads.example.net/archive.zip',
  state: 'interrupted',
  receivedBytes: 512,
  error: 'network-disconnected',
  errorMessage: 'Check internet connection',
  startedAt: YESTERDAY + 2 * HOUR,
  completedAt: 0,
  endedAt: YESTERDAY + 2 * HOUR + 10_000
})
const deleted: DownloadItem = downloadItem({
  id: 'deleted',
  filename: 'photo.jpg',
  url: 'https://photos.example.com/photo.jpg',
  fileMissing: true,
  startedAt: YESTERDAY + HOUR,
  completedAt: YESTERDAY + HOUR + 10_000,
  endedAt: YESTERDAY + HOUR + 10_000
})
const ITEMS: DownloadItem[] = [done, running, failed, deleted]

/** What the page reads, plus the one space the store's listeners look an active tab up in. */
function state(items: DownloadItem[] = ITEMS, platform = 'linux'): UIState {
  return {
    downloads: items,
    platform,
    shortcuts: [],
    spaces: [{ id: 'space', activeTabId: null, tabIds: [] }],
    activeSpaceId: 'space',
    tabs: {}
  } as unknown as UIState
}

function tab(url = 'zen://downloads'): Tab {
  return {
    id: 'downloads',
    spaceId: 'space',
    containerId: 'default',
    url,
    title: 'Downloads',
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    openerTabId: null
  } as Tab
}

let root: Root | null = null
let mount: HTMLElement | null = null

/** The page beside the frame's dialog host, as the content frame mounts them (TabDialogs). */
function page(t: Tab, s: UIState): ReturnType<typeof createElement> {
  return createElement(
    'div',
    null,
    createElement(DownloadsPage, { state: s, tab: t }),
    createElement(FrameDialogHost, { frame: true })
  )
}

/** The page reads the state it is given and, as it opens, the store the host renders from. */
async function mountPage(t: Tab = tab(), s: UIState = state()): Promise<HTMLElement> {
  browserStore.set({ state: s })
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  await act(async () => root!.render(page(t, s)))
  return mount
}

async function rerender(t: Tab, s: UIState = state()): Promise<void> {
  browserStore.set({ state: s })
  await act(async () => root!.render(page(t, s)))
}

/**
 * End a dialog's way out on a mouse: the frame's host keeps the panel through its pop in
 * reverse (`data-leaving`) and drops it as the animation reports its end – happy-dom runs none.
 */
async function endLeave(): Promise<void> {
  await act(async () => {
    for (const panel of document.querySelectorAll('.zen-frame-dialogs-slot > [data-leaving]')) {
      panel.dispatchEvent(new Event('animationend'))
    }
  })
}

/** Every `invoke` of `name`, in order. */
function calls(name: string): unknown[] {
  return invoke.mock.calls.filter((c) => c[0] === name).map((c) => c[1])
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function row(el: HTMLElement, id: string): HTMLElement {
  return el.querySelector<HTMLElement>(`[data-download-id="${id}"]`)!
}

/** The rows on the page, in order. */
function ids(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[data-download-id]')].map(
    (r) => r.getAttribute('data-download-id') ?? ''
  )
}

/** The row's icon actions by label, at rest and on approach alike. */
function actions(r: HTMLElement): string[] {
  return [...r.querySelectorAll<HTMLButtonElement>('.zen-dl-page-actions button')].map(
    (b) => b.getAttribute('aria-label') ?? text(b)
  )
}

/** The actions that hide until the row is approached (`.zen-page-row-reveal`). */
function revealed(r: HTMLElement): string[] {
  return [
    ...r.querySelectorAll<HTMLButtonElement>('.zen-dl-page-actions button.zen-page-row-reveal')
  ].map((b) => b.getAttribute('aria-label') ?? '')
}

function action(r: HTMLElement, name: string): HTMLButtonElement {
  return r.querySelector<HTMLButtonElement>(`[data-zen-dl-action="${name}"]`)!
}

async function type(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    vi.advanceTimersByTime(200)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  invoke.mockClear()
  act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false }))
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  browserStore.set({ state: null })
  vi.useRealTimers()
})

describe('the Downloads page tab (§10.1)', () => {
  it('draws the title block with its two actions and the search field, no overlay chrome', async () => {
    const el = await mountPage()
    const pageEl = el.querySelector('[data-testid="downloads-page"]')!
    expect(pageEl.classList.contains('zen-page')).toBe(true)
    expect(text(pageEl.querySelector('h1.zen-page-title'))).toBe('Downloads')
    const buttons = [...pageEl.querySelectorAll('.zen-page-title-actions button')]
    expect(buttons.map(text)).toEqual(['Open downloads folder', 'Clear all'])
    for (const b of buttons) expect(b.classList.contains('zen-v2-button')).toBe(true)
    const field = pageEl.querySelector<HTMLInputElement>('[data-testid="downloads-search"]')!
    expect(field.classList.contains('zen-v2-field')).toBe(true)
    expect(field.getAttribute('placeholder')).toBe('Search downloads')
    // Nothing of the overlay shell: no close button, no panel, no shell.
    expect(pageEl.querySelector('[aria-label="Close"]')).toBeNull()
    expect(pageEl.querySelector('.zen-panel, .zen-dl-page, .zen-dl-surface')).toBeNull()
    expect(pageEl.querySelector('.zen-page-scroll > header.zen-page-header')).not.toBeNull()
  })

  it('checks the finished files as it opens, so a file gone since reads Deleted (#166)', async () => {
    await mountPage()
    // The released finished rows only: `done` and `deleted` (the engine un-marks one that came back).
    expect(calls('download.exists')).toEqual([{ id: 'done' }, { id: 'deleted' }])
  })

  it('groups the downloads by day under §9.27 headings, newest first, each a §9.21 two-line row', async () => {
    const el = await mountPage()
    const headings = [...el.querySelectorAll('.zen-page-group h2')].map(text)
    expect(headings).toEqual(['Today', 'Yesterday'])
    const asides = [...el.querySelectorAll('.zen-page-heading-aside')].map(text)
    expect(asides).toEqual(['2', '2'])
    const rows = [...el.querySelectorAll('li.zen-v2-row.zen-page-row.zen-dl-page-row')]
    expect(rows.map((r) => r.getAttribute('data-download-id'))).toEqual([
      'running',
      'done',
      'failed',
      'deleted'
    ])
    // The row is the arrows' target and the row's name a button that opens the file.
    const r = row(el, 'done')
    expect(r.hasAttribute('data-row-focus')).toBe(true)
    expect(r.getAttribute('tabindex')).toBe('0')
    expect(r.querySelector('.zen-dl-glyph')).not.toBeNull()
    const name = r.querySelector('.zen-dl-name')!
    expect(name.tagName).toBe('BUTTON')
    expect(text(name)).toBe('report-final-v2.pdf')
    // The host, then the status, on the row's second line.
    expect(text(r.querySelector('.zen-page-row-desc'))).toBe('example.com · Done · 2.0 KB')
    expect(r.getAttribute('aria-label')).toBe('report-final-v2.pdf. Done · 2.0 KB')
  })

  it('gives a finished file Open, Show in folder and the ⋮ on approach, which act on the engine', async () => {
    const el = await mountPage()
    const r = row(el, 'done')
    expect(actions(r)).toEqual(['Open', 'Show in folder', 'More actions'])
    expect(revealed(r)).toEqual(['Open', 'Show in folder', 'More actions'])
    for (const b of r.querySelectorAll('.zen-dl-page-actions button')) {
      expect(b.className.split(' ')[0]).toBe('zen-v2-icon-button')
    }
    await act(async () => action(r, 'open').click())
    expect(calls('download.open')).toEqual([{ id: 'done' }])
    await act(async () => action(r, 'show-in-folder').click())
    expect(calls('download.showInFolder')).toEqual([{ id: 'done' }])
    // The name opens the file too, as does Enter on the row.
    await act(async () => (r.querySelector('.zen-dl-name') as HTMLButtonElement).click())
    expect(calls('download.open')).toHaveLength(2)
    await act(async () => {
      r.focus()
      r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(calls('download.open')).toHaveLength(3)
    // A finished file can be dragged out to the OS; the host's drag replaces the HTML5 one.
    expect(r.getAttribute('draggable')).toBe('true')
    await act(async () => {
      r.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }))
    })
    expect(calls('download.dragOut')).toEqual([{ id: 'done' }])
  })

  it('a middle or Ctrl click on a row – its name included – opens the download’s page behind this tab (§10.1: one meaning on every page row), the file left alone', async () => {
    const el = await mountPage()
    const r = row(el, 'done')
    const behind = {
      input: 'https://www.example.com/reports',
      newTab: true,
      tabId: 'downloads',
      background: true
    }
    // The row's empty space: Ctrl-click, ⌘-click and the middle button are the page behind.
    await act(async () =>
      r.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    )
    expect(calls('urlbar.submit')).toEqual([behind])
    await act(async () =>
      r.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    )
    expect(calls('urlbar.submit')).toHaveLength(2)
    await act(async () => r.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })))
    expect(calls('urlbar.submit')).toHaveLength(3)
    expect(calls('urlbar.submit').at(-1)).toEqual(behind)
    expect(calls('download.open')).toEqual([])
    // A plain click on the row's space is nothing; a plain double click is the file.
    await act(async () => r.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(calls('download.open')).toEqual([])
    await act(async () => r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(calls('download.open')).toEqual([{ id: 'done' }])
    // A Ctrl-double-click's first click opened the page behind; its second and the dblclick add nothing.
    await act(async () =>
      r.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, detail: 1 }))
    )
    await act(async () =>
      r.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, detail: 2 }))
    )
    await act(async () =>
      r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, ctrlKey: true }))
    )
    expect(calls('urlbar.submit')).toHaveLength(4)
    expect(calls('download.open')).toHaveLength(1)
    // The name is the file's button, but a Ctrl-click on it is the page behind too, not the file.
    const name = r.querySelector<HTMLButtonElement>('.zen-dl-name')!
    await act(async () =>
      name.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    )
    expect(calls('urlbar.submit')).toHaveLength(5)
    expect(calls('download.open')).toHaveLength(1)
    await act(async () => name.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(calls('download.open')).toHaveLength(2)
    expect(calls('urlbar.submit')).toHaveLength(5)
    // The trailing controls keep their own meaning under Ctrl and the middle button.
    await act(async () =>
      action(r, 'open').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    )
    expect(calls('download.open')).toHaveLength(3)
    await act(async () =>
      action(r, 'open').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    )
    expect(calls('urlbar.submit')).toHaveLength(5)
    // A download with no referrer opens its own address; a row without a file on disk still has its page.
    const running = row(el, 'running')
    await act(async () =>
      running.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    )
    expect(calls('urlbar.submit').at(-1)).toEqual({
      input: 'https://cdn.example.org/video.mp4',
      newTab: true,
      tabId: 'downloads',
      background: true
    })
    const gone = row(el, 'deleted')
    await act(async () =>
      gone
        .querySelector('.zen-dl-name')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    )
    expect(calls('urlbar.submit').at(-1)).toMatchObject({
      input: 'https://photos.example.com/photo.jpg',
      background: true
    })
    expect(calls('download.open')).toHaveLength(3)
  })

  it('hangs the core’s row menu from the ⋮, in keyboard mode from a key, and at the pointer from a right click', async () => {
    const el = await mountPage()
    const r = row(el, 'done')
    const more = action(r, 'menu')
    expect(more.getAttribute('aria-haspopup')).toBe('menu')
    // Enter and Space report a click count of 0; a pointer's click counts.
    await act(async () => more.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })))
    expect(calls('download.contextMenu').at(-1)).toMatchObject({ id: 'done', keyboard: true })
    await act(async () => more.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
    expect(calls('download.contextMenu').at(-1)).toMatchObject({ id: 'done', keyboard: false })
    await act(async () =>
      r.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 300, clientY: 200 })
      )
    )
    expect(calls('download.contextMenu').at(-1)).toEqual({ id: 'done', x: 300, y: 200 })
  })

  it('shows a running transfer its progress bar with Pause and Cancel at rest', async () => {
    const el = await mountPage()
    const r = row(el, 'running')
    expect(r.getAttribute('data-state')).toBe('progressing')
    expect(r.querySelector('.zen-dl-bar[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '25'
    )
    // Binary units, as the bubble's status line reads them.
    expect(text(r.querySelector('.zen-page-row-desc'))).toBe(
      'cdn.example.org · 488 KB/s · 2.4 MB of 9.5 MB · 15 secs left'
    )
    expect(actions(r)).toEqual(['Pause', 'Cancel', 'More actions'])
    expect(revealed(r)).toEqual(['More actions'])
    // Nothing to open or drag while it runs.
    expect(r.querySelector('.zen-dl-name')!.tagName).toBe('SPAN')
    expect(r.getAttribute('draggable')).toBe('false')
    await act(async () => action(r, 'pause').click())
    expect(calls('download.pause')).toEqual([{ id: 'running' }])
    await act(async () => action(r, 'cancel').click())
    expect(calls('download.cancel')).toEqual([{ id: 'running' }])
  })

  it('reads Failed · <reason> in the danger ink with Retry at rest, and the Deleted row greyed with Retry', async () => {
    const el = await mountPage()
    const f = row(el, 'failed')
    const line = f.querySelector('.zen-page-row-desc span.zen-dl-status-danger')!
    expect(text(line)).toBe('Failed · Check internet connection')
    expect(line.getAttribute('title')).toBe('Check internet connection')
    expect(actions(f)).toEqual(['Retry', 'More actions'])
    expect(revealed(f)).toEqual(['More actions'])
    await act(async () => action(f, 'retry').click())
    expect(calls('download.retry')).toEqual([{ id: 'failed' }])
    const d = row(el, 'deleted')
    expect(d.getAttribute('data-deleted')).toBe('true')
    expect(text(d.querySelector('.zen-page-row-desc'))).toBe('photos.example.com · Deleted')
    const name = d.querySelector('.zen-dl-name')!
    expect(name.tagName).toBe('SPAN')
    expect(name.classList.contains('zen-dl-deemph')).toBe(true)
    expect(d.querySelector('.zen-dl-glyph')?.className).toContain('opacity-40')
    expect(actions(d)).toEqual(['Retry', 'More actions'])
    expect(d.getAttribute('draggable')).toBe('false')
  })

  it('shows a flagged file the Keep / Delete pair in place of its actions', async () => {
    const flagged = downloadItem({
      id: 'flagged',
      filename: 'setup.exe',
      url: 'https://sketchy.example/setup.exe',
      danger: { level: 'dangerous', reason: 'file-type', message: '' },
      startedAt: NOW - 1_000
    })
    const el = await mountPage(tab(), state([flagged]))
    const r = row(el, 'flagged')
    expect(r.getAttribute('data-flagged')).toBe('true')
    expect(text(r.querySelector('.zen-page-row-desc'))).toBe(
      'sketchy.example · Blocked · Dangerous'
    )
    expect(text(r.querySelector('.zen-dl-detail'))).toContain('dangerous')
    expect(actions(r)).toEqual(['Keep', 'Delete', 'More actions'])
    await act(async () => action(r, 'discard').click())
    expect(calls('download.discard')).toEqual([{ id: 'flagged' }])
  })

  it('a typed search filters the list on the name and the source and moves the URL to ?q= with replace', async () => {
    const el = await mountPage()
    const field = el.querySelector<HTMLInputElement>('[data-testid="downloads-search"]')!
    await type(field, 'report')
    expect(ids(el)).toEqual(['done'])
    expect([...el.querySelectorAll('.zen-page-group h2')].map(text)).toEqual(['Today'])
    expect(calls('page.navigate')).toEqual([
      { tabId: 'downloads', section: null, replace: true, query: { q: 'report' } }
    ])
    await type(field, 'example.net')
    expect(ids(el)).toEqual(['failed'])
    // Clearing the field goes back to the plain URL and the whole list.
    await act(async () =>
      el.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!.click()
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(calls('page.navigate').at(-1)).toEqual({
      tabId: 'downloads',
      section: null,
      replace: true,
      query: undefined
    })
    expect(el.querySelectorAll('[data-download-id]')).toHaveLength(4)
  })

  it('a query the URL brings fills the field and filters, and is not pushed back', async () => {
    const el = await mountPage(tab('zen://downloads?q=photo'))
    const field = el.querySelector<HTMLInputElement>('[data-testid="downloads-search"]')!
    expect(field.value).toBe('photo')
    expect(ids(el)).toEqual(['deleted'])
    expect(calls('page.navigate')).toEqual([])
    await rerender(tab('zen://downloads?q=video'))
    expect(field.value).toBe('video')
    expect(ids(el)).toEqual(['running'])
    expect(calls('page.navigate')).toEqual([])
  })

  it('says so when there is nothing, and when nothing matches (§9.17)', async () => {
    const el = await mountPage(tab(), state([]))
    const empty = el.querySelector('[data-testid="downloads-empty"]')!
    expect(empty.getAttribute('role')).toBe('status')
    expect(text(empty)).toBe('Files you download appear here')
    // Nothing to clear either: the action sits disabled at .4 (§9.30), still there.
    expect(
      el.querySelector<HTMLButtonElement>('[data-testid="downloads-clear-all"]')!.disabled
    ).toBe(true)
    await rerender(tab('zen://downloads?q=nothing-like-it'), state())
    expect(text(el.querySelector('[data-testid="downloads-empty"]'))).toBe(
      'No downloads match “nothing-like-it”'
    )
  })

  it('Clear all asks first in a v2 prompt over the frame; the primary clears the settled rows, Cancel keeps them', async () => {
    const el = await mountPage()
    const clear = el.querySelector<HTMLButtonElement>('[data-testid="downloads-clear-all"]')!
    expect(clear.disabled).toBe(false)
    // A real click focuses the button first; happy-dom's does not.
    await act(async () => {
      clear.focus()
      clear.click()
    })
    const dialog = document.querySelector<HTMLElement>('[data-dialog="downloads:clear-all"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.classList.contains('zen-v2-dialog')).toBe(true)
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(text(dialog.querySelector('.zen-v2-title-block-title'))).toBe('Clear all downloads?')
    // Three settled rows go (the running one stays); the files stay where they were saved.
    expect(text(dialog.querySelector('.zen-v2-title-block-description'))).toContain(
      '3 downloads will be removed from the list. The files stay where they were saved'
    )
    // It is placed by the frame's dialog host, not inside the page.
    expect(dialog.closest('.zen-frame-dialogs')).not.toBeNull()
    expect(dialog.closest('[data-testid="downloads-page"]')).toBeNull()
    // Focus starts on Cancel so a stray Enter does no harm.
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map(text)).toEqual(['Cancel', 'Clear all'])
    expect(document.activeElement).toBe(buttons[0])
    await act(async () => buttons[0]!.click())
    // Cancel: the host keeps the panel for its way out (§9.5) and drops it as the pop ends;
    // nothing was cleared, and focus is back on the opener.
    expect(dialog.hasAttribute('data-leaving')).toBe(true)
    await endLeave()
    expect(document.querySelector('[data-dialog="downloads:clear-all"]')).toBeNull()
    expect(calls('download.removeCompleted')).toEqual([])
    expect(document.activeElement).toBe(clear)
    await act(async () => clear.click())
    const again = document.querySelector<HTMLElement>('[data-dialog="downloads:clear-all"]')!
    expect(again.hasAttribute('data-leaving')).toBe(false)
    await act(async () =>
      [...again.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => text(b) === 'Clear all')!
        .click()
    )
    expect(calls('download.removeCompleted')).toEqual([undefined])
    await endLeave()
    expect(document.querySelector('[data-dialog="downloads:clear-all"]')).toBeNull()
  })

  it('Open downloads folder asks the host for the folder; a host without files has neither it nor Show in folder', async () => {
    const el = await mountPage()
    await act(async () =>
      el.querySelector<HTMLButtonElement>('[data-testid="downloads-open-folder"]')!.click()
    )
    expect(calls('download.openFolder')).toEqual([undefined])
    await rerender(tab(), state(ITEMS, 'android'))
    expect(el.querySelector('[data-testid="downloads-open-folder"]')).toBeNull()
    expect(actions(row(el, 'done'))).toEqual(['Open', 'More actions'])
    expect(row(el, 'done').getAttribute('draggable')).toBe('false')
  })

  it('the arrows walk the rows across the day groups; Home and End jump (§9.22)', async () => {
    const el = await mountPage()
    const first = row(el, 'running')
    await act(async () => {
      first.focus()
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(row(el, 'done'))
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      )
    })
    expect(document.activeElement).toBe(row(el, 'failed'))
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true })
      )
    })
    expect(document.activeElement).toBe(row(el, 'deleted'))
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true })
      )
    })
    expect(document.activeElement).toBe(first)
  })
})
