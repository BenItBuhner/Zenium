// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  createRef,
  useState,
  type JSX,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { chromeInertHeld } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'

/*
 * The keyboard side of the sheet chassis (design language v2 draft §9.22, §9.24): focus lands
 * inside a `BottomSheet` as it opens, Tab wraps inside it, the chrome behind the scrim is inert
 * while it is up, focus goes back to the opener when it has gone, and of two stacked sheets only
 * the top one holds the focus. Plus the keyboard-relative detents: the peek stands above the
 * bottom inset, and a focused field is kept above the keys. Rendered for real in happy-dom, the
 * frame loop cranked by hand, the layout given sizes (happy-dom lays nothing out).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
}

const frames = new Frames()
let root: Root | null = null
let mount: HTMLElement | null = null
/** The phone shell's chrome, as PhoneShell marks it, with a control a sheet can be opened from. */
let chrome: HTMLElement
let opener: HTMLButtonElement

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

function rerender(el: ReactElement): void {
  act(() => root!.render(el))
}

/** The sheet's dialog elements, lowest first. */
const sheets = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.zen-sheet')]
const active = (): Element | null => document.activeElement
const byText = (text: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === text)!
/** A key press as the WebView delivers it: on the focused element, up through the window. */
const key = (name: string, shift = false): boolean =>
  (active() ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: name, shiftKey: shift, bubbles: true, cancelable: true })
  )
/** Run the frames until the spring has settled and the sheet reports its dismissal. */
const dismissAndSettle = (handle: BottomSheetHandle): void => {
  act(() => handle.dismiss())
  act(() => frames.run(120))
}

beforeEach(() => {
  frames.install()
  // The layer is 800 px tall and a sheet's content 300 px: an expanded detent above the peek.
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
  chrome = document.createElement('nav')
  chrome.dataset.windowChrome = ''
  opener = document.createElement('button')
  opener.textContent = 'Menu'
  chrome.appendChild(opener)
  document.body.appendChild(chrome)
  opener.focus()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  chrome.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  act(() => uiStore.set({ insets: { top: 0, right: 0, bottom: 0, left: 0 } }))
  frames.now = 0
})

/** A surface: its sheet mounts when `open` turns true, and is gone once the sheet reports its dismissal. */
function Surface({
  open,
  onClosed,
  handle,
  children,
  contentKey
}: {
  open: boolean
  onClosed?: () => void
  handle?: RefObject<BottomSheetHandle | null>
  children: ReactNode
  contentKey?: string
}): JSX.Element | null {
  const [up, setUp] = useState(open)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setUp(true)
  }
  if (!up) return null
  return (
    <BottomSheet
      ref={handle}
      contentKey={contentKey}
      onDismissed={() => {
        setUp(false)
        onClosed?.()
      }}
    >
      {children}
    </BottomSheet>
  )
}

const rows = (...labels: string[]): JSX.Element => (
  <ul>
    {labels.map((label) => (
      <li key={label}>
        <button type="button" className="zen-sheet-item">
          {label}
        </button>
      </li>
    ))}
  </ul>
)

