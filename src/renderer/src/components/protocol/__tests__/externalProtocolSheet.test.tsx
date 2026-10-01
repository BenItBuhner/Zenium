// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExternalProtocolRequest } from '@shared/types'
import { dispatchBackEvent, topBackSurface } from '@renderer/lib/back'
import { viewportStore } from '@renderer/lib/formFactor'
import { FrameDialogHost } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'
import { ExternalProtocolLayer } from '../ExternalProtocolSheet'

/*
 * The external-protocol confirm's description (design language v2 §9.2, §9.23): "<site> wants to
 * open <object>" wraps to two lines and then ends in an ellipsis, on the phone's title block and
 * on the dialog alike, never the one-line `truncate` cut §9.23 names as the deviation the
 * Custom Tab's twin corrects; the row grows with the second line; the whole sentence is the
 * element's `title`. The title above it and the decoded address below it stay one line each.
 * The remember row's caption is one string on both chassis, "Without asking again" – the title
 * already names the app, so the caption never repeats it.
 *
 * The dialog (§9.36 as the lead amended it on #750; §9.23): on a tablet and under a mouse the
 * question is §9.20's `zen-v2-dialog` at the form width in the frame's dialog host, whose scrim
 * covers the frame alone (§9.5) – the scheme's glyph inline at the title's start, no tile; the
 * remember choice a checkbox row submitted with Open; Not now then Open as the primary, on the
 * shared `.zen-v2-button` whose height is the pointer's control token. The same pins run on the
 * tablet's finger and on the mouse host; the phone sheet's pins are the ones from before.
 *
 * Rendered for real in happy-dom, judged on the classes (happy-dom lays nothing out). The phone
 * sheet is given a layout to stand in – an 800 px layer, a 300 px sheet – as the chassis's own
 * suite does (bottomSheetLeave.test.tsx): at happy-dom's zero heights its travel is 0, so it
 * lands the moment it is presented and dismisses itself. Its frames are queued and never run:
 * the markup is judged where it mounts, no spring runs on in the background.
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

const LONG_SITE = 'a-very-long-subdomain.of-an-even-longer-company-name.example-company.co.uk'
const LONG_APP = 'An Application With A Very Long Name For Phone Calls'

const request: ExternalProtocolRequest = {
  requestId: 'r-long',
  url: 'tel:%2B1%20555%200100',
  scheme: 'tel',
  appName: LONG_APP,
  site: LONG_SITE,
  canRemember: true
}

const DESCRIPTION = `${LONG_SITE} wants to open a phone number`

let root: Root | null = null
let mount: HTMLElement | null = null

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

const classes = (el: Element | null): string[] => (el?.getAttribute('class') ?? '').split(/\s+/)

/** The core's commands as the chrome runs them (`run` → `window.zen.invoke`). */
let invoke = vi.fn<(name: string, args: unknown) => Promise<unknown>>()

/** The dialog in the frame's host while it stands; one on its way out is `data-leaving`. */
const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    '.zen-frame-dialogs-slot > [role="dialog"][data-external-protocol]:not([data-leaving])'
  )

const click = (el: Element | null): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The layer with the frame's dialog host beside it, as TabDialogs mounts the host. */
const layer = (): ReactElement => (
  <>
    <FrameDialogHost frame />
    <ExternalProtocolLayer />
  </>
)

beforeEach(() => {
  invoke = vi.fn(async () => undefined)
  Object.assign(window, { zen: { invoke, on: () => () => undefined } })
})

afterEach(() => {
  act(() => uiStore.set({ externalProtocol: null }))
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
  viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' })
})

describe('the phone sheet (a title block, §9.23)', () => {
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

  it('clamps the description to two lines with the sentence as its title, the title and the address one line each', async () => {
    render(<ExternalProtocolLayer />)
    act(() => uiStore.set({ externalProtocol: request }))
    await settle()

    const block = document.querySelector('.zen-sheet-title-block')
    expect(block).not.toBeNull()
    const description = block!.querySelector('p')
    expect(description).not.toBeNull()
    expect(description!.textContent).toBe(DESCRIPTION)
    expect(description!.getAttribute('title')).toBe(DESCRIPTION)
    const cls = classes(description)
    expect(cls).toContain('line-clamp-2')
    expect(cls).toContain('wrap-anywhere')
    expect(cls).not.toContain('truncate')

    // The title stays one line, its text the app's name whole.
    const title = block!.querySelector('h2 span')
    expect(title?.textContent).toBe(`Open in ${LONG_APP}?`)
    expect(classes(title)).toContain('truncate')

    // The decoded address under the block is one line too (§9.23), the raw address its title.
    const address = document.querySelector<HTMLElement>('[title="tel:%2B1%20555%200100"]')
    expect(address).not.toBeNull()
    expect(address!.textContent).toBe('tel:+1 555 0100')
    expect(classes(address)).toContain('truncate')
    expect(classes(address)).not.toContain('line-clamp-2')

    // The remember row's caption: one string, the app named by the title alone.
    const caption = document.querySelector('.zen-sheet-item-secondary')
    expect(caption?.textContent).toBe('Without asking again')
  })
})

