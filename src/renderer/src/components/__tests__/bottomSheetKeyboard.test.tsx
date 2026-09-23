// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  StrictMode,
  act,
  createRef,
  useState,
  type JSX,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PdfFitMode } from '@shared/pdfViewerProtocol'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneSheet } from '../phone/PhoneSheet'
import { PdfZoomSheet } from '../pdf/PdfSheets'
import { viewportStore } from '@renderer/lib/formFactor'
import {
  FrameDialogHost,
  FrameDialogPortal,
  chromeInertHeld,
  useFrameDialog
} from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'

/*
 * The keyboard side of the sheet chassis (design language v2 draft §9.22, §9.24): focus lands
 * inside a `BottomSheet` as it opens, Tab wraps inside it, the chrome behind the scrim is inert
 * while it is up, focus goes back to the opener when it has gone, and of two stacked sheets only
 * the top one holds the focus. Plus the keyboard-relative detents: the peek stands above the
 * bottom inset, and a focused field is kept above the keys. Rendered for real in happy-dom, the
 * frame loop cranked by hand, the layout given sizes (happy-dom lays nothing out), and `focus()`
 * given Chrome's rule (happy-dom focuses anything): a sheet waiting for the page's cover is held
 * at opacity 0, which takes the focus, never `visibility: hidden`, which would not.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The wait for the page's cover before a sheet comes up (`coverPageUnderSheet`, §11.5): resolved
 * at once with no page to cover – the module's own – unless a test holds it, as the phone does
 * while the live page gives way to its picture.
 */
const cover = vi.hoisted(() => ({
  pending: null as { promise: Promise<void>; resolve: () => void } | null
}))
vi.mock('@renderer/lib/ui', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@renderer/lib/ui')>()
  return {
    ...mod,
    coverPageUnderSheet: () =>
      cover.pending
        ? { promise: cover.pending.promise, release: () => undefined }
        : mod.coverPageUnderSheet()
  }
})

/**
 * Chrome's rule for `focus()`, which happy-dom lacks: an element that is not rendered visible –
 * `visibility: hidden` or `display: none` on it or on an ancestor – or that stands in an inert
 * subtree takes no focus; the call does nothing. The chassis moves the focus into a sheet as it
 * mounts, while the sheet may still be held for the page's cover: held `visibility: hidden` the
 * focus would land nowhere (the regression the review of #168 measured on the bookmark editor
 * and the clear-history prompt); held at opacity 0 it lands.
 */
function installChromeFocusRule(): void {
  const native = HTMLElement.prototype.focus
  const rendered = (target: HTMLElement): boolean => {
    for (let el: HTMLElement | null = target; el; el = el.parentElement) {
      if (
        el.style.visibility === 'hidden' ||
        el.style.display === 'none' ||
        el.hasAttribute('inert')
      )
        return false
    }
    return true
  }
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions
  ) {
    if (rendered(this)) native.call(this, options)
  })
}

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

/** Let the wait for the page's cover resolve (at once with no page) and the sheet come up. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/**
 * Hold the page's cover, as the phone does while the live page gives way to its picture: a
 * sheet mounted meanwhile waits at opacity 0. `resolve` lets it come up.
 */
function holdCover(): { resolve: () => Promise<void> } {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  cover.pending = { promise, resolve: release }
  return {
    resolve: async () => {
      cover.pending = null
      release()
      await settle()
    }
  }
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
  installChromeFocusRule()
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
  chrome.dataset.shellChrome = ''
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
  cover.pending = null
  act(() => uiStore.set({ insets: { top: 0, right: 0, bottom: 0, left: 0 } }))
  act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' }))
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

/**
 * A hosted sheet, as the Settings tab's pickers and sheets, `PhoneSheet`, the install and the
 * downloads sheets place theirs (components/pages/settings/sheets.tsx `HostedSheet`): through
 * `FrameDialogPortal` into the frame's dialog host, registered with it as a dialog that draws
 * its own scrim, the `BottomSheet` inside placed `hosted`. Its footer's Cancel dismisses it.
 */
function Hosted({
  open,
  handle,
  children,
  onClosed
}: {
  open: boolean
  handle: RefObject<BottomSheetHandle | null>
  children: ReactNode
  onClosed?: () => void
}): JSX.Element | null {
  const [up, setUp] = useState(open)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setUp(true)
  }
  if (!up) return null
  return (
    <FrameDialogPortal>
      <HostedBody
        handle={handle}
        onDismissed={() => {
          setUp(false)
          onClosed?.()
        }}
      >
        {children}
      </HostedBody>
    </FrameDialogPortal>
  )
}