describe('focus moves into the sheet as it opens (§9.22)', () => {
  it('lands on the first row, not on the grabber', () => {
    render(<BottomSheet onDismissed={() => undefined}>{rows('Copy', 'Share')}</BottomSheet>)
    expect(active()).toBe(byText('Copy'))
    expect(sheets()[0].contains(active())).toBe(true)
  })

  it('lands on the checked option of a picker', () => {
    render(
      <BottomSheet onDismissed={() => undefined}>
        <div role="listbox">
          <button type="button" role="option" aria-selected={false}>
            Small
          </button>
          <button type="button" role="option" aria-selected={true}>
            Medium
          </button>
          <button type="button" role="option" aria-selected={false}>
            Large
          </button>
        </div>
      </BottomSheet>
    )
    expect(active()).toBe(byText('Medium'))
  })

  it('lands on the row that holds the checked radio', () => {
    render(
      <BottomSheet onDismissed={() => undefined}>
        <label>
          <input type="radio" name="s" /> Off
        </label>
        <label>
          <input type="radio" name="s" defaultChecked /> On
        </label>
      </BottomSheet>
    )
    const on = document.querySelectorAll('input')[1]
    expect(active()).toBe(on)
  })

  it("skips a text field – the keyboard must not come up with the sheet – and takes the form's Cancel", () => {
    render(
      <BottomSheet onDismissed={() => undefined}>
        <input aria-label="Name" />
        <textarea aria-label="Notes" />
        <div className="zen-sheet-footer">
          <button type="button">Cancel</button>
          <button type="button" data-primary>
            Save
          </button>
        </div>
      </BottomSheet>
    )
    expect(active()).toBe(byText('Cancel'))
  })

  it('with nothing focusable in the body, takes a header control, else the dialog itself', () => {
    render(
      <BottomSheet
        onDismissed={() => undefined}
        header={
          <button type="button" className="zen-sheet-header-control">
            Back
          </button>
        }
      >
        <p>A notice.</p>
      </BottomSheet>
    )
    expect(active()).toBe(byText('Back'))
    if (root) act(() => root!.unmount())
    root = null

    opener.focus()
    render(
      <BottomSheet onDismissed={() => undefined}>
        <p>A notice.</p>
      </BottomSheet>
    )
    expect(active()).toBe(sheets()[0])
    expect(sheets()[0].getAttribute('role')).toBe('dialog')
  })

  it('moves in again when the content is swapped from under it, and leaves focus a surface placed', () => {
    render(
      <Surface open contentKey="main">
        {rows('Copy', 'More…')}
      </Surface>
    )
    expect(active()).toBe(byText('Copy'))
    // Into a submenu: the rows that had the focus are gone.
    rerender(
      <Surface open contentKey="more">
        {rows('Rename', 'Delete')}
      </Surface>
    )
    expect(active()).toBe(byText('Rename'))
    // The surface put the focus on the dialog itself (a form); a swap leaves it there.
    act(() => sheets()[0].focus())
    rerender(
      <Surface open contentKey="form">
        {rows('Cancel', 'Save')}
      </Surface>
    )
    expect(active()).toBe(sheets()[0])
  })
})

describe('Tab wraps inside the sheet (§9.22)', () => {
  it('cycles from the last control to the grabber and back, never out of the sheet', () => {
    render(<BottomSheet onDismissed={() => undefined}>{rows('Copy', 'Share')}</BottomSheet>)
    const grabber = document.querySelector<HTMLElement>('.zen-sheet-handle-hit')!
    act(() => byText('Share').focus())
    expect(key('Tab')).toBe(false)
    expect(active()).toBe(grabber)
    expect(key('Tab', true)).toBe(false)
    expect(active()).toBe(byText('Share'))
    // A step within the sheet is the browser's.
    act(() => byText('Copy').focus())
    expect(key('Tab')).toBe(true)
    expect(active()).toBe(byText('Copy'))
  })
})

describe('the chrome behind the scrim is inert (§9.22, one mechanism with the frame dialog host)', () => {
  it('holds the chrome inert from mount and lets it go when the sheet has gone', () => {
    const handle = createRef<BottomSheetHandle>()
    const onClosed = vi.fn()
    render(
      <Surface open handle={handle} onClosed={onClosed}>
        {rows('Copy')}
      </Surface>
    )
    expect(chrome.hasAttribute('inert')).toBe(true)
    expect(chromeInertHeld()).toBe(true)
    dismissAndSettle(handle.current!)
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(sheets()).toHaveLength(0)
    expect(chrome.hasAttribute('inert')).toBe(false)
    expect(chromeInertHeld()).toBe(false)
  })
})

describe('focus returns to the opener (§9.22, §9.24)', () => {
  it('goes back to the control that opened the sheet once the sheet is gone, the chrome live again', () => {
    const handle = createRef<BottomSheetHandle>()
    render(
      <Surface open handle={handle}>
        {rows('Copy')}
      </Surface>
    )
    expect(active()).toBe(byText('Copy'))
    dismissAndSettle(handle.current!)
    expect(active()).toBe(opener)
  })

  it('leaves focus where a picked action put it', () => {
    const handle = createRef<BottomSheetHandle>()
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    render(
      <Surface open handle={handle}>
        {rows('Copy')}
      </Surface>
    )
    act(() => handle.current!.dismiss(() => elsewhere.focus()))
    act(() => frames.run(120))
    expect(active()).toBe(elsewhere)
    elsewhere.remove()
  })
})