describe("which host draws the question (v2 §9.36 as read on #727: the split is the form factor's)", () => {
  beforeEach(() => {
    giveLayout()
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    takeLayoutBack()
  })

  it("the phone's finger gets the sheet, on its own chassis – nothing in the frame's host", async () => {
    viewportStore.set({ ...viewportStore.get(), coarse: true, formFactor: 'phone' })
    render(layer())
    act(() => uiStore.set({ externalProtocol: request }))
    await settle()
    expect(document.querySelector('.zen-sheet')).not.toBeNull()
    expect(dialog()).toBeNull()
    expect(document.querySelector('.zen-frame-dialogs [role="dialog"]')).toBeNull()
  })

  it("a tablet's finger gets the dialog in the frame's host (§9.36 amended) – never the sheet", async () => {
    viewportStore.set({ ...viewportStore.get(), coarse: true, formFactor: 'tablet' })
    render(layer())
    act(() => uiStore.set({ externalProtocol: request }))
    await settle()
    expect(dialog()).not.toBeNull()
    expect(document.querySelector('.zen-sheet')).toBeNull()
  })

  it('a mouse on the tablet layout (DeX, a trackpad) gets the dialog too', async () => {
    viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'tablet' })
    render(layer())
    act(() => uiStore.set({ externalProtocol: request }))
    await settle()
    expect(dialog()).not.toBeNull()
    expect(document.querySelector('.zen-sheet')).toBeNull()
  })

  it('the desktop gets the dialog', async () => {
    viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' })
    render(layer())
    act(() => uiStore.set({ externalProtocol: request }))
    await settle()
    expect(dialog()).not.toBeNull()
    expect(document.querySelector('.zen-sheet')).toBeNull()
  })
})

/**
 * The dialog's composition (§9.36 amended, §9.23, §9.11, §9.5), one set of pins run on the
 * tablet's finger and on the mouse host: the chassis and the markup are the same on both, the
 * sizes the tokens' – `--v2-control` for the pair (40 under a finger, 32 at a mouse),
 * `--v2-icon` for the glyph (20 / 16), `--v2-checkbox` for the box (20 / 16) – which happy-dom
 * does not compute; the stills on #750 measure them.
 */
