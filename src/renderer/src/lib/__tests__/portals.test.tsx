// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect, useRef, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Rect } from '@shared/types'
import {
  ChromePortal,
  FrameDialogHost,
  FrameDialogPortal,
  POPOVER_HEIGHT_FLOOR,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  chromeInertHeld,
  chromeLayer,
  closeAllPopovers,
  holdChromeInert,
  openPopoverCount,
  placePopover,
  popoverStyle,
  useAnchorRect,
  useFrameDialog,
  useLightDismiss
} from '../portals'

/*
 * Where chrome surfaces render (lib/portals.tsx): modal dialogs in the content frame through
 * FrameDialogHost, whose scrim dims the frame only and makes the window chrome inert (§9.5) –
 * reached from inside the frame with FrameDialogPortal, and left to a sheet that draws the
 * stack's one scrim itself (ownScrim); popovers, menus and toasts through ChromePortal, in the
 * window-wide chrome layer, with the layer's light dismiss (lib/popoverStore.ts, tested in
 * popoverStore.test.tsx); §9.20 geometry from placePopover. Both layers are page surfaces
 * (§9.29): their roots carry
 * `data-surface="page"`.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

function rerender(el: ReactElement): void {
  act(() => root!.render(el))
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
})

const host = (): HTMLElement => mount!.querySelector<HTMLElement>('.zen-frame-dialogs')!
const slot = (): HTMLElement => host().querySelector<HTMLElement>('.zen-frame-dialogs-slot')!
const scrim = (): HTMLElement | null => mount!.querySelector<HTMLElement>('.zen-frame-scrim')
const press = (el: Element, type = 'pointerdown'): boolean =>
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }))
const pressScrim = (): void => {
  act(() => {
    press(scrim()!)
  })
}

/** A dialog panel placed through the host, as the bookmark dialogs and prompts are. */
function Dialog({
  name,
  onScrimPress,
  active,
  onPress,
  ownScrim
}: {
  name: string
  onScrimPress?: () => void
  active?: boolean
  onPress?: () => void
  ownScrim?: boolean
}): JSX.Element {
  useFrameDialog({ onScrimPress, active, ownScrim })
  return (
    <div data-dialog={name} onPointerDown={onPress}>
      {name}
    </div>
  )
}

/** The stylesheet's rules for a selector, as one string (`main.css` is not loaded in happy-dom). */
function cssRule(selector: string): string {
  const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
  const at = css.indexOf(`${selector} {`)
  expect(at, `a rule for ${selector}`).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at)).replace(/\s+/g, ' ')
}

