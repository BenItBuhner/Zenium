// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BookmarkNode, Tab, UIState } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import { viewportStore } from '@renderer/lib/formFactor'
import { FrameDialogHost } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'

/*
 * The frame dialog host's phone dialogs are §9.16 sheets (the primitives pass 5's seed 48, the
 * lead's chassis item from #364's final): the grip, edge to edge, the 48 centred header for a
 * form, the footer at 16 + the inset – never the floating card `.zen-bm-dialog … self-end
 * justify-self-stretch` drew 8 inside the frame's edges. "Bookmark all tabs" was the one such
 * dialog a phone could still reach (the app menu's Bookmarks submenu); the star bubble's and the
 * edit dialog's phone cards were dead code behind the phone's own editor sheet and are gone.
 * Rendered for real in happy-dom on the frame's dialog host, the sheet's spring cranked by hand.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: async () => null,
  onEvent: () => () => undefined
}))

const { BookmarkAllTabsDialog } = await import('../BookmarkAllTabsDialog')

/** A hand-cranked animation frame: `run(n)` advances the clock 16 ms a frame and runs the callbacks. */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }

  get scheduled(): boolean {
    return this.queue.size > 0
  }
}

const frames = new Frames()
let root: Root | null = null
let mount: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []

const TAB = {
  id: 'r',
  spaceId: 'space',
  containerId: 'default',
  url: BLANK_URL,
  title: '',
  favicon: null,
  pinned: false,
  essential: false,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  muted: false,
  discarded: false,
  frozen: false,
  zoom: 1,
  createdAt: 0,
  lastActiveAt: 0
} as unknown as Tab

const folder = (
  id: string,
  parentId: string | null,
  title: string,
  index = 0,
  modified = 0
): BookmarkNode => ({
  id,
  parentId,
  index,
  type: 'folder',
  title,
  dateAdded: 0,
  dateGroupModified: modified
})

/** The three roots and two folders: "Work" under the bar, filed into last; "Reading" inside it. */
const BOOKMARKS: BookmarkNode[] = [
  folder('1', null, 'Bookmarks bar', 0),
  folder('2', null, 'Other bookmarks', 1),
  folder('3', null, 'Mobile bookmarks', 2),
  folder('f-work', '1', 'Work', 0, 50),
  folder('f-read', 'f-work', 'Reading', 0, 10)
]

function state(): UIState {
  return {
    platform: 'android',
    tabs: { r: TAB },
    spaces: [{ id: 'space', activeTabId: 'r', tabIds: ['r'] }],
    activeSpaceId: 'space',
    essentialTabIds: [],
    settings: {},
    bookmarks: BOOKMARKS
  } as unknown as UIState
}

const REQUEST = { tabIds: ['a', 'b', 'c'], defaultTitle: '3 tabs' }

/** One tree at a time: a root left mounted would keep its `Host` on the store and mount a second sheet. */
function unmount(): void {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
}

function render(el: ReactElement): void {
  unmount()
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

/** Let the wait for the page's cover resolve (at once with no page) and the sheet come up. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Run the sheet's spring to rest. */
function rest(): void {
  for (let i = 0; i < 200 && frames.scheduled; i++) act(() => frames.run(1))
  expect(frames.scheduled).toBe(false)
}

/** As TabDialogs mounts it: the form while the store holds a request, gone when it clears. */
function Host(): ReactElement {
  const request = uiStore.use((s) => s.bookmarkAllTabs)
  return (
    <FrameDialogHost frame>
      {request && <BookmarkAllTabsDialog state={state()} request={request} />}
    </FrameDialogHost>
  )
}

const view = (): ReactElement => {
  uiStore.set({ bookmarkAllTabs: REQUEST })
  return <Host />
}

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const qa = <T extends HTMLElement>(selector: string): T[] => [...document.querySelectorAll<T>(selector)]
const sheets = (): HTMLElement[] => qa('.zen-sheet[role="dialog"]')
const click = (el: Element | null): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const type = (input: HTMLInputElement, value: string): void => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const saved = (): unknown[][] => run.mock.calls.filter(([name]) => name === 'bookmark.createFromTabs')

beforeEach(() => {
  run.mockClear()
  frames.install()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone', coarse: true })
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  // The layer is 800 px tall and the sheet's content 300 px: a sheet with room to stand.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
})

afterEach(() => {
  unmount()
  uiStore.set({ bookmarkAllTabs: null })
  act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false }))
  vi.unstubAllGlobals()
  frames.now = 0
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

