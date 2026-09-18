// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect, useRef, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Rect } from '@shared/types'
import {
  ChromePortal,
  FrameDialogHost,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  chromeLayer,
  placePopover,
  useAnchorRect,
  useFrameDialog
} from '../portals'

/*
 * Where chrome surfaces render (lib/portals.tsx): modal dialogs in the content frame through
 * FrameDialogHost, whose scrim dims the frame only; popovers, menus and toasts through
 * ChromePortal, in the window-wide chrome layer; §9.20 geometry from placePopover. Both layers
 * are page surfaces (§9.29): their roots carry `data-surface="page"`.
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
})

const host = (): HTMLElement => mount!.querySelector<HTMLElement>('.zen-frame-dialogs')!
const scrim = (): HTMLElement | null => mount!.querySelector<HTMLElement>('.zen-frame-scrim')
const pressScrim = (): void => {
  act(() => {
    scrim()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
}

/** A dialog panel placed through the host, as the bookmark dialogs and prompts are. */
function Dialog({
  name,
  onScrimPress,
  active
}: {
  name: string
  onScrimPress?: () => void
  active?: boolean
}): JSX.Element {
  useFrameDialog({ onScrimPress, active })
  return <div data-dialog={name}>{name}</div>
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
    // The panel is a child of the host, in flow: the host centres it; nothing is `fixed`.
    const panel = host().querySelector<HTMLElement>('[data-dialog="edit"]')!
    expect(panel.parentElement).toBe(host())
    expect(scrim()!.nextElementSibling).toBe(panel)
    // The scrim is in flow too (a positioned one would paint over the panels and take their
    // clicks once their entrance animation is over): tree order puts it under them.
    expect(scrim()!.classList.contains('absolute')).toBe(false)
    expect(scrim()!.classList.contains('place-self-stretch')).toBe(true)
    rerender(<FrameDialogHost />)
    expect(host().hasAttribute('data-open')).toBe(false)
    expect(scrim()).toBeNull()
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

describe('placePopover (design-language-v2-draft §9.20)', () => {
  it('hangs flush from the bottom edge of the bar the anchor sits in, at a fixed width', () => {
    const box = placePopover(
      { x: 100, y: 42, width: 80, height: 26 },
      bar,
      viewport,
      POPOVER_WIDTH.list
    )
    expect(box.top).toBe(70)
    expect(box.width).toBe(320)
    expect(placePopover({ x: 100, y: 42, width: 80, height: 26 }, bar, viewport, 400).width).toBe(
      POPOVER_WIDTH.form
    )
    expect(placePopover({ x: 100, y: 42, width: 80, height: 26 }, bar, viewport, 480).width).toBe(
      POPOVER_WIDTH.table
    )
  })

  it('start-aligns with an anchor in the leading half of its bar', () => {
    const box = placePopover({ x: 100, y: 42, width: 80, height: 26 }, bar, viewport, 320)
    expect(box.left).toBe(100)
  })

  it('end-aligns with an anchor in the trailing half of its bar', () => {
    const box = placePopover({ x: 1200, y: 42, width: 80, height: 26 }, bar, viewport, 320)
    expect(box.left).toBe(1200 + 80 - 320)
  })

  it('stays 8px inside the window at either edge', () => {
    const left = placePopover({ x: 2, y: 42, width: 20, height: 26 }, bar, viewport, 320)
    expect(left.left).toBe(POPOVER_MARGIN)
    // A trailing anchor narrower than the popover would push it past the left edge of a narrow window.
    const narrow = { width: 300, height: 1000 }
    const squeezed = placePopover(
      { x: 260, y: 42, width: 28, height: 26 },
      { x: 0, y: 40, width: 300, height: 30 },
      narrow,
      320
    )
    expect(squeezed.left).toBe(narrow.width - 320 - POPOVER_MARGIN)
    // End-aligned with an anchor whose own end is 2px from the window's edge.
    const right = placePopover({ x: 1500, y: 42, width: 98, height: 26 }, bar, viewport, 320)
    expect(right.left).toBe(1600 - 320 - POPOVER_MARGIN)
    // A start-aligned anchor near the trailing edge of a wide bar is pulled back inside too.
    const wideBar = { x: 0, y: 40, width: 4000, height: 30 }
    const far = placePopover({ x: 1500, y: 42, width: 20, height: 26 }, wideBar, viewport, 320)
    expect(far.left).toBe(1600 - 320 - POPOVER_MARGIN)
  })

  it('offers at most 60% of the window height, less when the bar sits low', () => {
    const box = placePopover({ x: 100, y: 42, width: 80, height: 26 }, bar, viewport, 320)
    expect(box.maxHeight).toBe(600)
    const low = placePopover(
      { x: 100, y: 902, width: 80, height: 26 },
      { x: 0, y: 900, width: 1600, height: 30 },
      viewport,
      320
    )
    expect(low.maxHeight).toBe(1000 - 930 - POPOVER_MARGIN)
    const short = placePopover(
      { x: 100, y: 42, width: 80, height: 26 },
      bar,
      {
        width: 1600,
        height: 100
      },
      320
    )
    expect(short.maxHeight).toBe(100 - 70 - POPOVER_MARGIN)
    // A bar below the window's bottom edge leaves no room, never a negative height.
    const off = placePopover(
      { x: 100, y: 1002, width: 80, height: 26 },
      { x: 0, y: 1000, width: 1600, height: 30 },
      viewport,
      320
    )
    expect(off.maxHeight).toBe(0)
  })

  it('treats a lone anchor as its own bar: the star bubble with no pill on screen', () => {
    const anchor = { x: 1564, y: 28, width: 28, height: 28 }
    const box = placePopover(anchor, anchor, viewport, POPOVER_WIDTH.list)
    expect(box.top).toBe(56)
    expect(box.left).toBe(1600 - 320 - POPOVER_MARGIN)
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