describe('FrameDialogHost', () => {
  it('is inert with no dialog: no scrim, no pointer, but the layer stays for its children', () => {
    render(<FrameDialogHost />)
    expect(host()).not.toBeNull()
    expect(host().hasAttribute('data-open')).toBe(false)
    expect(scrim()).toBeNull()
  })

  it('opens when a dialog registers and closes again when it unmounts', () => {
    render(
      <FrameDialogHost>
        <Dialog name="edit" />
      </FrameDialogHost>
    )
    expect(host().getAttribute('data-open')).toBe('true')
    expect(scrim()).not.toBeNull()
    // The panel is a child of the host's slot, in flow: the slot centres it; nothing is `fixed`.
    const panel = host().querySelector<HTMLElement>('[data-dialog="edit"]')!
    expect(panel.parentElement).toBe(slot())
    rerender(<FrameDialogHost />)
    expect(host().hasAttribute('data-open')).toBe(false)
    expect(scrim()).toBeNull()
    expect(slot()).not.toBeNull()
  })

  it('layers every dialog above the scrim, positioned or not (regression: BookmarkAllTabsDialog)', () => {
    // The live bug: the scrim, a positioned sibling painted after an unpositioned dialog, dimmed
    // the dialog and took the press at its centre. Now the scrim comes first in tree order and
    // the children render in a slot after it with a stacking context of its own above the scrim.
    const onScrim = vi.fn()
    const onDialog = vi.fn()
    render(
      <FrameDialogHost>
        <Dialog name="all-tabs" onScrimPress={onScrim} onPress={onDialog} />
      </FrameDialogHost>
    )
    expect(scrim()!.parentElement).toBe(host())
    expect(scrim()!.nextElementSibling).toBe(slot())
    expect(slot().querySelector('[data-dialog="all-tabs"]')).not.toBeNull()
    // The slot lifts its content over the scrim: positioned, z-index 1, in the host's own
    // stacking context; the scrim has no z-index to answer with.
    expect(cssRule('.zen-frame-dialogs')).toContain('isolation: isolate')
    expect(cssRule('.zen-frame-dialogs-slot')).toMatch(/position: absolute/)
    expect(cssRule('.zen-frame-dialogs-slot')).toMatch(/z-index: 1;/)
    expect(cssRule('.zen-frame-scrim')).not.toMatch(/z-index/)
    // Between the dialogs the slot lets the pointer through to the scrim; the dialogs take it.
    expect(cssRule('.zen-frame-dialogs-slot')).toMatch(/pointer-events: none/)
    expect(cssRule('.zen-frame-dialogs[data-open] .zen-frame-dialogs-slot > *')).toMatch(
      /pointer-events: auto/
    )
    // A press on the (unpositioned) dialog is the dialog's, not the scrim's.
    act(() => {
      press(host().querySelector('[data-dialog="all-tabs"]')!)
    })
    expect(onDialog).toHaveBeenCalledTimes(1)
    expect(onScrim).not.toHaveBeenCalled()
    pressScrim()
    expect(onScrim).toHaveBeenCalledTimes(1)
  })

  it('consumes the scrim press on pointerdown, not on click (§9.20 amended)', () => {
    const close = vi.fn()
    render(
      <FrameDialogHost>
        <Dialog name="edit" onScrimPress={close} />
      </FrameDialogHost>
    )
    act(() => {
      scrim()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      scrim()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(close).not.toHaveBeenCalled()
    pressScrim()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('sends a scrim press to the dialog on top, and to nobody for a prompt with no handler', () => {
    const closeEdit = vi.fn()
    render(
      <FrameDialogHost>
        <Dialog name="edit" onScrimPress={closeEdit} />
        <Dialog name="prompt" />
      </FrameDialogHost>
    )
    pressScrim()
    expect(closeEdit).not.toHaveBeenCalled()
    // The prompt goes; the edit dialog is on top again.
    rerender(
      <FrameDialogHost>
        <Dialog name="edit" onScrimPress={closeEdit} />
      </FrameDialogHost>
    )
    pressScrim()
    expect(closeEdit).toHaveBeenCalledTimes(1)
  })

  it('runs the latest scrim handler, not the one the dialog mounted with', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(
      <FrameDialogHost>
        <Dialog name="edit" onScrimPress={first} />
      </FrameDialogHost>
    )
    rerender(
      <FrameDialogHost>
        <Dialog name="edit" onScrimPress={second} />
      </FrameDialogHost>
    )
    pressScrim()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('ignores a dialog that is not active (one rendering nothing while its node is gone)', () => {
    render(
      <FrameDialogHost>
        <Dialog name="edit" active={false} />
      </FrameDialogHost>
    )
    expect(host().hasAttribute('data-open')).toBe(false)
    expect(scrim()).toBeNull()
  })

  it('scopes a dialog to the nearest host: the manager’s own host, not the shell’s', () => {
    render(
      <FrameDialogHost>
        <div data-manager>
          <FrameDialogHost>
            <Dialog name="edit" />
          </FrameDialogHost>
        </div>
      </FrameDialogHost>
    )
    const hosts = mount!.querySelectorAll<HTMLElement>('.zen-frame-dialogs')
    expect(hosts).toHaveLength(2)
    expect(hosts[0]!.hasAttribute('data-open')).toBe(false)
    expect(hosts[1]!.getAttribute('data-open')).toBe('true')
    expect(hosts[1]!.querySelector('.zen-frame-scrim')).not.toBeNull()
    expect(hosts[0]!.querySelector(':scope > .zen-frame-scrim')).toBeNull()
  })

  it('draws no scrim of its own while a sheet with its own scrim is on top (§9.24, §9.28)', () => {
    function Sheet({ name }: { name: string }): JSX.Element {
      useFrameDialog({ ownScrim: true })
      return <div data-dialog={name}>{name}</div>
    }
    render(
      <FrameDialogHost>
        <Sheet name="menu" />
      </FrameDialogHost>
    )
    // Open all the same: the chrome goes inert, the layer takes the pointer.
    expect(host().getAttribute('data-open')).toBe('true')
    expect(scrim()).toBeNull()
    // A plain dialog over the sheet brings the host's scrim back; the sheet's own is under it.
    rerender(
      <FrameDialogHost>
        <Sheet name="menu" />
        <Dialog name="prompt" />
      </FrameDialogHost>
    )
    expect(scrim()).not.toBeNull()
    rerender(
      <FrameDialogHost>
        <Sheet name="menu" />
      </FrameDialogHost>
    )
    expect(scrim()).toBeNull()
  })

  it('closes every open popover when a dialog opens (one popover at a time, §9.20)', () => {
    const onDismiss = vi.fn()
    function Popover(): JSX.Element {
      const ref = useRef<HTMLDivElement>(null)
      useLightDismiss(ref, onDismiss)
      return (
        <ChromePortal>
          <div ref={ref} data-popover />
        </ChromePortal>
      )
    }
    render(
      <>
        <Popover />
        <FrameDialogHost />
      </>
    )
    expect(openPopoverCount()).toBe(1)
    rerender(
      <>
        <Popover />
        <FrameDialogHost>
          <Dialog name="prompt" />
        </FrameDialogHost>
      </>
    )
    expect(onDismiss).toHaveBeenCalledWith('all')
    expect(openPopoverCount()).toBe(0)
  })
})

describe('FrameDialogPortal', () => {
  /** A panel's sheet, opened by a row inside the content frame, mounting in the frame's host. */
  function PanelSheet({ onScrimPress }: { onScrimPress?: () => void }): JSX.Element {
    return (
      <FrameDialogPortal>
        <Dialog name="edit" onScrimPress={onScrimPress} />
      </FrameDialogPortal>
    )
  }

  it('renders into the frame host from outside its subtree, and registers with it', () => {
    const close = vi.fn()
    render(
      <>
        <FrameDialogHost frame />
        <div data-panel>
          <PanelSheet onScrimPress={close} />
        </div>
      </>
    )
    const panel = mount!.querySelector<HTMLElement>('[data-dialog="edit"]')!
    expect(panel.parentElement).toBe(slot())
    expect(mount!.querySelector('[data-panel] [data-dialog]')).toBeNull()
    expect(host().getAttribute('data-open')).toBe('true')
    pressScrim()
    expect(close).toHaveBeenCalledTimes(1)
    // The sheet goes; the host closes.
    rerender(
      <>
        <FrameDialogHost frame />
        <div data-panel />
      </>
    )
    expect(host().hasAttribute('data-open')).toBe(false)
    expect(scrim()).toBeNull()
  })

  it('prefers the nearest host above it to the frame’s', () => {
    render(
      <>
        <FrameDialogHost frame />
        <div data-manager>
          <FrameDialogHost>
            <PanelSheet />
          </FrameDialogHost>
        </div>
      </>
    )
    const hosts = mount!.querySelectorAll<HTMLElement>('.zen-frame-dialogs')
    expect(hosts).toHaveLength(2)
    expect(hosts[0]!.hasAttribute('data-open')).toBe(false)
    expect(hosts[1]!.getAttribute('data-open')).toBe('true')
    expect(hosts[1]!.querySelector('[data-dialog="edit"]')).not.toBeNull()
  })

  it('renders nothing until a frame host has mounted, then the sheet appears in it', () => {
    render(
      <>
        <PanelSheet />
      </>
    )
    expect(mount!.querySelector('[data-dialog="edit"]')).toBeNull()
    rerender(
      <>
        <FrameDialogHost frame />
        <PanelSheet />
      </>
    )
    expect(slot().querySelector('[data-dialog="edit"]')).not.toBeNull()
    expect(host().getAttribute('data-open')).toBe('true')
  })

  it('finds the frame host wherever it sits in the tree, never a host that is not the frame’s', () => {
    render(
      <div>
        <FrameDialogHost />
        <FrameDialogPortal>
          <Dialog name="sheet" />
        </FrameDialogPortal>
      </div>
    )
    expect(mount!.querySelector('[data-dialog="sheet"]')).toBeNull()
    expect(host().hasAttribute('data-open')).toBe(false)
  })
})

/** Window chrome around the frame: a sidebar and a toolbar with a button that opens a panel. */
function Chrome({ children }: { children?: React.ReactNode }): JSX.Element {
  return (
    <>
      <div data-surface="window" data-chrome="sidebar">
        <button type="button" data-puzzle>
          Extensions
        </button>
      </div>
      <div data-surface="window" data-chrome="toolbar" />
      <div data-frame>{children}</div>
    </>
  )
}
const chrome = (name: string): HTMLElement =>
  mount!.querySelector<HTMLElement>(`[data-chrome="${name}"]`)!
const inert = (el: Element): boolean => el.hasAttribute('inert')
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('chrome inertness while a frame dialog is open (§9.5)', () => {
  it('makes the window chrome roots inert for the dialog’s lifetime and restores them after', () => {
    render(
      <Chrome>
        <FrameDialogHost />
      </Chrome>
    )
    expect(inert(chrome('sidebar'))).toBe(false)
    rerender(
      <Chrome>
        <FrameDialogHost>
          <Dialog name="prompt" />
        </FrameDialogHost>
      </Chrome>
    )
    expect(inert(chrome('sidebar'))).toBe(true)
    expect(inert(chrome('toolbar'))).toBe(true)
    // The puzzle button is inside an inert subtree: no press, focus or click reaches it while the
    // prompt is up. The dialog itself and the host are live.
    expect(mount!.querySelector('[data-puzzle]')!.closest('[inert]')).toBe(chrome('sidebar'))
    expect(host().closest('[inert]')).toBeNull()
    expect(inert(host())).toBe(false)
    rerender(
      <Chrome>
        <FrameDialogHost />
      </Chrome>
    )
    expect(inert(chrome('sidebar'))).toBe(false)
    expect(inert(chrome('toolbar'))).toBe(false)
  })

  it('keeps the chrome inert while any dialog is open, in any host, and stacks holds', () => {
    render(
      <Chrome>
        <FrameDialogHost>
          <Dialog name="edit" />
          <Dialog name="prompt" />
        </FrameDialogHost>
        <FrameDialogHost>
          <Dialog name="manager-edit" />
        </FrameDialogHost>
      </Chrome>
    )
    expect(inert(chrome('sidebar'))).toBe(true)
    rerender(
      <Chrome>
        <FrameDialogHost>
          <Dialog name="edit" />
        </FrameDialogHost>
        <FrameDialogHost />
      </Chrome>
    )
    expect(inert(chrome('sidebar'))).toBe(true)
    rerender(
      <Chrome>
        <FrameDialogHost />
        <FrameDialogHost />
      </Chrome>
    )
    expect(inert(chrome('sidebar'))).toBe(false)
  })

  it('leaves the dialog layers and the chrome layer live: window roots inside them are not chrome', () => {
    render(
      <Chrome>
        <FrameDialogHost>
          <Dialog name="prompt" />
          <div data-surface="window" data-chrome="inside-host" />
        </FrameDialogHost>
        <ChromePortal>
          <div data-surface="window" data-chrome="inside-layer" />
        </ChromePortal>
      </Chrome>
    )
    expect(inert(chrome('sidebar'))).toBe(true)
    expect(inert(chrome('inside-host'))).toBe(false)
    expect(inert(document.querySelector('[data-chrome="inside-layer"]')!)).toBe(false)
  })

  it('catches chrome mounted while the hold lasts, and leaves alone what was inert already', async () => {
    render(
      <Chrome>
        <div data-surface="window" data-chrome="already" inert />
        <FrameDialogHost>
          <Dialog name="prompt" />
        </FrameDialogHost>
      </Chrome>
    )
    const late = document.createElement('div')
    late.setAttribute('data-surface', 'window')
    late.setAttribute('data-chrome', 'late')
    mount!.appendChild(late)
    await tick()
    expect(inert(late)).toBe(true)
    rerender(
      <Chrome>
        <div data-surface="window" data-chrome="already" inert />
        <FrameDialogHost />
      </Chrome>
    )
    expect(inert(late)).toBe(false)
    expect(inert(chrome('already'))).toBe(true)
  })

  it('holdChromeInert nests: the chrome comes back when the last hold is released, once', () => {
    render(<Chrome />)
    expect(chromeInertHeld()).toBe(false)
    const first = holdChromeInert()
    const second = holdChromeInert()
    expect(inert(chrome('sidebar'))).toBe(true)
    expect(chromeInertHeld()).toBe(true)
    first()
    first()
    expect(inert(chrome('sidebar'))).toBe(true)
    expect(chromeInertHeld()).toBe(true)
    second()
    expect(inert(chrome('sidebar'))).toBe(false)
    expect(chromeInertHeld()).toBe(false)
  })
})

describe('ChromePortal', () => {
  it('appends one chrome layer to the body and renders into it, pointer events back on', () => {
    expect(document.getElementById('zen-chrome-layer')).toBeNull()
    render(
      <div>
        <ChromePortal>
          <div data-popover="a">a</div>
        </ChromePortal>
        <ChromePortal>
          <div data-popover="b">b</div>
        </ChromePortal>
      </div>
    )
    const layer = document.getElementById('zen-chrome-layer')!
    expect(layer).not.toBeNull()
    expect(layer.parentElement).toBe(document.body)
    expect(layer.className).toBe('zen-chrome-layer')
    expect(document.querySelectorAll('#zen-chrome-layer')).toHaveLength(1)
    expect(chromeLayer()).toBe(layer)
    // Not inside the app tree, so never under the content frame's transform.
    expect(mount!.querySelector('[data-popover]')).toBeNull()
    const a = layer.querySelector<HTMLElement>('[data-popover="a"]')!
    expect(a).not.toBeNull()
    expect(layer.querySelector('[data-popover="b"]')).not.toBeNull()
    // The layer catches no pointer of its own; each portal's subtree turns pointer events back on.
    expect(a.parentElement!.className).toContain('pointer-events-auto')
    expect(a.parentElement!.className).toContain('contents')
    expect(a.parentElement!.parentElement).toBe(layer)
  })

  it('leaves the layer in place when its portal goes, empty for the next one', () => {
    render(
      <ChromePortal>
        <div data-popover="a" />
      </ChromePortal>
    )
    const layer = document.getElementById('zen-chrome-layer')!
    rerender(<div />)
    expect(document.getElementById('zen-chrome-layer')).toBe(layer)
    expect(layer.childElementCount).toBe(0)
  })
})

describe('token families (§9.29)', () => {
  it('marks both layers as page surfaces: a dialog’s or popover’s nearest surface root is "page"', () => {
    render(
      <div data-surface="window">
        <FrameDialogHost>
          <Dialog name="edit" />
        </FrameDialogHost>
        <ChromePortal>
          <div data-popover="a" />
        </ChromePortal>
      </div>
    )
    expect(host().getAttribute('data-surface')).toBe('page')
    const layer = document.getElementById('zen-chrome-layer')!
    expect(layer.getAttribute('data-surface')).toBe('page')
    // A control inside either reads the page family, whatever window chrome the host sits in.
    const panel = mount!.querySelector<HTMLElement>('[data-dialog="edit"]')!
    expect(panel.closest('[data-surface]')).toBe(host())
    const popover = layer.querySelector<HTMLElement>('[data-popover="a"]')!
    expect(popover.closest('[data-surface]')).toBe(layer)
  })
})

/** A popover's anchor, reporting each rect `useAnchorRect` settles on (each distinct object). */
function Anchor({
  onRect,
  detached
}: {
  onRect: (rect: Rect | null) => void
  detached?: boolean
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const rect = useAnchorRect(ref)
  useEffect(() => {
    onRect(rect)
  }, [onRect, rect])
  return detached ? <span /> : <button ref={ref} type="button" />
}

describe('useAnchorRect', () => {
  it('measures the anchor’s viewport rect after layout and again on resize', () => {
    let box = { left: 100, top: 40, width: 80, height: 28 }
    const seen: Array<Rect | null> = []
    const onRect = (rect: Rect | null): void => {
      seen.push(rect)
    }
    render(<Anchor onRect={onRect} />)
    const button = mount!.querySelector('button')!
    button.getBoundingClientRect = () =>
      ({ ...box, right: 0, bottom: 0, x: box.left, y: box.top, toJSON: () => box }) as DOMRect
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(seen[seen.length - 1]).toEqual({ x: 100, y: 40, width: 80, height: 28 })
    box = { left: 120, top: 40, width: 80, height: 28 }
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(seen[seen.length - 1]).toEqual({ x: 120, y: 40, width: 80, height: 28 })
    // The same rect again is the same object: a resize that moved nothing changes no state, so
    // nothing hanging off the rect re-renders.
    const settled = seen.length
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(seen.length).toBe(settled)
  })

  it('is null for a ref with nothing in it', () => {
    const seen: Array<Rect | null> = []
    const onRect = (rect: Rect | null): void => {
      seen.push(rect)
    }
    render(<Anchor onRect={onRect} detached />)
    expect(seen).toEqual([null])
  })
})

const viewport = { width: 1600, height: 1000 }
const bar = { x: 0, y: 40, width: 1600, height: 30 }
const M = POPOVER_MARGIN
/** The popover's horizontal span. */
const span = (box: { left: number; width: number }): [number, number] => [
  box.left,
  box.left + box.width
]
const overlaps = (box: { left: number; width: number }, anchor: Rect): boolean =>
  box.left < anchor.x + anchor.width && box.left + box.width > anchor.x

describe('placePopover (design-language-v2-draft §9.20): widths', () => {
  it('hangs flush from the bottom edge of the bar the anchor sits in, at a fixed width', () => {
    const anchor = { x: 100, y: 42, width: 80, height: 26 }
    const box = placePopover(anchor, bar, viewport, POPOVER_WIDTH.list)
    expect(box.side).toBe('below')
    expect(box.side === 'below' && box.top).toBe(70)
    expect(box.width).toBe(320)
    expect(placePopover(anchor, bar, viewport, 400).width).toBe(POPOVER_WIDTH.form)
    expect(placePopover(anchor, bar, viewport, 480).width).toBe(POPOVER_WIDTH.table)
  })

  it('takes a measured width for menus (232–332) and manifest popups (25×25 to 800×600)', () => {
    const anchor = { x: 100, y: 42, width: 80, height: 26 }
    expect(placePopover(anchor, bar, viewport, { measured: 232 }).width).toBe(232)
    expect(placePopover(anchor, bar, viewport, { measured: 332 }).width).toBe(332)
    const tiny = placePopover(anchor, bar, viewport, { measured: 25 }, 25)
    expect(tiny.width).toBe(25)
    expect(tiny.maxHeight).toBe(25)
    expect(tiny.left).toBe(100)
    // A manifest popup's document at its requested size, still under the 60% cap (600 in a
    // 1000-high window) and the window − 16.
    const popup = placePopover(anchor, bar, viewport, { measured: 800 }, 600)
    expect(popup.width).toBe(800)
    expect(popup.maxHeight).toBe(600)
    expect(popup.side).toBe('below')
    // An explicit height crossing the cap shrinks to 60% of the window (420 of 700) and its
    // document scrolls under the sticky title (§9.20), as a chassis popover's body does.
    const tall = placePopover(anchor, bar, { width: 1600, height: 700 }, { measured: 400 }, 600)
    expect(tall.maxHeight).toBe(420)
    // The known height of a menu, not the cap, when it is shorter.
    expect(placePopover(anchor, bar, viewport, { measured: 300 }, 220).maxHeight).toBe(220)
  })

  it('shrinks a popover wider than the window minus 16 to that and centres it (4)', () => {
    const narrow = { width: 300, height: 1000 }
    const narrowBar = { x: 0, y: 40, width: 300, height: 30 }
    const squeezed = placePopover({ x: 260, y: 42, width: 28, height: 26 }, narrowBar, narrow, 320)
    expect(squeezed.width).toBe(300 - 2 * M)
    expect(squeezed.left).toBe(M)
    const popup = placePopover(
      { x: 20, y: 42, width: 28, height: 26 },
      { x: 0, y: 40, width: 700, height: 30 },
      { width: 700, height: 500 },
      { measured: 800 },
      600
    )
    expect(popup.width).toBe(700 - 16)
    expect(popup.left).toBe(M)
    // Height: the 60% cap (300 of 500) before the room below the bar (500 − 70 − 8).
    expect(popup.maxHeight).toBe(Math.min(600, 500 * 0.6, 500 - 16, 500 - 70 - M))
  })
})

describe('placePopover (§9.20): horizontal order – align, flip, slide, shrink', () => {
  it('start-aligns with an anchor in the leading half of its bar, end-aligns in the trailing half', () => {
    for (const width of [POPOVER_WIDTH.list, POPOVER_WIDTH.form] as const) {
      const leading = placePopover({ x: 100, y: 42, width: 80, height: 26 }, bar, viewport, width)
      expect(leading.left).toBe(100)
      const trailing = placePopover({ x: 1200, y: 42, width: 80, height: 26 }, bar, viewport, width)
      expect(trailing.left).toBe(1200 + 80 - width)
    }
    // Exactly the middle is the leading half.
    expect(placePopover({ x: 760, y: 42, width: 80, height: 26 }, bar, viewport, 320).left).toBe(
      760
    )
    expect(placePopover({ x: 761, y: 42, width: 80, height: 26 }, bar, viewport, 320).left).toBe(
      761 + 80 - 320
    )
  })

  it('flips to the other alignment when the aligned box would cross the margin (2)', () => {
    // The 400 panel from a button at x 274–302 in a 340 sidebar (the extensions button): end-aligned
    // it would cross the left margin, so it flips to start-align and grows the other way, still on
    // its anchor's edge – never detached to x 8.
    const sidebar = { x: 0, y: 0, width: 340, height: 40 }
    const anchor = { x: 274, y: 6, width: 28, height: 28 }
    const flipped = placePopover(anchor, sidebar, viewport, POPOVER_WIDTH.form)
    expect(flipped.left).toBe(274)
    expect(span(flipped)).toEqual([274, 674])
    expect(overlaps(flipped, anchor)).toBe(true)
    // At 320 as well.
    expect(placePopover(anchor, sidebar, viewport, POPOVER_WIDTH.list).left).toBe(274)
    // The mirror: a leading anchor near the window's trailing edge end-aligns instead.
    const wideBar = { x: 0, y: 40, width: 4000, height: 30 }
    const far = placePopover({ x: 1500, y: 42, width: 20, height: 26 }, wideBar, viewport, 320)
    expect(far.left).toBe(1520 - 320)
    // An anchor 2 px from the left edge of a bar: start-align would cross the margin, end-align
    // cannot fit either (the anchor is narrower than the popover), so it slides to the margin.
    const left = placePopover({ x: 2, y: 42, width: 20, height: 26 }, bar, viewport, 320)
    expect(left.left).toBe(M)
  })

  it('slides the least distance when neither alignment fits, never off its anchor (3)', () => {
    // A 400-wide window: a start-aligned box at x 100 would cross the right margin, end-align
    // the left one; the box slides left to the margin and still overlaps the anchor.
    const small = { width: 400, height: 1000 }
    const smallBar = { x: 0, y: 40, width: 400, height: 30 }
    const anchor = { x: 100, y: 42, width: 40, height: 26 }
    const slid = placePopover(anchor, smallBar, small, 320)
    expect(slid.width).toBe(320)
    expect(slid.left).toBe(400 - M - 320)
    expect(overlaps(slid, anchor)).toBe(true)
    // End-aligned with an anchor whose own end is 2px from the window's edge: start-align cannot
    // fit either, so it slides 6px to the margin.
    const right = placePopover({ x: 1500, y: 42, width: 98, height: 26 }, bar, viewport, 320)
    expect(right.left).toBe(1600 - 320 - M)
    expect(overlaps(right, { x: 1500, y: 42, width: 98, height: 26 })).toBe(true)
    // A trailing anchor 5 px from the window's edge, narrower than the popover: end-align crosses
    // the right margin by 3, start-align the left one; it slides the 3 px.
    const edgeAnchor = { x: 380, y: 42, width: 15, height: 26 }
    const trailing = placePopover(edgeAnchor, smallBar, small, 320)
    expect(trailing.left).toBe(400 - M - 320)
    expect(overlaps(trailing, edgeAnchor)).toBe(true)
  })

  it('treats a lone anchor as its own bar: the star bubble with no pill on screen', () => {
    const anchor = { x: 1564, y: 28, width: 28, height: 28 }
    const box = placePopover(anchor, anchor, viewport, POPOVER_WIDTH.list)
    expect(box.side === 'below' && box.top).toBe(56)
    // Start-aligned (a lone anchor is not in its trailing half) it would cross the margin: it
    // flips to end-align, which lands 8 px from the edge.
    expect(box.left).toBe(1600 - 320 - M)
  })

  it('reports the alignment it resolved to: the preferred one, the flipped one, or the slid one', () => {
    expect(
      placePopover({ x: 100, y: 42, width: 80, height: 26 }, bar, viewport, 320).alignment
    ).toBe('start')
    expect(
      placePopover({ x: 1200, y: 42, width: 80, height: 26 }, bar, viewport, 320).alignment
    ).toBe('end')
    // The 400 panel from the extensions button flipped to start (2).
    const sidebar = { x: 0, y: 0, width: 340, height: 40 }
    const anchor = { x: 274, y: 6, width: 28, height: 28 }
    expect(placePopover(anchor, sidebar, viewport, POPOVER_WIDTH.form).alignment).toBe('start')
    // Slid (3): the aligned box moved, its alignment stands.
    const small = { width: 400, height: 1000 }
    const smallBar = { x: 0, y: 40, width: 400, height: 30 }
    expect(
      placePopover({ x: 100, y: 42, width: 40, height: 26 }, smallBar, small, 320).alignment
    ).toBe('start')
  })

  it('continuity: a surface opened from another on the same anchor inherits its alignment when it fits', () => {
    // The extension popup opened from the puzzle panel (§9.20, "continuity beats the order"):
    // the panel resolved to start (274–674); the 278 popup on the same button would end-align
    // by the order (its button is in the sidebar's trailing half, and end fits), and instead
    // takes the panel's start, 274–552, so the eye stays where the panel was.
    const sidebar = { x: 8, y: 42, width: 324, height: 32 }
    const button = { x: 274, y: 44, width: 28, height: 28 }
    const panel = placePopover(button, sidebar, viewport, POPOVER_WIDTH.form)
    expect(panel.alignment).toBe('start')
    const byOrder = placePopover(button, sidebar, viewport, { measured: 278 }, 582)
    expect(byOrder.alignment).toBe('end')
    expect(span(byOrder)).toEqual([24, 302])
    const popup = placePopover(button, sidebar, viewport, { measured: 278 }, 582, panel.alignment)
    expect(popup.alignment).toBe('start')
    expect(span(popup)).toEqual([274, 552])
    expect(popup.side).toBe('below')
    expect(popup.maxHeight).toBe(582)
    // The predecessor's alignment fitting is the condition. In a 560 window a 290 popup cannot
    // start-align from the button (274 + 290 crosses the margin): it falls back to the order and
    // flips to end, 12–302.
    const narrow = { width: 560, height: 1000 }
    const flipped = placePopover(button, sidebar, narrow, { measured: 290 }, 300, 'start')
    expect(flipped.alignment).toBe('end')
    expect(span(flipped)).toEqual([12, 302])
    // When neither fits, the inherited box slides the least distance (3), not the order's.
    const slid = placePopover(
      button,
      sidebar,
      { width: 640, height: 1000 },
      { measured: 500 },
      300,
      'start'
    )
    expect(slid.alignment).toBe('start')
    expect(slid.left).toBe(640 - M - 500)
    expect(overlaps(slid, button)).toBe(true)
    // An inherited 'end' on a leading anchor holds the same way when it fits, 360–680.
    const leading = { x: 600, y: 42, width: 80, height: 26 }
    expect(placePopover(leading, bar, viewport, 320).alignment).toBe('start')
    const inherited = placePopover(leading, bar, viewport, 320, undefined, 'end')
    expect(inherited.alignment).toBe('end')
    expect(span(inherited)).toEqual([360, 680])
  })
})

describe('placePopover (§9.20): vertical order – below, flip above, shrink, the 160 floor', () => {
  it('hangs below with at most 60% of the window when its height is not known', () => {
    const box = placePopover({ x: 100, y: 42, width: 80, height: 26 }, bar, viewport, 320)
    expect(box.side).toBe('below')
    expect(box.maxHeight).toBe(600)
    expect(popoverStyle(box)).toEqual({ left: 100, top: 70, width: 320, maxHeight: 600 })
    // Never more than the window minus 16 either, and never a negative height.
    const short = placePopover(
      { x: 100, y: 2, width: 80, height: 20 },
      { x: 0, y: 0, width: 1600, height: 24 },
      { width: 1600, height: 20 },
      320
    )
    expect(short.maxHeight).toBe(0)
    const off = placePopover(
      { x: 100, y: 42, width: 80, height: 26 },
      bar,
      { width: 1600, height: 60 },
      320
    )
    expect(off.maxHeight).toBeGreaterThanOrEqual(0)
    expect(off.maxHeight).toBeLessThanOrEqual(60 - 16)
  })

  it('flips above a low bar when there is more room above (bottom edge flush with the bar’s top)', () => {
    const lowBar = { x: 0, y: 900, width: 1600, height: 30 }
    const low = placePopover({ x: 100, y: 902, width: 80, height: 26 }, lowBar, viewport, 320)
    expect(low.side).toBe('above')
    expect(low.side === 'above' && low.bottom).toBe(1000 - 900)
    expect(low.maxHeight).toBe(600)
    expect(popoverStyle(low)).toEqual({ left: 100, bottom: 100, width: 320, maxHeight: 600 })
    // Shrunk to the room above when even that is short.
    const mid = placePopover(
      { x: 100, y: 602, width: 80, height: 26 },
      { x: 0, y: 600, width: 1600, height: 30 },
      viewport,
      320
    )
    expect(mid.side).toBe('above')
    expect(mid.maxHeight).toBe(600 - M)
    // A bar at the window's bottom edge: no room below, all of it above.
    const edge = placePopover(
      { x: 100, y: 972, width: 80, height: 26 },
      { x: 0, y: 970, width: 1600, height: 30 },
      viewport,
      320
    )
    expect(edge.side).toBe('above')
    expect(edge.side === 'above' && edge.bottom).toBe(30)
    expect(edge.maxHeight).toBe(600)
  })

  it('stays below and shrinks to the room left when there is less room above', () => {
    const box = placePopover(
      { x: 100, y: 422, width: 80, height: 26 },
      { x: 0, y: 420, width: 1600, height: 30 },
      viewport,
      320
    )
    expect(box.side).toBe('below')
    expect(box.maxHeight).toBe(1000 - 450 - M)
    expect(box.maxHeight).toBeGreaterThanOrEqual(POPOVER_HEIGHT_FLOOR)
  })

  it('never shrinks under the 160 floor: below that it flips above regardless', () => {
    expect(POPOVER_HEIGHT_FLOOR).toBe(160)
    // 142 px below, 142 above: no more room above, but the floor flips it anyway.
    const tight = { width: 1600, height: 320 }
    const midBar = { x: 0, y: 150, width: 1600, height: 20 }
    const box = placePopover({ x: 100, y: 152, width: 80, height: 16 }, midBar, tight, 320)
    expect(box.side).toBe('above')
    expect(box.maxHeight).toBe(150 - M)
    // Just enough room below the floor's worth: it stays below, shrunk to the room.
    const roomy = { width: 1600, height: 400 }
    const roomBar = { x: 0, y: 190, width: 1600, height: 20 }
    const stays = placePopover({ x: 100, y: 192, width: 80, height: 16 }, roomBar, roomy, 320)
    expect(stays.side).toBe('below')
    expect(stays.maxHeight).toBe(400 - 210 - M)
    expect(stays.maxHeight).toBeGreaterThanOrEqual(POPOVER_HEIGHT_FLOOR)
  })

  it('places a popover of known height by that height, flipping it whole when it must', () => {
    // A menu of 12 rows fits below the toolbar.
    const menu = placePopover(
      { x: 100, y: 42, width: 80, height: 26 },
      bar,
      viewport,
      { measured: 260 },
      384
    )
    expect(menu.side).toBe('below')
    expect(menu.maxHeight).toBe(384)
    // From a bar near the bottom the same menu flips above, still 384 tall.
    const lowBar = { x: 0, y: 900, width: 1600, height: 30 }
    const up = placePopover(
      { x: 100, y: 902, width: 80, height: 26 },
      lowBar,
      viewport,
      { measured: 260 },
      384
    )
    expect(up.side).toBe('above')
    expect(up.maxHeight).toBe(384)
    expect(up.side === 'above' && up.bottom).toBe(100)
  })

  it('is pure: the same inputs give the same box and touch neither argument', () => {
    const anchor = { x: 100, y: 42, width: 80, height: 26 }
    const a = placePopover(anchor, bar, viewport, 320)
    const b = placePopover(anchor, bar, viewport, 320)
    expect(a).toEqual(b)
    expect(anchor).toEqual({ x: 100, y: 42, width: 80, height: 26 })
    expect(bar).toEqual({ x: 0, y: 40, width: 1600, height: 30 })
  })
})