describe('"Bookmark all tabs" on a phone (seed 48: the frame host’s dialogs are §9.16 sheets)', () => {
  it('is a form sheet: the 48 header names it, the count as body copy, Name and Folder in the form, Cancel | Save splitting the chassis footer, the sheet focused', async () => {
    render(view())
    await settle()
    rest()
    const [dialog] = sheets()
    expect(dialog).toBeDefined()
    // No floating card anywhere: the sheet is the panel, the host's slot holds it edge to edge.
    expect(q('.zen-bm-dialog')).toBeNull()
    expect(q('.zen-v2-dialog')).toBeNull()
    expect(dialog.querySelector('.zen-sheet-handle, [class*="zen-sheet-grip"], .zen-sheet-header')).not.toBeNull()
    // The grip's 48 header, the title centred in it, naming the dialog (§9.16); no title block.
    const title = dialog.querySelector<HTMLElement>('.zen-sheet-header h2.zen-sheet-title')!
    expect(title.textContent).toBe('Bookmark all tabs')
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    expect(dialog.querySelector('.zen-sheet-title-block')).toBeNull()
    // The count's sentence introduces the form: body copy under the header (§9.23), first in the form.
    const form = dialog.querySelector<HTMLFormElement>('form.zen-phone-form')!
    const copy = form.querySelector<HTMLElement>('.zen-phone-form-copy')!
    expect(copy.textContent).toBe('3 pages go into a new folder')
    expect(form.firstElementChild).toBe(copy)
    // The form's two fields in the 16 gutter (§9.12): Name as a field, Folder as the §9.13 menulist.
    const fields = [...form.querySelectorAll<HTMLElement>('.zen-phone-form-field')]
    expect(fields.map((f) => f.querySelector('.zen-phone-field-label')?.textContent)).toEqual([
      'Name',
      'Folder'
    ])
    const name = fields[0].querySelector<HTMLInputElement>('.zen-phone-field > input')!
    expect(fields[0].querySelector('label')?.getAttribute('for')).toBe(name.id)
    expect(name.value).toBe('3 tabs')
    const menulist = fields[1].querySelector<HTMLButtonElement>('button.zen-v2-menulist')!
    // The most recently filed-into folder is the default, as Chrome's.
    expect(menulist.textContent).toBe('Work')
    expect(menulist.getAttribute('aria-haspopup')).toBe('dialog')
    // Cancel | Save: the chassis footer closes the form, peers splitting the width, the primary trailing.
    const footer = form.querySelector<HTMLElement>('.zen-sheet-footer')!
    const buttons = [...footer.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Save'])
    expect(buttons[1].hasAttribute('data-primary')).toBe(true)
    expect(buttons[1].type).toBe('submit')
    expect(buttons[0].hasAttribute('data-primary')).toBe(false)
    // The sheet itself takes the focus (§9.22): a field never does on a phone.
    expect(document.activeElement).toBe(dialog)
  })

  it('Save slides the sheet away and files the tabs once it has gone; Cancel files nothing; the request clears with the sheet', async () => {
    render(view())
    await settle()
    rest()
    const dialog = sheets()[0]
    type(dialog.querySelector<HTMLInputElement>('.zen-phone-field > input')!, 'Trip')
    click(dialog.querySelector('.zen-sheet-footer button[type="submit"]'))
    // Nothing yet: the commit waits for the sheet's motion, like a picked menu row.
    expect(saved()).toEqual([])
    expect(uiStore.get().bookmarkAllTabs).toEqual(REQUEST)
    rest()
    expect(saved()).toEqual([
      ['bookmark.createFromTabs', { tabIds: ['a', 'b', 'c'], title: 'Trip', parentId: 'f-work' }]
    ])
    expect(uiStore.get().bookmarkAllTabs).toBeNull()
    expect(sheets()).toEqual([])

    unmount()
    render(view())
    await settle()
    rest()
    click(sheets()[0].querySelector('.zen-sheet-footer button[type="button"]'))
    rest()
    expect(saved()).toHaveLength(1)
    expect(uiStore.get().bookmarkAllTabs).toBeNull()
  })

  it('the Folder menulist opens a picker sheet over the form (§9.13, §9.24): every folder as a radio row, indented by depth, the chosen one checked; a pick lands once the picker has gone', async () => {
    render(view())
    await settle()
    rest()
    const form = sheets()[0]
    click(form.querySelector('button.zen-v2-menulist'))
    await settle()
    rest()
    const [under, picker] = sheets()
    expect(under).toBe(form)
    expect(picker).toBeDefined()
    expect(picker.querySelector('.zen-sheet-header h2.zen-sheet-title')?.textContent).toBe('Folder')
    const rows = [...picker.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(rows.map((r) => r.textContent)).toEqual([
      'Bookmarks bar',
      'Work',
      'Reading',
      'Other bookmarks',
      'Mobile bookmarks'
    ])
    expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'false',
      'false'
    ])
    // Each level 16 further in (the row's own 16 for a root).
    expect(rows.map((r) => r.style.paddingInlineStart)).toEqual(['', '32px', '48px', '', ''])
    for (const row of rows) {
      expect(row.classList.contains('zen-v2-row')).toBe(true)
      expect(row.querySelector('.zen-v2-radio')).not.toBeNull()
    }
    // The checked row takes the focus as the picker opens (§9.22).
    expect(document.activeElement).toBe(rows[1])
    click(rows[2])
    // The pick lands as the picker has gone: the menulist reads it, the form's sheet stands alone.
    await settle()
    rest()
    await settle()
    expect(sheets()).toEqual([form])
    expect(form.querySelector('button.zen-v2-menulist')?.textContent).toBe('Reading')
    click(form.querySelector('.zen-sheet-footer button[type="submit"]'))
    rest()
    expect(saved()).toEqual([
      ['bookmark.createFromTabs', { tabIds: ['a', 'b', 'c'], title: '3 tabs', parentId: 'f-read' }]
    ])
  })

  it('on a mouse the same form is the v2 dialog card, untouched', async () => {
    act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false }))
    render(view())
    await settle()
    const card = q<HTMLElement>('.zen-v2-dialog[role="dialog"]')!
    expect(card).not.toBeNull()
    expect(sheets()).toEqual([])
    expect(card.querySelector('.zen-v2-title-block')).not.toBeNull()
    expect(card.querySelector('.zen-phone-form')).toBeNull()
  })
})

describe('no frame dialog keeps a floating-card phone pose', () => {
  it('no component under src/renderer/src/components aligns a dialog card to the frame’s bottom edge', () => {
    const rootDir = join(process.cwd(), 'src/renderer/src/components')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) {
          if (entry !== '__tests__') walk(path)
          continue
        }
        if (!/\.tsx?$/.test(entry)) continue
        const text = readFileSync(path, 'utf8')
        if (/self-end justify-self-stretch/.test(text) || /zen-bm-dialog[^'"`]*\bmx-2\b/.test(text))
          offenders.push(path)
      }
    }
    walk(rootDir)
    expect(offenders).toEqual([])
  })
})
