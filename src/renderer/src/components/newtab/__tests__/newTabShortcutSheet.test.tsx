// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NewTabShortcut, Tab, UIState } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import { viewportStore } from '@renderer/lib/formFactor'
import { FrameDialogHost } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'

/*
 * The new tab page's shortcut form on a phone (NTP-06; the #348 design gate's item 4): the form
 * sheet the Settings Address row opens – `SettingsSheet` on the `PhoneSheet` chassis (§9.16's
 * grip and 48 centred header naming the form, §9.12's labelled fields in the 16 gutter, §9.11's
 * Cancel | Save splitting the footer's width), the sheet itself focused as it opens (§9.22) –
 * where the desktop keeps its v2 dialog. Save slides the sheet away and writes the shortcut once
 * it has gone; a refused URL keeps the sheet up with the validation line under the field.
 * Rendered for real in happy-dom on the frame's dialog host, the sheet's spring cranked by hand.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: async () => null,
  onEvent: () => () => undefined
}))

const { NewTabShortcutDialog } = await import('../NewTabShortcutDialog')

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

const PINS: NewTabShortcut[] = [
  { id: 's-hn', title: 'Hacker News', url: 'https://news.ycombinator.com/' },
  { id: 's-b', title: 'B', url: 'https://b.example/' }
]

function state(): UIState {
  return {
    platform: 'android',
    tabs: { r: TAB },
    spaces: [{ id: 'space', activeTabId: 'r', tabIds: ['r'] }],
    activeSpaceId: 'space',
    essentialTabIds: [],
    settings: {},
    newTabShortcuts: PINS
  } as unknown as UIState
}

const EDIT = { tabId: 'r', id: 's-hn', title: 'Hacker News', url: 'https://news.ycombinator.com/' }
const ADD = { tabId: 'r', id: null, title: '', url: '' }

function render(el: ReactElement): void {
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
  })
}

/** Run the sheet's spring to rest. */
function rest(): void {
  for (let i = 0; i < 200 && frames.scheduled; i++) act(() => frames.run(1))
  expect(frames.scheduled).toBe(false)
}

/** As TabDialogs mounts it: the form while the store holds a request, gone when it clears. */
function Host(): ReactElement {
  const request = uiStore.use((s) => s.newTabShortcutDialog)
  return (
    <FrameDialogHost frame>
      {request && <NewTabShortcutDialog state={state()} request={request} />}
    </FrameDialogHost>
  )
}

const view = (request: typeof EDIT | typeof ADD): ReactElement => {
  uiStore.set({ newTabShortcutDialog: request })
  return <Host />
}

/** The shortcut commands run so far (the chassis's own `focus.content` as it leaves is not one). */
const written = (): unknown[][] =>
  run.mock.calls.filter(([name]) => String(name).startsWith('newtab.'))

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const sheet = (): HTMLElement | null => q('.zen-sheet[role="dialog"]')
const form = (): HTMLElement => q('[data-newtab-dialog]')!
const inputs = (): HTMLInputElement[] => [...form().querySelectorAll<HTMLInputElement>('input')]
const buttons = (): HTMLButtonElement[] => [
  ...form().querySelectorAll<HTMLButtonElement>('.zen-settings-sheet-actions > button')
]
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
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  uiStore.set({ newTabShortcutDialog: null })
  act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false }))
  vi.unstubAllGlobals()
  frames.now = 0
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

