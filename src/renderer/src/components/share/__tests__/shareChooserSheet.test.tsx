// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ShareChooser } from '@shared/shareTarget'
import { viewportStore } from '@renderer/lib/formFactor'
import { uiStore } from '@renderer/lib/ui'
import { ShareChooserLayer } from '../ShareChooserSheet'

/*
 * The share chooser (MW-63): a §9.13 sheet whose header is the shared thing – a link on the
 * §9.31 link header, text on the share panel's read-only twin of it – then the house route
 * first ("Open in a new tab" for a link, "Search" for text) and a group headed "Apps": one row
 * per installed app declaring a target, its icon at 20 and its name, no verb. The pick and the
 * dismissal each answer the core once. Rendered for real in happy-dom, judged on the markup;
 * the phone sheet is given a layout to stand in, as the external-protocol sheet's suite does.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SIZE_PROPS = ['clientHeight', 'offsetHeight'] as const
const originalSizes = new Map<string, PropertyDescriptor | undefined>()

function giveLayout(): void {
  for (const prop of SIZE_PROPS)
    originalSizes.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop))
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
}

function takeLayoutBack(): void {
  for (const prop of SIZE_PROPS) {
    const original = originalSizes.get(prop)
    if (original) Object.defineProperty(HTMLElement.prototype, prop, original)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
  }
}

const LINK: ShareChooser = {
  requestId: 'share-1',
  kind: 'url',
  link: {
    url: 'https://news.example/story?id=7',
    copied: 'Link copied',
    title: 'A story',
    favicon: null,
    thumbnail: null,
    scheme: null
  },
  text: null,
  apps: [
    { id: 'https://app.example/', name: 'Sketch', icon: 'https://app.example/icon.png' },
    { id: 'https://notes.example/', name: 'Notes', icon: null }
  ]
}

const TEXT: ShareChooser = {
  requestId: 'share-2',
  kind: 'text',
  link: null,
  text: 'how do springs work',
  apps: [{ id: 'https://notes.example/', name: 'Notes', icon: null }]
}

let root: Root | null = null
let mount: HTMLElement | null = null
let invoked: Array<{ channel: string; args: unknown }> = []

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
  })
}

const rows = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll('button.zen-sheet-item'))
const label = (row: Element): string => row.querySelector('.flex-1')?.textContent ?? ''
/** The chooser's own answers to the core (the focus's return to the page rides along). */
const answers = (): Array<{ channel: string; args: unknown }> =>
  invoked.filter((i) => i.channel.startsWith('share.'))

beforeEach(() => {
  invoked = []
  Object.assign(window, {
    zen: {
      invoke: async (channel: string, args: unknown) => {
        invoked.push({ channel, args })
        return undefined
      },
      on: () => () => undefined
    }
  })
})

afterEach(() => {
  act(() => uiStore.set({ shareChooser: null }))
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
  viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' })
})