describe.each([
  ['the tablet (a finger)', { coarse: true, formFactor: 'tablet' as const }],
  ['the mouse host (the desktop)', { coarse: false, formFactor: 'desktop' as const }]
])('the dialog on %s', (_host, viewport) => {
  beforeEach(() => {
    viewportStore.set({ ...viewportStore.get(), ...viewport })
    render(layer())
    act(() => uiStore.set({ externalProtocol: request }))
  })

  it("is §9.20's zen-v2-dialog at the form width in the frame's host, over the host's scrim alone (§9.5) – no fixed layer, no sheet scrim", async () => {
    await settle()
    const d = dialog()!
    expect(d).not.toBeNull()
    expect(classes(d)).toEqual(
      expect.arrayContaining(['zen-v2', 'zen-v2-dialog', 'zen-animate-pop'])
    )
    expect(classes(d)).not.toContain('zen-panel')
    expect(d.style.width).toBe('400px')
    expect(d.getAttribute('aria-modal')).toBe('true')
    // The host's scrim – the frame's, drawn by `FrameDialogHost` – and none of the dialog's own.
    expect(document.querySelector('.zen-frame-dialogs .zen-frame-scrim')).not.toBeNull()
    expect(document.querySelector('.zen-sheet-scrim')).toBeNull()
    expect(d.closest('.fixed')).toBeNull()
  })

  it('opens on a §9.23 title block: the glyph inline at the title’s start (no tile), the title one line, the sentence wrapping to two as the description – both named to the dialog', async () => {
    await settle()
    const d = dialog()!
    const block = d.firstElementChild!
    expect(classes(block)).toContain('zen-v2-title-block')
    const heading = block.querySelector('h2.zen-v2-title-block-title')!
    expect(heading).not.toBeNull()
    expect(d.getAttribute('aria-labelledby')).toBe(heading.id)
    // The glyph is the heading's first child, an svg hidden from the reader; no badge tile.
    const glyph = heading.firstElementChild!
    expect(glyph.tagName.toLowerCase()).toBe('svg')
    expect(glyph.getAttribute('aria-hidden')).toBe('true')
    expect(d.querySelector('.zen-sheet-badge')).toBeNull()
    expect(heading.textContent).toBe(`Open in ${LONG_APP}?`)
    expect(classes(heading.querySelector('.truncate'))).toContain('truncate')

    const description = block.querySelector('p.zen-v2-title-block-description')!
    expect(description).not.toBeNull()
    expect(d.getAttribute('aria-describedby')).toBe(description.id)
    expect(description.textContent).toBe(DESCRIPTION)
    const sentence = description.querySelector<HTMLElement>(`[title="${DESCRIPTION}"]`)!
    expect(sentence).not.toBeNull()
    const cls = classes(sentence)
    expect(cls).toContain('line-clamp-2')
    expect(cls).toContain('wrap-anywhere')
    expect(cls).not.toContain('truncate')
  })

  it('shows the decoded address 13 at 69 % on one line under the block, the raw address its title – the size the small-text token, not a literal', async () => {
    await settle()
    const address = dialog()!.querySelector<HTMLElement>('[title="tel:%2B1%20555%200100"]')!
    expect(address).not.toBeNull()
    expect(address.textContent).toBe('tel:+1 555 0100')
    const cls = classes(address)
    expect(cls).toEqual(
      expect.arrayContaining([
        'truncate',
        'text-[length:var(--v2-font-small)]',
        'leading-[var(--v2-line-small)]',
        'text-[var(--v2-text-deemphasized)]'
      ])
    )
    expect(cls).not.toContain('text-[13px]')
    expect(cls).not.toContain('line-clamp-2')
  })

  it('remembers the choice with a checkbox row (§9.23), not a switch; the caption the same one string as the phone’s', async () => {
    await settle()
    const d = dialog()!
    const row = d.querySelector<HTMLLabelElement>('label.zen-v2-row.zen-v2-check-row')!
    expect(row).not.toBeNull()
    const box = row.querySelector<HTMLInputElement>('input.zen-v2-checkbox[type="checkbox"]')!
    expect(box).not.toBeNull()
    expect(box.checked).toBe(false)
    expect(row.querySelector('.zen-v2-label')?.textContent).toBe('Always open phone numbers')
    expect(row.querySelector('.zen-v2-description')?.textContent).toBe('Without asking again')
    expect(d.querySelector('[role="switch"]')).toBeNull()
    expect(d.querySelector('.zen-sheet-item')).toBeNull()
  })

  it('ends in the §9.11 pair on the shared button – Not now, then Open as the primary – and submits the box with Open', async () => {
    await settle()
    const d = dialog()!
    const footer = d.querySelector('.justify-end')!
    const buttons = [...footer.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Not now', 'Open'])
    for (const b of buttons) expect(classes(b)).toContain('zen-v2-button')
    const [notNow, open] = buttons
    expect(notNow!.hasAttribute('data-primary')).toBe(false)
    expect(open!.hasAttribute('data-primary')).toBe(true)
    expect(open!.hasAttribute('data-accept')).toBe(true)
    // Focus lands on Open (§9.22).
    expect(document.activeElement).toBe(open)

    const box = d.querySelector<HTMLInputElement>('input.zen-v2-checkbox')!
    click(box)
    expect(box.checked).toBe(true)
    click(open!)
    expect(invoke).toHaveBeenCalledWith('externalProtocol.respond', {
      requestId: 'r-long',
      allow: true,
      always: true
    })
    expect(uiStore.get().externalProtocol).toBeNull()
  })

  it('Not now, Escape and a press on the host’s scrim each refuse the request, remembering nothing', async () => {
    await settle()
    // The answer gives the focus back to the page after it (`focus.content`): the respond
    // command is judged among the calls, each step on a cleared mock.
    invoke.mockClear()
    click(dialog()!.querySelector('.justify-end button'))
    expect(invoke).toHaveBeenCalledWith('externalProtocol.respond', {
      requestId: 'r-long',
      allow: false,
      always: false
    })

    act(() => uiStore.set({ externalProtocol: { ...request, requestId: 'r-escape' } }))
    await settle()
    expect(dialog()).not.toBeNull()
    invoke.mockClear()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(invoke).toHaveBeenCalledWith('externalProtocol.respond', {
      requestId: 'r-escape',
      allow: false,
      always: false
    })

    act(() => uiStore.set({ externalProtocol: { ...request, requestId: 'r-scrim' } }))
    await settle()
    expect(dialog()).not.toBeNull()
    invoke.mockClear()
    act(() => {
      document
        .querySelector('.zen-frame-scrim')!
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(invoke).toHaveBeenCalledWith('externalProtocol.respond', {
      requestId: 'r-scrim',
      allow: false,
      always: false
    })
    expect(uiStore.get().externalProtocol).toBeNull()
  })

  // The dialog is the back registry's top surface while it stands (a modal is outside the
  // popover registry, so without a surface of its own the system back would fall to the legacy
  // chain and run `tab.back` on the page behind it): a back commit is "not now".
  it('the system back refuses the request, remembering nothing – the dialog is the back registry’s top surface', async () => {
    await settle()
    expect(dialog()).not.toBeNull()
    expect(topBackSurface()?.name).toBe('external-protocol')
    invoke.mockClear()
    act(() => {
      expect(dispatchBackEvent('commit')).toBe(true)
    })
    expect(invoke).toHaveBeenCalledWith('externalProtocol.respond', {
      requestId: 'r-long',
      allow: false,
      always: false
    })
    expect(uiStore.get().externalProtocol).toBeNull()
    expect(dialog()).toBeNull()
    expect(topBackSurface()).toBeNull()
  })
})
