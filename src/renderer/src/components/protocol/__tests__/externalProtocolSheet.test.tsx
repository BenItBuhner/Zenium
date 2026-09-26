// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExternalProtocolRequest } from '@shared/types'
import { viewportStore } from '@renderer/lib/formFactor'
import { uiStore } from '@renderer/lib/ui'
import { ExternalProtocolLayer } from '../ExternalProtocolSheet'

/*
 * The external-protocol confirm's description (design language v2 §9.2, §9.23): "<site> wants to
 * open <object>" wraps to two lines and then ends in an ellipsis, on the phone's title block and
 * on the mouse panel alike, never the one-line `truncate` cut §9.23 names as the deviation the
 * Custom Tab's twin corrects; the row grows with the second line; the whole sentence is the
 * element's `title`. The title above it and the decoded address below it stay one line each.
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

beforeEach(() => {
  Object.assign(window, { zen: { invoke: async () => undefined, on: () => () => undefined } })
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
  })
})

describe('the mouse panel (a centred dialog)', () => {
  it('clamps the description to two lines with the sentence as its title, in a header row that grows from 56', async () => {
    render(<ExternalProtocolLayer />)
    act(() => uiStore.set({ externalProtocol: request }))
    await settle()

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.getAttribute('aria-label')).toBe(`Open in ${LONG_APP}?`)

    const description = dialog!.querySelector<HTMLElement>(`[title="${DESCRIPTION}"]`)
    expect(description).not.toBeNull()
    expect(description!.textContent).toBe(DESCRIPTION)
    const cls = classes(description)
    expect(cls).toContain('line-clamp-2')
    expect(cls).toContain('wrap-anywhere')
    expect(cls).not.toContain('truncate')

    // The header row: a minimum height, not a fixed one (§9.2 – the row grows with the line).
    const row = description!.closest('.flex.gap-3')
    expect(row).not.toBeNull()
    expect(classes(row)).toContain('min-h-14')
    expect(classes(row)).not.toContain('h-14')

    // The title in the row stays one line.
    const title = row!.querySelector('.font-semibold')
    expect(title?.textContent).toBe(`Open in ${LONG_APP}?`)
    expect(classes(title)).toContain('truncate')
  })
})