function HostedBody({
  handle,
  onDismissed,
  children
}: {
  handle: RefObject<BottomSheetHandle | null>
  onDismissed: () => void
  children: ReactNode
}): JSX.Element {
  const dismiss = (): void => handle.current?.dismiss()
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  return (
    <div className="absolute inset-0" data-sheet-layer="true">
      <BottomSheet
        ref={handle}
        hosted
        onDismissed={onDismissed}
        footer={
          <button type="button" onClick={() => handle.current?.dismiss()}>
            Cancel
          </button>
        }
      >
        {children}
      </BottomSheet>
    </div>
  )
}

const press = (el: Element, type = 'pointerdown'): boolean =>
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0 }))
const scrims = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.zen-sheet-scrim')]
/** A tap on a control: the WebView focuses it, then clicks it. */
const tap = (el: HTMLElement): void =>
  act(() => {
    el.focus()
    el.click()
  })

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

  it('a form whose first control is a text field takes the dialog itself (§9.22): the keyboard must not come up with the sheet, and Cancel first is the named failure', () => {
    render(
      <BottomSheet onDismissed={() => undefined} label="Rename">
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
    const sheet = sheets()[0]
    expect(active()).toBe(sheet)
    expect(sheet.getAttribute('role')).toBe('dialog')
    expect(sheet.tabIndex).toBe(-1)
  })

  it('a notice whose only controls are the chassis footer’s takes the dialog itself, never the footer’s Cancel (§9.22)', () => {
    render(
      <BottomSheet
        onDismissed={() => undefined}
        label="Install Zen"
        footer={
          <>
            <button type="button">Cancel</button>
            <button type="button" data-primary>
              Install
            </button>
          </>
        }
      >
        <p>Zen will be added to your home screen.</p>
      </BottomSheet>
    )
    expect(active()).toBe(sheets()[0])
    expect(active()).not.toBe(byText('Cancel'))
  })

  it('a field after a row does not move the landing: the first control is the row', () => {
    render(
      <BottomSheet onDismissed={() => undefined}>
        <button type="button">Kind</button>
        <input aria-label="Name" />
      </BottomSheet>
    )
    expect(active()).toBe(byText('Kind'))
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

  it('marks the shell chrome and the window surfaces, not the desktop root with its window-frame mode', () => {
    const desktopRoot = document.createElement('div')
    desktopRoot.className = 'zen-window'
    desktopRoot.dataset.windowChrome = 'frameless'
    const toolbar = document.createElement('div')
    toolbar.dataset.surface = 'window'
    desktopRoot.appendChild(toolbar)
    document.body.appendChild(desktopRoot)
    render(<BottomSheet onDismissed={() => undefined}>{rows('Copy')}</BottomSheet>)
    expect(chrome.hasAttribute('inert')).toBe(true)
    expect(toolbar.hasAttribute('inert')).toBe(true)
    expect(desktopRoot.hasAttribute('inert')).toBe(false)
    desktopRoot.remove()
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

  /*
   * A hosted sheet (the frame dialog host, `ownScrim`): the host used to hold the chrome inert
   * for it too, and that hold still stood – the host's state clears a commit after the sheet's
   * own layout cleanup – as the sheet returned the focus, so the opener under the inert chrome
   * refused it and focus fell to `body`. The sheet's hold is the one hold: released, then the
   * return, in the one cleanup, whichever way the sheet was closed.
   */
  describe('a hosted sheet returns it too, the host holding nothing over it', () => {
    beforeEach(() => {
      viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    })

    it('closed by its Cancel, by a scrim press and by predictive back', async () => {
      const handle = createRef<BottomSheetHandle>()
      const onClosed = vi.fn()
      const view = (open: boolean): ReactElement => (
        <>
          <FrameDialogHost frame />
          <Hosted open={open} handle={handle} onClosed={onClosed}>
            {rows('Light', 'Dark')}
          </Hosted>
        </>
      )
      const opened = async (): Promise<void> => {
        // The surface's `open` went false with the close; the opener is pressed again.
        rerender(view(false))
        act(() => opener.focus())
        rerender(view(true))
        await settle()
        act(() => frames.run(60))
        expect(sheets()).toHaveLength(1)
        expect(active()).toBe(byText('Light'))
        expect(chrome.hasAttribute('inert')).toBe(true)
      }
      const gone = (closes: number): void => {
        expect(onClosed).toHaveBeenCalledTimes(closes)
        expect(sheets()).toHaveLength(0)
        expect(chrome.hasAttribute('inert')).toBe(false)
        expect(chromeInertHeld()).toBe(false)
        expect(active()).toBe(opener)
      }
      render(view(false))
      await opened()
      tap(byText('Cancel'))
      act(() => frames.run(120))
      gone(1)

      await opened()
      act(() => {
        press(scrims()[0]!)
      })
      act(() => frames.run(120))
      gone(2)

      await opened()
      act(() => handle.current!.backProgress(0.4))
      act(() => handle.current!.commitBack())
      act(() => frames.run(120))
      gone(3)
    })

    it('stacked: the picker gives the focus back to the item sheet’s row, the item sheet to the opener (§9.24)', async () => {
      const lower = createRef<BottomSheetHandle>()
      const upper = createRef<BottomSheetHandle>()
      const view = (second: boolean): ReactElement => (
        <>
          <FrameDialogHost frame />
          <Hosted open handle={lower}>
            {rows('Name', 'Colour')}
          </Hosted>
          <Hosted open={second} handle={upper}>
            {rows('Blue', 'Green')}
          </Hosted>
        </>
      )
      render(view(false))
      await settle()
      act(() => frames.run(60))
      expect(active()).toBe(byText('Name'))
      act(() => byText('Colour').focus())
      rerender(view(true))
      await settle()
      act(() => frames.run(60))
      const [item, picker] = sheets()
      expect(active()).toBe(byText('Blue'))
      expect(item!.hasAttribute('inert')).toBe(true)
      expect(picker!.hasAttribute('inert')).toBe(false)
      expect(chrome.hasAttribute('inert')).toBe(true)

      tap(byText('Green'))
      act(() => upper.current!.dismiss())
      act(() => frames.run(120))
      expect(sheets()).toHaveLength(1)
      expect(item!.hasAttribute('inert')).toBe(false)
      expect(active()).toBe(byText('Colour'))
      expect(chrome.hasAttribute('inert')).toBe(true)

      dismissAndSettle(lower.current!)
      expect(sheets()).toHaveLength(0)
      expect(chrome.hasAttribute('inert')).toBe(false)
      expect(active()).toBe(opener)
    })
  })
})

describe('a stack holds the focus on top only (§9.24)', () => {
  it('the upper sheet takes the focus and the lower goes inert; the lower gets both back when the upper leaves', async () => {
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
    await settle()
    act(() => frames.run(60))
    expect(active()).toBe(byText('Font size'))
    // A tap on the row that opens the picker gives it the focus.
    act(() => byText('Theme').focus())
    rerender(both(true))
    const [a, b] = sheets()
    // The upper sheet takes the focus as it mounts; the lower goes inert with the upper's first
    // frame (§11.2: from q > 0), not from its registering.
    expect(active()).toBe(byText('Small'))
    expect(a.hasAttribute('inert')).toBe(false)
    await settle()
    act(() => frames.run(1))
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

/*
 * On the phone a sheet waits for the live page to give way to its picture before it comes up
 * (§11.5, `coverPageUnderSheet`), and the chassis moves the focus in as the sheet mounts – during
 * that wait. The hold is opacity 0 and no pointer, never `visibility: hidden`: the focus lands
 * in the sheet at once and is still there once the sheet shows (the regression the review of
 * #168 measured: focus stayed on the opener, and Enter no longer closed the prompt).
 */
describe('focus lands in a sheet held for the page’s cover (§9.22, regression)', () => {
  it('the rule under test: no focus for a hidden element, focus for one at opacity 0', () => {
    const hidden = document.createElement('div')
    hidden.tabIndex = -1
    hidden.style.visibility = 'hidden'
    const clear = document.createElement('div')
    clear.tabIndex = -1
    clear.style.opacity = '0'
    document.body.append(hidden, clear)
    hidden.focus()
    expect(active()).not.toBe(hidden)
    clear.focus()
    expect(active()).toBe(clear)
    hidden.remove()
    clear.remove()
  })

  it('a plain sheet: the first row has the focus through the wait, and once the sheet shows', async () => {
    const hold = holdCover()
    render(<BottomSheet onDismissed={() => undefined}>{rows('Copy', 'Share')}</BottomSheet>)
    const sheet = sheets()[0]
    // Waiting: laid out, at opacity 0, out of the pointer's way, and not hidden.
    expect(sheet.style.opacity).toBe('0')
    expect(sheet.style.pointerEvents).toBe('none')
    expect(sheet.style.visibility).toBe('')
    expect(active()).toBe(byText('Copy'))
    expect(chrome.hasAttribute('inert')).toBe(true)
    await hold.resolve()
    act(() => frames.run(60))
    expect(sheet.style.opacity).toBe('1')
    expect(sheet.style.pointerEvents).toBe('')
    expect(active()).toBe(byText('Copy'))
  })

  it('a stacked sheet: the upper takes the focus as it mounts; the lower goes inert with its first frame', async () => {
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
    await settle()
    act(() => frames.run(60))
    act(() => byText('Theme').focus())
    const hold = holdCover()
    rerender(both(true))
    const [a, b] = sheets()
    expect(b.style.opacity).toBe('0')
    expect(active()).toBe(byText('Small'))
    expect(a.hasAttribute('inert')).toBe(false)
    await hold.resolve()
    act(() => frames.run(1))
    expect(a.hasAttribute('inert')).toBe(true)
    expect(active()).toBe(byText('Small'))
    act(() => frames.run(60))
    expect(b.style.opacity).toBe('1')
    expect(active()).toBe(byText('Small'))
    dismissAndSettle(upper.current!)
    expect(active()).toBe(byText('Theme'))
  })

  it('a PhoneSheet form: the dialog itself holds the focus (never its field), a prompt its Cancel', async () => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    // The bookmark editor's shape: a field first, the actions in the footer.
    let hold = holdCover()
    render(
      <>
        <FrameDialogHost frame />
        <PhoneSheet
          name="bookmark-edit"
          title={{ pose: 'header', text: 'Edit bookmark' }}
          focus="dialog"
          onClose={() => {}}
        >
          <form>
            <input aria-label="Name" />
            <div className="zen-sheet-footer">
              <button type="button">Cancel</button>
              <button type="submit" data-primary>
                Save
              </button>
            </div>
          </form>
        </PhoneSheet>
      </>
    )
    let sheet = sheets()[0]
    expect(sheet.getAttribute('role')).toBe('dialog')
    expect(sheet.style.opacity).toBe('0')
    expect(active()).toBe(sheet)
    await hold.resolve()
    act(() => frames.run(60))
    expect(sheet.style.opacity).toBe('1')
    expect(active()).toBe(sheet)
    if (root) act(() => root!.unmount())
    root = null

    // The clear-history prompt's shape: a title block, then Cancel and the action. Enter on the
    // focused Cancel is the browser's click on it, which closes the prompt – so the focus has
    // to be on it, not left on the opener.
    opener.focus()
    hold = holdCover()
    render(
      <>
        <FrameDialogHost frame />
        <PhoneSheet
          name="clear-history"
          title={{
            pose: 'block',
            text: 'Clear browsing history?',
            description: 'This removes every visit from the history.'
          }}
          focus="first"
          onClose={() => {}}
        >
          <div className="zen-sheet-footer">
            <button type="button">Cancel</button>
            <button type="button" data-primary>
              Clear
            </button>
          </div>
        </PhoneSheet>
      </>
    )
    sheet = sheets()[0]
    expect(sheet.style.opacity).toBe('0')
    expect(active()).toBe(byText('Cancel'))
    await hold.resolve()
    act(() => frames.run(60))
    expect(sheet.style.opacity).toBe('1')
    expect(active()).toBe(byText('Cancel'))
    expect(sheet.contains(active())).toBe(true)
  })

  it("a PhoneSheet picker (focus 'checked'): the current option when one is checked, else the first row (§9.13, §9.22)", async () => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    // A §9.13 picker sheet's shape: radio rows, the current one marked, as the PDF viewer's
    // "Fit to width" picker or a settings picker on `PhoneSheet` lists them.
    const picker = (checked: string | null): ReactElement => (
      <>
        <FrameDialogHost frame />
        <PhoneSheet
          name="pdf-fit"
          title={{ pose: 'header', text: 'Fit' }}
          focus="checked"
          onClose={() => {}}
        >
          <div role="radiogroup" aria-label="Fit">
            {['Fit to width', 'Fit to page', 'Actual size'].map((label) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={label === checked}
                className="zen-v2-row"
              >
                {label}
              </button>
            ))}
          </div>
        </PhoneSheet>
      </>
    )
    let hold = holdCover()
    render(picker('Fit to page'))
    let sheet = sheets()[0]
    expect(sheet.style.opacity).toBe('0')
    expect(active()).toBe(byText('Fit to page'))
    await hold.resolve()
    act(() => frames.run(60))
    expect(sheet.style.opacity).toBe('1')
    expect(active()).toBe(byText('Fit to page'))
    if (root) act(() => root!.unmount())
    root = null

    // Nothing checked yet: the first row, never the grabber or the dialog.
    opener.focus()
    hold = holdCover()
    render(picker(null))
    sheet = sheets()[0]
    expect(active()).toBe(byText('Fit to width'))
    await hold.resolve()
    act(() => frames.run(60))
    expect(active()).toBe(byText('Fit to width'))
    expect(sheet.contains(active())).toBe(true)
  })

  it("the PDF viewer's zoom picker (PdfZoomSheet, #247's follow-up): the zoom in force takes the focus as the sheet opens, a fit or a preset", async () => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    // The real picker (`pdf-zoom`, PdfSheets.tsx) on `focus="checked"`: the row of the zoom the
    // viewer reports is checked and focused through the wait for the cover and once the sheet
    // shows – the dialog itself never holds it, as it did on `focus="dialog"`.
    const zoomSheet = (zoom: number, fit: PdfFitMode | null): ReactElement => (
      <>
        <FrameDialogHost frame />
        <PdfZoomSheet zoom={zoom} fit={fit} onPick={() => {}} onClose={() => {}} />
      </>
    )
    const checkedRow = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[role="radiogroup"] [role="radio"][aria-checked="true"]')
    let hold = holdCover()
    render(zoomSheet(1, 'page'))
    let sheet = sheets()[0]
    expect(sheet.style.opacity).toBe('0')
    expect(checkedRow()).toBe(byText('Fit to page'))
    expect(active()).toBe(byText('Fit to page'))
    await hold.resolve()
    act(() => frames.run(60))
    expect(sheet.style.opacity).toBe('1')
    expect(active()).toBe(byText('Fit to page'))
    expect(active()).not.toBe(sheet.closest('[role="dialog"]'))
    if (root) act(() => root!.unmount())
    root = null

    // A preset in force with no fit: its row, not the first.
    opener.focus()
    hold = holdCover()
    render(zoomSheet(1.5, null))
    sheet = sheets()[0]
    expect(checkedRow()).toBe(byText('150%'))
    expect(active()).toBe(byText('150%'))
    await hold.resolve()
    act(() => frames.run(60))
    expect(active()).toBe(byText('150%'))
    expect(sheet.contains(active())).toBe(true)
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
  it('with the keyboard up the peek moves above the keys', async () => {
    // A form 1000 px tall on the 800 px layer: a peek at 416 and an expanded detent at 760.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 1000
    })
    render(<BottomSheet onDismissed={() => undefined}>form</BottomSheet>)
    await settle()
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

  it('a focused field is kept above the keys: the sheet expands for it, and the body scrolls the rest', async () => {
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
    await settle()
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

/**
 * A ResizeObserver for happy-dom, which has none: every `observe` goes on record, with whether
 * it was made inside a delivery, and a test delivers a target's resize by hand, as the WebView
 * does at the end of a frame.
 */
class FakeResizeObserver implements ResizeObserver {
  static observed: Element[] = []
  static observedInDelivery: Element[] = []
  private static readonly live = new Set<FakeResizeObserver>()
  private static delivering = false
  private readonly targets = new Set<Element>()

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    this.targets.add(target)
    FakeResizeObserver.live.add(this)
    FakeResizeObserver.observed.push(target)
    if (FakeResizeObserver.delivering) FakeResizeObserver.observedInDelivery.push(target)
  }

  unobserve(target: Element): void {
    this.targets.delete(target)
  }

  disconnect(): void {
    this.targets.clear()
    FakeResizeObserver.live.delete(this)
  }

  static reset(): void {
    FakeResizeObserver.observed = []
    FakeResizeObserver.observedInDelivery = []
    FakeResizeObserver.live.clear()
    FakeResizeObserver.delivering = false
  }

  /** `target` changed size: one delivery to each of its observers. */
  static deliver(target: Element): void {
    FakeResizeObserver.delivering = true
    try {
      for (const o of FakeResizeObserver.live) if (o.targets.has(target)) o.callback([], o)
    } finally {
      FakeResizeObserver.delivering = false
    }
  }
}

describe("the keyboard lift and the sheet's observers", () => {
  const bodyObservations = (body: Element): number =>
    FakeResizeObserver.observed.filter((t) => t === body).length

  beforeEach(() => {
    FakeResizeObserver.reset()
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  for (const strict of [false, true]) {
    it(`the body is observed once for the life of the sheet, not once per frame of the lift${strict ? ' (under <StrictMode>)' : ''}`, async () => {
      const sheet = (
        <BottomSheet onDismissed={() => undefined}>
          <input aria-label="Name" />
        </BottomSheet>
      )
      render(strict ? <StrictMode>{sheet}</StrictMode> : sheet)
      await settle()
      act(() => frames.run(60))
      const body = document.querySelector<HTMLElement>('.zen-sheet-scroll')!
      const layer = document.querySelector<HTMLElement>('[data-sheet-layer]')!
      const mounted = bodyObservations(body)
      // StrictMode rehearses the ref: attached, let go of and attached again.
      expect(mounted).toBe(strict ? 2 : 1)

      // The keyboard's lift: the host streams the inset frame by frame, the sheet renders on
      // each, and the layer's own observer sees it shrink.
      for (let i = 1; i <= 12; i++) {
        keyboard(i * 25)
        act(() => FakeResizeObserver.deliver(layer))
        act(() => frames.run(1))
      }
      expect(bodyObservations(body)).toBe(mounted)
      expect(FakeResizeObserver.observedInDelivery).toEqual([])
    })
  }

  it("a sheet rendered again inside a resize delivery – the layout reporter's flush – observes nothing anew", async () => {
    render(
      <BottomSheet onDismissed={() => undefined}>
        <input aria-label="Name" />
      </BottomSheet>
    )
    await settle()
    act(() => frames.run(60))
    const body = document.querySelector<HTMLElement>('.zen-sheet-scroll')!
    const mounted = bodyObservations(body)

    // The content frame's observer (`useLayoutReporter`) fires as the frame shrinks under the
    // keyboard and writes a store the shell renders from, synchronously: the sheet renders again
    // in that flush, inside the delivery. An observation made there, on an element no deeper
    // than the frame, is one the delivery has already passed: the WebView's
    // `ResizeObserver loop limit exceeded`.
    const frame = new FakeResizeObserver(() => {
      act(() => uiStore.set((s) => ({ insets: { ...s.insets, bottom: s.insets.bottom + 40 } })))
    })
    frame.observe(chrome)
    for (let i = 0; i < 8; i++) FakeResizeObserver.deliver(chrome)
    expect(uiStore.get().insets.bottom).toBe(320)
    expect(FakeResizeObserver.observedInDelivery).toEqual([])
    expect(bodyObservations(body)).toBe(mounted)
  })
})
