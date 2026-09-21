// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PhoneSheet, type SheetTitle } from '../PhoneSheet'
import { FrameDialogHost } from '@renderer/lib/portals'
import { viewportStore } from '@renderer/lib/formFactor'

/*
 * `PhoneSheet`'s two title poses (design language v2 draft §9.16, §9.23), the consumer's choice
 * through `title.pose`: the centred 48 header for a sheet of rows or a form, drawn in the
 * chassis's `header` slot with its 44 px control slots; the start-aligned title block for a
 * prompt, the first content of the body with the glyph on the title's start and the description
 * under it. A description belongs to the block alone: the header pose refuses one. Rendered for
 * real in happy-dom on the frame's dialog host, as the consumers place it.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null
/** What a render threw past React, if anything (React reports it instead of rethrowing). */
let thrown: unknown = null

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount, {
    onUncaughtError: (error) => {
      thrown = error
    }
  })
  act(() => root!.render(el))
}

const sheet = (title: SheetTitle): ReactElement => (
  <>
    <FrameDialogHost frame />
    <PhoneSheet name="test" title={title} focus="first" onClose={() => undefined}>
      <div className="zen-sheet-footer">
        <button type="button" className="zen-v2-button">
          Cancel
        </button>
      </div>
    </PhoneSheet>
  </>
)

const dialog = (): HTMLElement => document.querySelector<HTMLElement>('.zen-sheet[role="dialog"]')!
const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)

beforeEach(() => {
  thrown = null
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
})

describe('the header pose (§9.16)', () => {
  it('draws the title centred in the chassis header, its controls in the 44 px slots, no title block', () => {
    render(
      sheet({
        pose: 'header',
        text: 'Recently closed',
        leading: (
          <button type="button" className="zen-sheet-header-control" data-side="leading">
            Back
          </button>
        ),
        trailing: (
          <button type="button" className="zen-sheet-header-control" data-side="trailing">
            Edit
          </button>
        )
      })
    )
    expect(thrown).toBeNull()
    const header = q<HTMLElement>('.zen-sheet-header')!
    expect(header).not.toBeNull()
    // The header is the grip's, above the scrolling body, so the scrolled hairline is its own.
    expect(header.closest('[data-sheet-grip]')).not.toBeNull()
    const title = header.querySelector<HTMLElement>('h2.zen-sheet-title')!
    expect(title.textContent).toBe('Recently closed')
    expect(dialog().getAttribute('aria-labelledby')).toBe(title.id)
    expect(header.querySelector('[data-side="leading"]')?.textContent).toBe('Back')
    expect(header.querySelector('[data-side="trailing"]')?.textContent).toBe('Edit')
    expect(q('.zen-sheet-title-block')).toBeNull()
    // The body is the consumer's alone.
    expect(q('.zen-sheet-scroll')!.querySelector('h2')).toBeNull()
  })

  it('refuses a description: that is the title block', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // Under `act` React rethrows the render's error; outside it, it reports it to the root.
    let error: unknown = null
    try {
      render(
        sheet({
          pose: 'header',
          text: 'Clear all history?',
          description: 'Every visit goes.'
        } as unknown as SheetTitle)
      )
    } catch (e) {
      error = e
    }
    error ??= thrown
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/title block/)
    expect(q('.zen-sheet-header')).toBeNull()
  })
})

describe('the title block pose (§9.23)', () => {
  it('opens the body on the title block – glyph, title, description – and leaves the header slot empty', () => {
    render(
      sheet({
        pose: 'block',
        text: 'Clear all history?',
        icon: <svg data-glyph aria-hidden />,
        description: '12 visits will be removed.'
      })
    )
    expect(thrown).toBeNull()
    expect(q('.zen-sheet-header')).toBeNull()
    const block = q<HTMLElement>('.zen-sheet-title-block')!
    expect(block).not.toBeNull()
    // The first content of the body (§9.23), before what the consumer draws.
    const body = q<HTMLElement>('.zen-sheet-scroll')!
    expect(body.contains(block)).toBe(true)
    expect(block.parentElement?.firstElementChild).toBe(block)
    expect(block.nextElementSibling?.classList.contains('zen-sheet-footer')).toBe(true)
    const title = block.querySelector<HTMLElement>('h2')!
    expect(title.firstElementChild?.hasAttribute('data-glyph')).toBe(true)
    expect(title.textContent).toBe('Clear all history?')
    expect(dialog().getAttribute('aria-labelledby')).toBe(title.id)
    expect(block.querySelector('p')?.textContent).toBe('12 visits will be removed.')
  })

  it('a block without a glyph keeps the title on the start, the description 4 under it', () => {
    render(
      sheet({
        pose: 'block',
        text: 'Make Zenium your default browser?',
        description: 'Links open here.'
      })
    )
    expect(thrown).toBeNull()
    const block = q<HTMLElement>('.zen-sheet-title-block')!
    expect(block.querySelector('h2 svg')).toBeNull()
    expect(block.querySelector('h2')?.textContent).toBe('Make Zenium your default browser?')
    expect(block.querySelector('p')?.textContent).toBe('Links open here.')
  })

  it('a prompt about Zenium itself carries the 48 px app icon above the block, no glyph on the title (§9.23)', () => {
    render(
      sheet({
        pose: 'block',
        text: 'Make Zenium your default browser',
        appIcon: <svg data-app-icon aria-hidden="true" />,
        description: 'Links from other apps open in Zenium.'
      })
    )
    expect(thrown).toBeNull()
    const block = q<HTMLElement>('.zen-sheet-title-block')!
    // The icon's box is the body's first content, the block straight after it: the desktop
    // prompt's order (the icon, then the title block), nothing between them.
    const icon = q<HTMLElement>('.zen-sheet-app-icon')!
    expect(icon).not.toBeNull()
    expect(icon.parentElement?.firstElementChild).toBe(icon)
    expect(icon.nextElementSibling).toBe(block)
    expect(icon.firstElementChild?.hasAttribute('data-app-icon')).toBe(true)
    expect(icon.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    // The block itself is the plain one: the title with no inline glyph.
    expect(block.querySelector('h2 svg')).toBeNull()
    expect(block.querySelector('h2')?.textContent).toBe('Make Zenium your default browser')
    expect(dialog().getAttribute('aria-labelledby')).toBe(block.querySelector('h2')!.id)
  })

  it('refuses an app icon beside a glyph: the icon stands in for it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let error: unknown = null
    try {
      render(
        sheet({
          pose: 'block',
          text: 'Make Zenium your default browser',
          icon: <svg data-glyph aria-hidden />,
          appIcon: <svg data-app-icon aria-hidden="true" />,
          description: 'Links from other apps open in Zenium.'
        })
      )
    } catch (e) {
      error = e
    }
    error ??= thrown
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/app icon/)
    expect(q('.zen-sheet-title-block')).toBeNull()
  })
})