describe('the shortcut form on a phone (gate item 4: the Address sheet’s chassis)', () => {
  it('is a Settings form sheet: the 48 header names it, two labelled fields in the form, Cancel | Save splitting the footer, the sheet focused', async () => {
    render(view(EDIT))
    await settle()
    rest()
    const dialog = sheet()!
    expect(dialog).not.toBeNull()
    // The Address sheet's panel: the Settings class on the chassis, no desktop dialog anywhere.
    expect(dialog.classList.contains('zen-settings-sheet')).toBe(true)
    expect(q('.zen-bm-dialog')).toBeNull()
    // The grip's 48 header, the title centred in it, naming the dialog (§9.16).
    const title = dialog.querySelector<HTMLElement>('.zen-sheet-header h2.zen-sheet-title')!
    expect(title.textContent).toBe('Edit shortcut')
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    expect(dialog.querySelector('.zen-sheet-title-block')).toBeNull()
    // The form in the body: §9.12's field blocks, each label above its field, the driver's hook
    // on the form itself.
    const body = dialog.querySelector<HTMLElement>('.zen-settings-sheet-body')!
    const f = form()
    expect(body.contains(f)).toBe(true)
    expect(f.classList.contains('zen-settings-form')).toBe(true)
    expect(f.getAttribute('data-newtab-dialog')).toBe('edit')
    const blocks = [...f.querySelectorAll<HTMLElement>('.zen-settings-field-block')]
    expect(blocks.map((b) => b.querySelector('label')?.textContent)).toEqual(['Name', 'URL'])
    for (const block of blocks) {
      const label = block.querySelector<HTMLLabelElement>('label.zen-settings-label')!
      const input = block.querySelector<HTMLInputElement>('input')!
      expect(label.htmlFor).toBe(input.id)
      expect(input.classList.contains('zen-v2-field')).toBe(true)
    }
    const [name, url] = inputs()
    expect(name.value).toBe('Hacker News')
    expect(url.value).toBe('https://news.ycombinator.com/')
    expect(url.getAttribute('inputmode')).toBe('url')
    // Cancel | Save: the Settings footer actions, peers splitting the width, the primary trailing.
    const actions = buttons()
    expect(actions.map((b) => b.textContent)).toEqual(['Cancel', 'Save'])
    expect(actions[1].hasAttribute('data-primary')).toBe(true)
    expect(actions[1].disabled).toBe(false)
    expect(actions[1].closest('.zen-settings-sheet-actions')?.parentElement).toBe(f)
    // The sheet itself takes the focus (§9.22): a field never does on a phone.
    expect(document.activeElement).toBe(dialog)
  })

  it('Save slides the sheet away and writes the shortcut once it has gone; the request clears with it', async () => {
    render(view(EDIT))
    await settle()
    rest()
    type(inputs()[0], 'HN')
    click(buttons()[1])
    // Nothing yet: the commit waits for the sheet's motion, like a picked menu row.
    expect(written()).toEqual([])
    expect(uiStore.get().newTabShortcutDialog).toEqual(EDIT)
    rest()
    expect(written()).toEqual([
      ['newtab.updateShortcut', { id: 's-hn', title: 'HN', url: 'https://news.ycombinator.com/' }]
    ])
    expect(uiStore.get().newTabShortcutDialog).toBeNull()
    expect(sheet()).toBeNull()
  })

  it('a URL another shortcut has keeps the sheet up with §9.12’s validation line under the field and Save off', async () => {
    render(view(EDIT))
    await settle()
    rest()
    const [, url] = inputs()
    type(url, 'https://b.example/')
    click(buttons()[1])
    rest()
    expect(written()).toEqual([])
    expect(sheet()).not.toBeNull()
    const message = form().querySelector<HTMLElement>('.zen-settings-validation')!
    expect(message).not.toBeNull()
    expect(message.getAttribute('role')).toBe('alert')
    expect(message.closest('.zen-settings-field-block')).toBe(
      url.closest('.zen-settings-field-block')
    )
    expect(url.getAttribute('aria-invalid')).toBe('true')
    // The field names the line (`aria-describedby`), as the desktop dialog names its own.
    expect(message.id).not.toBe('')
    expect(url.getAttribute('aria-describedby')).toBe(message.id)
    expect(buttons()[1].disabled).toBe(true)
    // The value corrected, the line goes and Save is back.
    type(url, 'https://c.example/')
    expect(form().querySelector('.zen-settings-validation')).toBeNull()
    expect(url.getAttribute('aria-describedby')).toBeNull()
    expect(buttons()[1].disabled).toBe(false)
  })

  it('Cancel slides the sheet away and writes nothing', async () => {
    render(view(EDIT))
    await settle()
    rest()
    type(inputs()[0], 'Renamed')
    click(buttons()[0])
    rest()
    expect(written()).toEqual([])
    expect(uiStore.get().newTabShortcutDialog).toBeNull()
    expect(sheet()).toBeNull()
  })

  it('adding is the same sheet headed Add shortcut with Add as the primary, off until a URL is typed', async () => {
    render(view(ADD))
    await settle()
    rest()
    expect(sheet()!.querySelector('h2.zen-sheet-title')?.textContent).toBe('Add shortcut')
    expect(form().getAttribute('data-newtab-dialog')).toBe('add')
    expect(buttons().map((b) => b.textContent)).toEqual(['Cancel', 'Add'])
    expect(buttons()[1].disabled).toBe(true)
    type(inputs()[1], 'c.example')
    expect(buttons()[1].disabled).toBe(false)
    click(buttons()[1])
    rest()
    expect(written()).toEqual([['newtab.addShortcut', { title: '', url: 'c.example' }]])
  })
})

describe('the shortcut form on the desktop', () => {
  it('keeps its v2 dialog: title block, labelled fields, the footer’s Cancel and Save', async () => {
    act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false }))
    render(view(EDIT))
    await settle()
    const dialog = q<HTMLElement>('.zen-bm-dialog[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('data-newtab-dialog')).toBe('edit')
    expect(q('.zen-sheet')).toBeNull()
    expect(dialog.querySelector('.zen-bm-title')?.textContent).toBe('Edit shortcut')
    expect(
      [...dialog.querySelectorAll<HTMLElement>('label.zen-bm-label')].map((l) =>
        l.firstChild?.textContent?.trim()
      )
    ).toEqual(['Name', 'URL'])
    const footer = dialog.querySelector<HTMLElement>('.zen-bm-footer')!
    expect([...footer.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Cancel',
      'Save'
    ])
    // The name field takes the focus on the desktop (§9.22).
    expect(document.activeElement).toBe(dialog.querySelector('input'))
  })
})