describe('a stack holds the focus on top only (§9.24)', () => {
  it('the upper sheet takes the focus and the lower goes inert; the lower gets both back when the upper leaves', () => {
    const lower = createRef<BottomSheetHandle>()
    const upper = createRef<BottomSheetHandle>()
    const both = (second: boolean): ReactElement => (
      <>
        <Surface open handle={lower}>
          {rows('Font size', 'Theme')}
        </Surface>
        <Surface open={second} handle={upper}>
          {rows('Small', 'Large')}
        </Surface>
      </>
    )
    render(both(false))
    expect(active()).toBe(byText('Font size'))
    // A tap on the row that opens the picker gives it the focus.
    act(() => byText('Theme').focus())
    rerender(both(true))
    const [a, b] = sheets()
    expect(active()).toBe(byText('Small'))
    expect(a.hasAttribute('inert')).toBe(true)
    expect(b.hasAttribute('inert')).toBe(false)
    expect(chrome.hasAttribute('inert')).toBe(true)
    // Tab cycles within the top sheet only.
    act(() => byText('Large').focus())
    key('Tab')
    expect(b.contains(active())).toBe(true)
    expect(a.contains(active())).toBe(false)

    dismissAndSettle(upper.current!)
    expect(sheets()).toHaveLength(1)
    expect(a.hasAttribute('inert')).toBe(false)
    expect(active()).toBe(byText('Theme'))
    // The lower sheet still stands: the chrome stays inert until it, too, has gone.
    expect(chrome.hasAttribute('inert')).toBe(true)
    dismissAndSettle(lower.current!)
    expect(chrome.hasAttribute('inert')).toBe(false)
    expect(active()).toBe(opener)
  })
})

/** A box `top` px down the layer and `height` tall, as `getBoundingClientRect` reports it. */
const box = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 400, width: 400, height, x: 0, y: top }) as DOMRect

/** The keyboard came up: the host reports its height as the bottom inset. */
const keyboard = (height: number): void => {
  act(() => uiStore.set((s) => ({ insets: { ...s.insets, bottom: height } })))
}

describe('keyboard-relative detents', () => {
  it('with the keyboard up the peek moves above the keys', () => {
    // A form 1000 px tall on the 800 px layer: a peek at 416 and an expanded detent at 760.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 1000
    })
    render(<BottomSheet onDismissed={() => undefined}>form</BottomSheet>)
    act(() => frames.run(60))
    const sheet = sheets()[0]
    expect(sheet.style.height).toBe('416px')

    // 300 px of keyboard: the peek is 300 + .52 × 500 = 560, the same share of the room above it.
    keyboard(300)
    act(() => frames.run(60))
    expect(sheet.style.height).toBe('560px')

    // The keyboard goes: the peek is where it was.
    keyboard(0)
    act(() => frames.run(60))
    expect(sheet.style.height).toBe('416px')
  })

  it('a focused field is kept above the keys: the sheet expands for it, and the body scrolls the rest', () => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 1000
    })
    render(
      <BottomSheet onDismissed={() => undefined}>
        <input aria-label="Name" />
        <input aria-label="Address" />
      </BottomSheet>
    )
    act(() => frames.run(60))
    const sheet = sheets()[0]
    const [name, address] = document.querySelectorAll('input')
    const body = document.querySelector<HTMLElement>('.zen-sheet-scroll')!
    // happy-dom lays nothing out: the sheet stands at the bottom of the layer, the Name field
    // 380 px and the Address field 700 px down from its top edge.
    const boxes = new Map<Element, DOMRect>([
      [sheet, box(384, 416)],
      [name, box(384 + 380 - 24, 24)],
      [address, box(384 + 700 - 24, 24)]
    ])
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      return boxes.get(this) ?? box(0, 0)
    })

    // In view at the peek (416 − 8 of room): focus alone moves nothing.
    act(() => name.focus())
    expect(active()).toBe(name)
    act(() => frames.run(60))
    expect(sheet.style.height).toBe('416px')
    expect(body.scrollTop).toBe(0)

    // The keyboard comes up: at the new peek (560) the room above the keys is 252 px and the
    // field at 380 would sit under them, so the sheet expands to 760 (452 px of room) …
    keyboard(300)
    act(() => frames.run(60))
    expect(sheet.style.height).toBe('760px')
    expect(body.scrollTop).toBe(0)

    // … and the next field, 700 px down, is scrolled the rest of the way: 700 − 452 = 248.
    act(() => address.focus())
    expect(body.scrollTop).toBe(248)
    act(() => frames.run(60))
    expect(sheet.style.height).toBe('760px')
  })
})