describe('the phone sheet', () => {
  beforeEach(() => {
    giveLayout()
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    viewportStore.set({ ...viewportStore.get(), coarse: true, formFactor: 'phone' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    takeLayoutBack()
  })

  it("opens a shared link on the link menu's header, the house row first, then the apps under Apps – icon and name, no verb", async () => {
    render(<ShareChooserLayer />)
    act(() => uiStore.set({ shareChooser: LINK }))
    await settle()

    // The header is the shared thing: the §9.31 link header, its title naming the sheet.
    const header = document.querySelector('.zen-menu-link-header')
    expect(header).not.toBeNull()
    expect(header!.querySelector('.zen-menu-link-title')?.textContent).toBe('A story')
    expect(header!.querySelector('.zen-menu-link-url')?.textContent).toBe(
      'https://news.example/story?id=7'
    )
    const sheet = document.querySelector('[aria-labelledby]')
    expect(sheet?.getAttribute('aria-labelledby')).toBe(
      header!.querySelector('.zen-menu-link-title')?.id
    )

    // The rows: the house route first, then one per app.
    const all = rows()
    expect(all.map(label)).toEqual(['Open in a new tab', 'Sketch', 'Notes'])
    expect(all[0].dataset.route).toBe('house')

    // The group heading between them, an h3 of the sheet's group class, naming the apps' list.
    const heading = document.querySelector('h3.zen-sheet-heading')
    expect(heading?.textContent).toBe('Apps')
    const list = document.querySelector(`ul[aria-labelledby="${heading!.id}"]`)
    expect(list).not.toBeNull()
    expect(list!.querySelectorAll('button.zen-sheet-item')).toHaveLength(2)
    expect(all[0].compareDocumentPosition(heading!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // An app's row: its icon in the 20 leading slot – the image when it has one, the letter
    // tile when not – and its name as the row's whole text.
    const sketch = all[1]
    expect(sketch.dataset.app).toBe('https://app.example/')
    const glyph = sketch.querySelector('.zen-sheet-item-glyph')
    expect(glyph).not.toBeNull()
    const icon = glyph!.querySelector<HTMLElement>('.zen-install-icon')
    expect(icon?.style.width).toBe('20px')
    expect(icon?.style.height).toBe('20px')
    expect(icon?.querySelector('img')?.getAttribute('src')).toBe('https://app.example/icon.png')
    expect(sketch.textContent).toBe('Sketch')
    const notes = all[2]
    const tile = notes.querySelector<HTMLElement>('.zen-install-icon[data-letter]')
    expect(tile?.textContent).toBe('N')
    expect(notes.textContent).toBe('NNotes')
    expect(notes.querySelector('.flex-1')?.textContent).toBe('Notes')
  })

  it('opens shared text on the read-only header with Search as the house row', async () => {
    render(<ShareChooserLayer />)
    act(() => uiStore.set({ shareChooser: TEXT }))
    await settle()

    const header = document.querySelector('.zen-menu-link-header')
    expect(header?.getAttribute('data-kind')).toBe('text')
    expect(header?.tagName).toBe('DIV')
    expect(header?.querySelector('.zen-menu-link-title')?.textContent).toBe('how do springs work')
    expect(header?.querySelector('.zen-menu-link-url')).toBeNull()
    expect(rows().map(label)).toEqual(['Search', 'Notes'])
  })
})

describe('the tablet and mouse dialog', () => {
  it('is a centred dialog named by the header, with the same rows, answering the core on a pick', async () => {
    viewportStore.set({ ...viewportStore.get(), coarse: true, formFactor: 'tablet' })
    render(<ShareChooserLayer />)
    act(() => uiStore.set({ shareChooser: LINK }))
    await settle()

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(document.querySelector('.zen-sheet')).toBeNull()
    const title = dialog!.querySelector('.zen-menu-link-title')
    expect(dialog!.getAttribute('aria-labelledby')).toBe(title?.id)
    expect(rows().map(label)).toEqual(['Open in a new tab', 'Sketch', 'Notes'])
    expect(dialog!.querySelector('h3.zen-sheet-heading')?.textContent).toBe('Apps')

    act(() => rows()[1].click())
    expect(answers()).toEqual([
      {
        channel: 'share.chooserPick',
        args: { requestId: 'share-1', appId: 'https://app.example/' }
      }
    ])
    expect(uiStore.get().shareChooser).toBeNull()
  })

  it('the house row picks no app; the scrim dismisses, which drops the share', async () => {
    render(<ShareChooserLayer />)
    act(() => uiStore.set({ shareChooser: TEXT }))
    await settle()
    act(() => rows()[0].click())
    expect(answers()).toEqual([
      { channel: 'share.chooserPick', args: { requestId: 'share-2', appId: null } }
    ])

    invoked = []
    act(() => uiStore.set({ shareChooser: LINK }))
    await settle()
    act(() => document.querySelector<HTMLElement>('.zen-sheet-scrim')!.click())
    expect(answers()).toEqual([{ channel: 'share.chooserCancel', args: { requestId: 'share-1' } }])
    expect(uiStore.get().shareChooser).toBeNull()
  })
})
