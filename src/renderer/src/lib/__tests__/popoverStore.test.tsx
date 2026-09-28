// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, useState, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  ChromePortal,
  closeAllPopovers,
  openPopover,
  openPopoverCount,
  subscribePopovers,
  useLightDismiss,
  type DismissReason,
  type PopoverChange
} from '../portals'
import { TAP_CLICK_CEILING_MS } from '../popoverStore'

/*
 * The chrome layer's light dismiss (lib/popoverStore.ts, design-language-v2-draft §9.20
 * amended): one popover at a time, closed on `pointerdown` outside it – the press consumed, so
 * a second anchor's first press only closes the open popover and the anchor's own press does
 * not reopen it – by scroll, by resize, by another popover opening; Escape stays with the
 * popover (§9.22), which the components test for themselves.
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

afterEach(async () => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  // The swallow of a consumed press ends a tick after its release; a touch's waits for its click
  // (W8-F20), and a fresh press ends whatever is still pending, so no test inherits a swallow.
  await tick()
  pointer('pointerdown', document.body, { pointerType: 'mouse' })
})

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const q = (selector: string): HTMLElement => document.querySelector<HTMLElement>(selector)!

/** A full press: down and up, as the pointer does, then the click the browser synthesises. */
function pointer(type: string, target: Element, init: PointerEventInit = {}): PointerEvent {
  const e = new PointerEvent(type, { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}
function mouse(type: string, target: Element): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}
/** What a press outside a popover produces, in order, and whether each was let through. */
function press(target: Element): { down: PointerEvent; up: PointerEvent; click: MouseEvent } {
  const down = pointer('pointerdown', target)
  mouse('mousedown', target)
  const up = pointer('pointerup', target)
  mouse('mouseup', target)
  const click = mouse('click', target)
  return { down, up, click }
}

/**
 * A popover through the chrome layer registered for light dismiss, with the anchor button that
 * opened it standing in the chrome.
 */
function Popover({
  name,
  onDismiss,
  anchor,
  disabled
}: {
  name: string
  onDismiss: (reason: DismissReason) => void
  anchor?: string
  disabled?: boolean
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLightDismiss(ref, onDismiss, {
    anchor: anchor ? () => document.querySelector(`[data-anchor="${anchor}"]`) : undefined,
    disabled
  })
  return (
    <ChromePortal>
      <div ref={ref} data-popover={name}>
        <button type="button" data-row={name}>
          row
        </button>
        <div data-body={name} />
      </div>
    </ChromePortal>
  )
}

/** The chrome: two anchors and the page, each counting the clicks that reach it. */
function Chrome({
  onClick,
  children
}: {
  onClick: (what: string) => void
  children?: React.ReactNode
}): JSX.Element {
  return (
    <div data-chrome>
      <button type="button" data-anchor="star" onClick={() => onClick('star')}>
        star
      </button>
      <button type="button" data-anchor="folder" onClick={() => onClick('folder')}>
        folder
      </button>
      <div data-page onClick={() => onClick('page')} />
      {children}
    </div>
  )
}

describe('useLightDismiss: a press outside closes on pointerdown and is consumed', () => {
  it('closes the popover a press lands outside of and lets nothing through', () => {
    const onDismiss = vi.fn()
    const onClick = vi.fn()
    render(
      <Chrome onClick={onClick}>
        <Popover name="bubble" onDismiss={onDismiss} anchor="star" />
      </Chrome>
    )
    expect(openPopoverCount()).toBe(1)
    const { down, up, click } = press(q('[data-page]'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith('outside')
    expect(openPopoverCount()).toBe(0)
    // Consumed: the press goes no further, and neither does the rest of it.
    expect(down.defaultPrevented).toBe(true)
    expect(up.defaultPrevented).toBe(true)
    expect(click.defaultPrevented).toBe(true)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('leaves the popover open for a press inside it, and the press alone', () => {
    const onDismiss = vi.fn()
    const rowClick = vi.fn()
    render(
      <Chrome onClick={vi.fn()}>
        <Popover name="bubble" onDismiss={onDismiss} anchor="star" />
      </Chrome>
    )
    q('[data-row="bubble"]').addEventListener('click', rowClick)
    const { down, click } = press(q('[data-row="bubble"]'))
    expect(onDismiss).not.toHaveBeenCalled()
    expect(down.defaultPrevented).toBe(false)
    expect(click.defaultPrevented).toBe(false)
    expect(rowClick).toHaveBeenCalledTimes(1)
    expect(openPopoverCount()).toBe(1)
  })

  it('a second anchor’s first press only closes the open popover; its second press is its own', async () => {
    const onDismiss = vi.fn()
    const onClick = vi.fn()
    render(
      <Chrome onClick={onClick}>
        <Popover name="bubble" onDismiss={onDismiss} anchor="star" />
      </Chrome>
    )
    press(q('[data-anchor="folder"]'))
    expect(onDismiss).toHaveBeenCalledWith('outside')
    expect(onClick).not.toHaveBeenCalled()
    // The popover unmounts on dismiss (as the real ones do); the swallow ends with the release.
    rerender(<Chrome onClick={onClick} />)
    await tick()
    press(q('[data-anchor="folder"]'))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledWith('folder')
  })

  it('the anchor’s own press closes its popover, does not reopen it, and takes the focus', () => {
    const onDismiss = vi.fn()
    const onClick = vi.fn()
    render(
      <Chrome onClick={onClick}>
        <Popover name="bubble" onDismiss={onDismiss} anchor="star" />
      </Chrome>
    )
    q('[data-row="bubble"]').focus()
    press(q('[data-anchor="star"]'))
    expect(onDismiss).toHaveBeenCalledWith('anchor')
    expect(onClick).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(q('[data-anchor="star"]'))
  })

  it('returns the focus a closed popover held to its anchor, unless the close handler moved it', async () => {
    const onClick = vi.fn()
    render(
      <Chrome onClick={onClick}>
        <Popover key="1" name="bubble" onDismiss={vi.fn()} anchor="star" />
      </Chrome>
    )
    q('[data-row="bubble"]').focus()
    press(q('[data-page]'))
    expect(document.activeElement).toBe(q('[data-anchor="star"]'))
    await tick()
    // The handler that focuses something else has the last word (a fresh popover: a dismissed
    // one is out of the registry for good).
    rerender(
      <Chrome onClick={onClick}>
        <Popover
          key="2"
          name="bubble"
          onDismiss={() => q('[data-anchor="folder"]').focus()}
          anchor="star"
        />
      </Chrome>
    )
    expect(openPopoverCount()).toBe(1)
    q('[data-row="bubble"]').focus()
    press(q('[data-page]'))
    expect(document.activeElement).toBe(q('[data-anchor="folder"]'))
    await tick()
    // Focus that was elsewhere stays there.
    rerender(
      <Chrome onClick={onClick}>
        <Popover key="3" name="bubble" onDismiss={vi.fn()} anchor="star" />
      </Chrome>
    )
    q('[data-anchor="folder"]').focus()
    press(q('[data-page]'))
    expect(document.activeElement).toBe(q('[data-anchor="folder"]'))
  })

  it('does not register a disabled popover (a phone sheet in the popover’s place)', () => {
    const onDismiss = vi.fn()
    render(
      <Chrome onClick={vi.fn()}>
        <Popover name="sheet" onDismiss={onDismiss} disabled />
      </Chrome>
    )
    expect(openPopoverCount()).toBe(0)
    press(q('[data-page]'))
    expect(onDismiss).not.toHaveBeenCalled()
    rerender(
      <Chrome onClick={vi.fn()}>
        <Popover name="sheet" onDismiss={onDismiss} />
      </Chrome>
    )
    expect(openPopoverCount()).toBe(1)
  })

  it('takes itself out of the registry when the popover unmounts (Escape, a row chosen)', () => {
    const onDismiss = vi.fn()
    render(
      <Chrome onClick={vi.fn()}>
        <Popover name="bubble" onDismiss={onDismiss} />
      </Chrome>
    )
    rerender(<Chrome onClick={vi.fn()} />)
    expect(openPopoverCount()).toBe(0)
    const { down } = press(q('[data-page]'))
    expect(onDismiss).not.toHaveBeenCalled()
    expect(down.defaultPrevented).toBe(false)
  })
})

describe('a popover that closed by itself leaves no swallowed press behind (W8-F11, §9.20)', () => {
  /*
   * The design lead's ruling on W8-F7's observation (the zoom bubble opened from its chip, Escape,
   * and the first press on the Share chip swallowed): "§9.20's light dismiss consumes only the
   * press that closes an open popover; after Escape has closed the zoom bubble none is open, so
   * the first press on Share must land; whatever `popoverStore` still holds after an Escape close
   * is the bug, not a rule." The pins: an Escape close (the component unmounts, the hook takes the
   * registration out) leaves no swallow armed and no listener consuming; the observation's own
   * mechanism – the reset's `zoom.changed` raising the step's bubble again, an OPEN popover under
   * the Share press – keeps §9.20's consumption.
   */
  it('REPRO: a popover self-closing while a swallow is armed leaves it armed, and swallows the next click', async () => {
    // The registry, driven without the hook (as the suite's last test is), so the arming and the
    // self-close interleave exactly. A popover is open; an outside `pointerdown` closes it and arms
    // the swallow for the rest of that press (§9.20). Then another popover opens and closes itself
    // (Escape, a row chosen, its anchor toggled) – a close that dismisses nothing, so it must arm
    // nothing and leave nothing armed. Before the fix the self-close's `syncListeners` reads the
    // still-armed swallow and keeps the window listeners on, so the store goes on eating events
    // with no open popover behind it: the next event to reach the swallow – a `click` a keyboard
    // activation raises with no `pointerdown` before it to disarm it, or the residue of the arming
    // press – is consumed. That residue is the bug (the design lead's ruling on W8-F7).
    const bubble = document.createElement('div')
    const anchor = document.createElement('button')
    const page = document.createElement('div')
    const other = document.createElement('button')
    const onOther = vi.fn()
    other.addEventListener('click', () => onOther())
    document.body.append(bubble, anchor, page, other)
    openPopover({ element: () => bubble, anchor: () => anchor, close: () => undefined })
    expect(openPopoverCount()).toBe(1)
    // The press that dismisses: its `pointerdown` closes the popover and arms the swallow (§9.20).
    const down = pointer('pointerdown', page)
    expect(down.defaultPrevented).toBe(true)
    expect(openPopoverCount()).toBe(0)
    // A popover self-closes: open one, then take it out through the registry's own unregister – the
    // path `useLightDismiss` runs on unmount (Escape, a chosen row, the anchor toggled).
    const unregister = openPopover({
      element: () => document.createElement('div'),
      close: () => undefined
    })
    unregister()
    expect(openPopoverCount()).toBe(0)
    // No popover is open. A `click` on another anchor – as a keyboard activation raises, with no
    // `pointerdown` before it – must reach the anchor, not be eaten by a swallow left behind.
    const click = mouse('click', other)
    expect(click.defaultPrevented, 'the click after a self-close, no popover open').toBe(false)
    expect(onOther).toHaveBeenCalledTimes(1)
    bubble.remove()
    anchor.remove()
    page.remove()
    other.remove()
    await tick()
  })

  function pressLandsWhole(target: Element, onClick: ReturnType<typeof vi.fn>, what: string): void {
    const down = pointer('pointerdown', target)
    const mousedown = mouse('mousedown', target)
    const up = pointer('pointerup', target)
    const mouseup = mouse('mouseup', target)
    const click = mouse('click', target)
    for (const [name, e] of Object.entries({ down, mousedown, up, mouseup, click })) {
      expect(e.defaultPrevented, `${name} of the press on ${what}`).toBe(false)
    }
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledWith(what)
  }

  it('Escape: the zoom bubble closes by itself, the chip takes the keyboard back, and the FIRST press on Share lands whole', () => {
    const onDismiss = vi.fn()
    const onClick = vi.fn()
    render(
      <Chrome onClick={onClick}>
        <Popover name="zoom" onDismiss={onDismiss} anchor="star" />
      </Chrome>
    )
    q('[data-row="zoom"]').focus()
    expect(openPopoverCount()).toBe(1)
    // Escape stays with the popover: its trap closes it (the component unmounts, `useLightDismiss`
    // unregisters) and hands the focus to its anchor (§9.22). The registry hears nothing of it.
    rerender(<Chrome onClick={onClick} />)
    q('[data-anchor="star"]').focus()
    expect(openPopoverCount()).toBe(0)
    expect(onDismiss).not.toHaveBeenCalled()
    // The first press on the other anchor: nothing consumed, its click its own.
    pressLandsWhole(q('[data-anchor="folder"]'), onClick, 'folder')
    expect(onDismiss).not.toHaveBeenCalled()
    // And a click with no press before it (Enter or Space on the anchor) is nobody's remainder.
    const keyboard = mouse('click', q('[data-anchor="star"]'))
    expect(keyboard.defaultPrevented).toBe(false)
    expect(onClick).toHaveBeenLastCalledWith('star')
  })

  it('a row chosen, the anchor toggled: the same close by the popover itself, the same first press', () => {
    const onClick = vi.fn()
    // A row chosen: the popover unmounts itself, a press on the page follows.
    render(
      <Chrome onClick={onClick}>
        <Popover name="menu" onDismiss={vi.fn()} anchor="star" />
      </Chrome>
    )
    rerender(<Chrome onClick={onClick} />)
    pressLandsWhole(q('[data-page]'), onClick, 'page')
    onClick.mockClear()
    // The anchor toggled from the keyboard (its Enter): the popover goes without a press, and the
    // next press on the anchor is a fresh press.
    rerender(
      <Chrome onClick={onClick}>
        <Popover name="menu" onDismiss={vi.fn()} anchor="star" />
      </Chrome>
    )
    expect(openPopoverCount()).toBe(1)
    rerender(<Chrome onClick={onClick} />)
    pressLandsWhole(q('[data-anchor="star"]'), onClick, 'star')
  })

  it('a child closing by itself under its parent keeps the parent’s light dismiss on', () => {
    const bubble = vi.fn()
    const onClick = vi.fn()
    function Bubble(): JSX.Element {
      const ref = useRef<HTMLDivElement>(null)
      useLightDismiss(ref, bubble, { anchor: () => q('[data-anchor="star"]') })
      return (
        <ChromePortal>
          <div ref={ref} data-popover="bubble">
            <button type="button" data-anchor="trigger">
              folder
            </button>
          </div>
        </ChromePortal>
      )
    }
    render(
      <Chrome onClick={onClick}>
        <Bubble />
        <Popover name="list" onDismiss={vi.fn()} anchor="trigger" />
      </Chrome>
    )
    expect(openPopoverCount()).toBe(2)
    // The list's Escape: the list alone goes; the bubble is still open, so a press outside it is
    // still §9.20's consumed dismiss.
    rerender(
      <Chrome onClick={onClick}>
        <Bubble />
      </Chrome>
    )
    expect(openPopoverCount()).toBe(1)
    const { down, click } = press(q('[data-page]'))
    expect(bubble).toHaveBeenCalledWith('outside')
    expect(down.defaultPrevented).toBe(true)
    expect(click.defaultPrevented).toBe(true)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('W8-F7’s sequence: the reset’s bubble is an OPEN popover, and the press that closes it is consumed (§9.20 kept); the press after it lands', async () => {
    const chipBubble = vi.fn()
    const resetBubble = vi.fn()
    const onClick = vi.fn()
    // The chip's bubble, closed by Escape.
    render(
      <Chrome onClick={onClick}>
        <Popover key="chip" name="zoom" onDismiss={chipBubble} anchor="star" />
      </Chrome>
    )
    rerender(<Chrome onClick={onClick} />)
    expect(openPopoverCount()).toBe(0)
    // The reset (`tab.setZoom null`, as the F7 drive invoked it) came back as a `zoom.changed`
    // and, as `showZoomBubble` had it before W8-F12, raised the step's own bubble – a notice that
    // opened by itself, with no chip to hang from (the chip left with the zoom) and holding no
    // focus. Since W8-F12 a change that leaves no chip raises no bubble on any road, so this is
    // the store's own rule for a popover standing with no anchor, as the F7 observation met it.
    rerender(
      <Chrome onClick={onClick}>
        <Popover key="reset" name="zoom" onDismiss={resetBubble} />
      </Chrome>
    )
    expect(openPopoverCount()).toBe(1)
    expect(chipBubble).not.toHaveBeenCalled()
    // The Share press under it: the light dismiss closes that bubble and consumes the press –
    // pointerdown cancelled (so no compatibility mousedown), pointerup and click swallowed.
    const first = press(q('[data-anchor="folder"]'))
    expect(resetBubble).toHaveBeenCalledTimes(1)
    expect(resetBubble).toHaveBeenCalledWith('outside')
    expect(first.down.defaultPrevented).toBe(true)
    expect(first.up.defaultPrevented).toBe(true)
    expect(first.click.defaultPrevented).toBe(true)
    expect(onClick).not.toHaveBeenCalled()
    expect(openPopoverCount()).toBe(0)
    // The bubble unmounts on its dismiss; the swallow ends with the release; the second press is
    // the anchor's own – the observation's "the second press works".
    rerender(<Chrome onClick={onClick} />)
    await tick()
    pressLandsWhole(q('[data-anchor="folder"]'), onClick, 'folder')
  })

  it('the swallow armed by an outside press ends with that press: a click with no press after it is not swallowed', async () => {
    const onDismiss = vi.fn()
    const onClick = vi.fn()
    render(
      <Chrome onClick={onClick}>
        <Popover name="bubble" onDismiss={onDismiss} anchor="star" />
      </Chrome>
    )
    // The press that dismisses: down (consumed), up (swallowed), click (swallowed).
    press(q('[data-page]'))
    expect(onDismiss).toHaveBeenCalledWith('outside')
    expect(onClick).not.toHaveBeenCalled()
    rerender(<Chrome onClick={onClick} />)
    await tick()
    // Enter on the star: a click without a pointer press. Nothing left to swallow it.
    const keyboard = mouse('click', q('[data-anchor="star"]'))
    expect(keyboard.defaultPrevented).toBe(false)
    expect(onClick).toHaveBeenCalledWith('star')
  })
})

describe('useLightDismiss: scroll, resize, one at a time', () => {
  it('closes on a scroll or a wheel outside the popover, not on its own body scrolling', () => {
    const onDismiss = vi.fn()
    render(
      <Chrome onClick={vi.fn()}>
        <Popover name="bubble" onDismiss={onDismiss} />
      </Chrome>
    )
    act(() => {
      q('[data-body="bubble"]').dispatchEvent(new Event('scroll'))
    })
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => {
      q('[data-page]').dispatchEvent(new Event('scroll'))
    })
    expect(onDismiss).toHaveBeenCalledWith('scroll')
    // A wheel turned over the frame's snapshot or a bar, which scrolls nothing in the chrome.
    rerender(
      <Chrome onClick={vi.fn()}>
        <Popover key="menu" name="menu" onDismiss={onDismiss} />
      </Chrome>
    )
    expect(openPopoverCount()).toBe(1)
    act(() => {
      q('[data-body="menu"]').dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    act(() => {
      q('[data-page]').dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    expect(onDismiss).toHaveBeenCalledTimes(2)
    expect(onDismiss).toHaveBeenLastCalledWith('scroll')
  })

  it('leaves the popover alone on a Ctrl+wheel (a zoom, not a scroll)', () => {
    const onDismiss = vi.fn()
    render(
      <Chrome onClick={vi.fn()}>
        <Popover name="zoom" onDismiss={onDismiss} />
      </Chrome>
    )
    // A browser's WheelEvent is a MouseEvent (with the modifier keys); happy-dom's is not.
    act(() => {
      q('[data-page]').dispatchEvent(new MouseEvent('wheel', { bubbles: true, ctrlKey: true }))
    })
    expect(onDismiss).not.toHaveBeenCalled()
    expect(openPopoverCount()).toBe(1)
    act(() => {
      q('[data-page]').dispatchEvent(new MouseEvent('wheel', { bubbles: true }))
    })
    expect(onDismiss).toHaveBeenCalledWith('scroll')
  })

  it('closes on a window resize', () => {
    const onDismiss = vi.fn()
    render(
      <Chrome onClick={vi.fn()}>
        <Popover name="bubble" onDismiss={onDismiss} />
      </Chrome>
    )
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(onDismiss).toHaveBeenCalledWith('resize')
  })

  it('closes the open popover when another opens by shortcut or command (one at a time)', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(
      <Chrome onClick={vi.fn()}>
        <Popover name="bubble" onDismiss={first} anchor="star" />
      </Chrome>
    )
    rerender(
      <Chrome onClick={vi.fn()}>
        <Popover name="bubble" onDismiss={first} anchor="star" />
        <Popover name="panel" onDismiss={second} anchor="folder" />
      </Chrome>
    )
    expect(first).toHaveBeenCalledWith('replaced')
    expect(second).not.toHaveBeenCalled()
    expect(openPopoverCount()).toBe(1)
  })

  it('keeps a parent open under its child: a list whose trigger is inside the bubble', () => {
    const bubble = vi.fn()
    const list = vi.fn()
    function Bubble(): JSX.Element {
      const ref = useRef<HTMLDivElement>(null)
      useLightDismiss(ref, bubble, { anchor: () => q('[data-anchor="star"]') })
      return (
        <ChromePortal>
          <div ref={ref} data-popover="bubble">
            <input data-name />
            <button type="button" data-anchor="trigger">
              folder
            </button>
          </div>
        </ChromePortal>
      )
    }
    render(
      <Chrome onClick={vi.fn()}>
        <Bubble />
      </Chrome>
    )
    rerender(
      <Chrome onClick={vi.fn()}>
        <Bubble />
        <Popover name="list" onDismiss={list} anchor="trigger" />
      </Chrome>
    )
    // Opening the child closed nothing.
    expect(bubble).not.toHaveBeenCalled()
    expect(openPopoverCount()).toBe(2)
    // A press inside the child keeps both.
    press(q('[data-row="list"]'))
    expect(bubble).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    // A press in the bubble, outside the list, closes the list only – consumed.
    q('[data-row="list"]').focus()
    const inBubble = press(q('[data-name]'))
    expect(list).toHaveBeenCalledWith('outside')
    expect(bubble).not.toHaveBeenCalled()
    expect(inBubble.down.defaultPrevented).toBe(true)
    // The focus the list held goes back to its trigger.
    expect(document.activeElement).toBe(q('[data-anchor="trigger"]'))
  })

  it('a press outside both closes child and parent, the child first, focus to the outer anchor', async () => {
    const order: string[] = []
    const bubble = (): void => {
      order.push('bubble')
    }
    const list = (): void => {
      order.push('list')
    }
    function Bubble(): JSX.Element {
      const ref = useRef<HTMLDivElement>(null)
      useLightDismiss(ref, bubble, { anchor: () => q('[data-anchor="star"]') })
      return (
        <ChromePortal>
          <div ref={ref} data-popover="bubble">
            <button type="button" data-anchor="trigger">
              folder
            </button>
          </div>
        </ChromePortal>
      )
    }
    render(
      <Chrome onClick={vi.fn()}>
        <Bubble />
      </Chrome>
    )
    rerender(
      <Chrome onClick={vi.fn()}>
        <Bubble />
        <Popover name="list" onDismiss={list} anchor="trigger" />
      </Chrome>
    )
    q('[data-row="list"]').focus()
    press(q('[data-page]'))
    expect(order).toEqual(['list', 'bubble'])
    expect(openPopoverCount()).toBe(0)
    expect(document.activeElement).toBe(q('[data-anchor="star"]'))
  })

  it('closeAllPopovers closes everything, and the registry can be driven without the hook', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const close = vi.fn()
    const unregister = openPopover({ element: () => el, close })
    expect(openPopoverCount()).toBe(1)
    closeAllPopovers()
    expect(close).toHaveBeenCalledWith('all')
    expect(openPopoverCount()).toBe(0)
    // Unregistering a popover the registry already closed is a no-op.
    unregister()
    expect(openPopoverCount()).toBe(0)
    el.remove()
  })
})

describe('subscribePopovers: chrome that is not a popover but keeps one at a time (the tab hover card)', () => {
  it('hears a popover open, the registry closing popovers, and closeAllPopovers with none open', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const heard: PopoverChange[] = []
    const stop = subscribePopovers((change) => heard.push(change))
    const unregister = openPopover({ element: () => el, close: () => undefined })
    expect(heard).toEqual(['open'])
    // A press outside: closed by the registry, reported with its reason.
    pointer('pointerdown', document.body)
    expect(heard).toEqual(['open', 'outside'])
    expect(openPopoverCount()).toBe(0)
    // A frame dialog opening clears the layer whether or not a popover was up.
    closeAllPopovers('all')
    expect(heard).toEqual(['open', 'outside', 'all'])
    // A popover taking itself out (Escape, a row chosen) is not an event.
    openPopover({ element: () => el, close: () => undefined })()
    expect(heard).toEqual(['open', 'outside', 'all', 'open'])
    stop()
    openPopover({ element: () => el, close: () => undefined })
    expect(heard).toHaveLength(4)
    unregister()
    el.remove()
  })

  it('a popover opening by command over another reports the open (the replaced one closes first)', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    document.body.append(a, b)
    const heard: PopoverChange[] = []
    const stop = subscribePopovers((change) => heard.push(change))
    openPopover({ element: () => a, close: () => undefined })
    openPopover({ element: () => b, close: () => undefined })
    expect(heard).toEqual(['open', 'replaced', 'open'])
    expect(openPopoverCount()).toBe(1)
    stop()
    a.remove()
    b.remove()
  })
})

describe('a tap’s late click (W8-F20, §9.20): the consumed press’s remainder includes the click a touch still owes', () => {
  /*
   * Android's finding on #687's tablet run: the bookmarks bar's » chip, tapped while its panel was
   * open, closed the panel – and the panel came back 1.75 s later with no finger on the glass. The
   * store ended the swallow on a 0 ms timer after the release, reasoning that a press's `click` is
   * dispatched with its release. True of a mouse: Chromium dispatches a mouse's click in the same
   * task as its `pointerup`. Not of a touch: a tap's click is the browser's gesture, dispatched
   * from its gesture detector a task later – measured in Electron 44 (Chromium 152) for this
   * slice at 0.3–1.2 ms after `pointerup`, and after a 0 ms timer armed at `pointerup` in 39 of
   * 40 taps. It outran the timer, reached the anchor un-swallowed, and toggled the popover open
   * again. The fix: a touch or pen release keeps the swallow on until the press's click (or
   * `auxclick`, `contextmenu`) has been swallowed, bounded by `TAP_CLICK_CEILING_MS` for a release
   * that owes none; a mouse's release ends it as before; a keyboard's click passes meanwhile.
   *
   * The events are Chromium's shapes: `pointerdown` / `pointerup` carry the `pointerType`; the
   * click is a `PointerEvent` with the pointer's type and `detail` 1; a keyboard's click (Enter or
   * Space on the focused control) has `pointerType` '' and `detail` 0.
   */
  type Pointer = 'mouse' | 'touch' | 'pen' | ''

  /** A pointer's press: down and up, as Chromium delivers them, in one task. */
  function pointerPress(
    target: Element,
    pointerType: Pointer
  ): { down: PointerEvent; up: PointerEvent } {
    const init = { pointerType, pointerId: pointerType === 'mouse' ? 1 : 7, isPrimary: true }
    const down = pointer('pointerdown', target, init)
    const up = pointer('pointerup', target, init)
    return { down, up }
  }
  /** The `click` a press produces: a PointerEvent carrying the pointer's type, `detail` 1. */
  function pointerClick(target: Element, pointerType: Pointer): PointerEvent {
    return pointer('click', target, { pointerType, detail: 1 })
  }
  /** A keyboard's click – Enter or Space on the focused control – with no pointer behind it. */
  function keyboardClick(target: Element): PointerEvent {
    return pointer('click', target, { pointerType: '', detail: 0 })
  }
  /** A finger's (or a pen's) tap: the press in one task, the click a task later. */
  async function tap(
    target: Element,
    pointerType: 'touch' | 'pen' = 'touch'
  ): Promise<{ down: PointerEvent; up: PointerEvent; click: PointerEvent }> {
    const { down, up } = pointerPress(target, pointerType)
    await tick()
    const click = pointerClick(target, pointerType)
    return { down, up, click }
  }

  /** An anchor that toggles its popover on click – the » chip and its panel, the star and its bubble. */
  function Toggle({ onClick }: { onClick: (what: string) => void }): JSX.Element {
    const [open, setOpen] = useState(false)
    return (
      <div data-chrome>
        <button
          type="button"
          data-anchor="more"
          aria-expanded={open}
          onClick={() => {
            onClick('more')
            setOpen((v) => !v)
          }}
        >
          more
        </button>
        <div data-page onClick={() => onClick('page')} />
        {open && <Popover name="panel" onDismiss={() => setOpen(false)} anchor="more" />}
      </div>
    )
  }

  it.each(['touch', 'pen'] as const)(
    'RED on main: a %s tap on the anchor closes its popover, and the tap’s click – a task later – is swallowed, so the popover stays closed',
    async (kind) => {
      const onClick = vi.fn()
      render(<Toggle onClick={onClick} />)
      // The first tap opens: no popover is open, so the press is nobody's to consume.
      const first = await tap(q('[data-anchor="more"]'), kind)
      expect(first.down.defaultPrevented).toBe(false)
      expect(first.click.defaultPrevented).toBe(false)
      expect(onClick).toHaveBeenCalledTimes(1)
      expect(openPopoverCount()).toBe(1)
      expect(q('[data-anchor="more"]').getAttribute('aria-expanded')).toBe('true')
      // The second tap: its press closes the panel (reason `anchor`) and is consumed …
      const second = await tap(q('[data-anchor="more"]'), kind)
      expect(second.down.defaultPrevented).toBe(true)
      expect(second.up.defaultPrevented).toBe(true)
      // … and its click, dispatched a task after the release, is that press's own: swallowed.
      expect(second.click.defaultPrevented, 'the tap’s late click').toBe(true)
      expect(onClick, 'the tap’s late click reached the anchor').toHaveBeenCalledTimes(1)
      expect(openPopoverCount(), 'the popover reopened from the tap’s click').toBe(0)
      expect(q('[data-anchor="more"]').getAttribute('aria-expanded')).toBe('false')
    }
  )

  it('a mouse press (unchanged): its click comes with the release and is swallowed; the swallow ends a tick after the release and the listeners come off', async () => {
    const onDismiss = vi.fn()
    const onClick = vi.fn()
    const removed = vi.spyOn(window, 'removeEventListener')
    render(
      <Chrome onClick={onClick}>
        <Popover name="bubble" onDismiss={onDismiss} anchor="star" />
      </Chrome>
    )
    const { down, up } = pointerPress(q('[data-anchor="star"]'), 'mouse')
    // Chromium dispatches a mouse's click in the same task as its `pointerup`.
    const click = pointerClick(q('[data-anchor="star"]'), 'mouse')
    expect(onDismiss).toHaveBeenCalledWith('anchor')
    expect(down.defaultPrevented).toBe(true)
    expect(up.defaultPrevented).toBe(true)
    expect(click.defaultPrevented).toBe(true)
    expect(onClick).not.toHaveBeenCalled()
    // The popover unmounts on its dismiss; the listeners stay on for the rest of the press …
    rerender(<Chrome onClick={onClick} />)
    expect(removed).not.toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
    // … and come off a tick after the release, as before this slice.
    await tick()
    expect(removed).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
    expect(removed).toHaveBeenCalledWith('click', expect.any(Function), true)
    const after = pointerClick(q('[data-anchor="star"]'), 'mouse')
    expect(after.defaultPrevented).toBe(false)
    expect(onClick).toHaveBeenCalledWith('star')
    removed.mockRestore()
  })

  it('a mouse press (unchanged): a mouse’s click that arrives a task after the release is not swallowed – the mouse’s swallow ends as it did', async () => {
    const onClick = vi.fn()
    render(
      <Chrome onClick={onClick}>
        <Popover name="bubble" onDismiss={vi.fn()} anchor="star" />
      </Chrome>
    )
    pointerPress(q('[data-anchor="star"]'), 'mouse')
    rerender(<Chrome onClick={onClick} />)
    await tick()
    // No such click exists for a real mouse; the shape pins that the mouse's swallow is not longer.
    expect(pointerClick(q('[data-anchor="star"]'), 'mouse').defaultPrevented).toBe(false)
    expect(onClick).toHaveBeenCalledWith('star')
    onClick.mockClear()
    // A release with no `pointerType` (the empty string) is the mouse's road too.
    rerender(
      <Chrome onClick={onClick}>
        <Popover key="2" name="bubble" onDismiss={vi.fn()} anchor="star" />
      </Chrome>
    )
    expect(openPopoverCount()).toBe(1)
    pointerPress(q('[data-page]'), '')
    expect(openPopoverCount()).toBe(0)
    rerender(<Chrome onClick={onClick} />)
    await tick()
    expect(mouse('click', q('[data-page]')).defaultPrevented).toBe(false)
    expect(onClick).toHaveBeenCalledWith('page')
  })

  it('a keyboard’s click during a touch swallow is nobody’s remainder: it passes, and the tap’s click is still swallowed after it', async () => {
    const onDismiss = vi.fn()
    const onClick = vi.fn()
    render(
      <Chrome onClick={onClick}>
        <Popover name="bubble" onDismiss={onDismiss} anchor="star" />
      </Chrome>
    )
    const { down, up } = pointerPress(q('[data-page]'), 'touch')
    expect(onDismiss).toHaveBeenCalledWith('outside')
    expect(down.defaultPrevented).toBe(true)
    expect(up.defaultPrevented).toBe(true)
    rerender(<Chrome onClick={onClick} />)
    await tick()
    // Enter on the folder anchor while the tap's click is still owed: no pointer behind it, it lands.
    const keyboard = keyboardClick(q('[data-anchor="folder"]'))
    expect(keyboard.defaultPrevented).toBe(false)
    expect(onClick).toHaveBeenCalledWith('folder')
    // A `click()` from a script the same (no pointer, `detail` 0).
    const scripted = mouse('click', q('[data-anchor="folder"]'))
    expect(scripted.defaultPrevented).toBe(false)
    expect(onClick).toHaveBeenCalledTimes(2)
    // The tap's own click, still to come, is still the press's: swallowed.
    const click = pointerClick(q('[data-page]'), 'touch')
    expect(click.defaultPrevented).toBe(true)
    expect(onClick).toHaveBeenCalledTimes(2)
    // And with it the press is over: a pointer's click after it (a new press's) passes.
    expect(pointerClick(q('[data-anchor="star"]'), 'touch').defaultPrevented).toBe(false)
    expect(onClick).toHaveBeenLastCalledWith('star')
  })

  it('a second tap is a fresh press: it reopens; the tap after that closes again and stays closed', async () => {
    const onClick = vi.fn()
    render(<Toggle onClick={onClick} />)
    await tap(q('[data-anchor="more"]'))
    expect(openPopoverCount()).toBe(1)
    await tap(q('[data-anchor="more"]'))
    expect(openPopoverCount()).toBe(0)
    // The third tap: nothing is open, so its press is consumed by nothing and its click opens.
    const third = await tap(q('[data-anchor="more"]'))
    expect(third.down.defaultPrevented).toBe(false)
    expect(third.click.defaultPrevented).toBe(false)
    expect(openPopoverCount()).toBe(1)
    expect(q('[data-anchor="more"]').getAttribute('aria-expanded')).toBe('true')
    const fourth = await tap(q('[data-anchor="more"]'))
    expect(fourth.click.defaultPrevented).toBe(true)
    expect(openPopoverCount()).toBe(0)
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('the next pointerdown ends the wait: a second tap that lands before the first’s click is a fresh press, whole', async () => {
    const onClick = vi.fn()
    render(<Toggle onClick={onClick} />)
    await tap(q('[data-anchor="more"]'))
    expect(openPopoverCount()).toBe(1)
    // The closing tap's press, its click not yet come (Chromium's double tap withholds the first
    // tap's click when a second tap lands inside the double-tap window).
    const closing = pointerPress(q('[data-anchor="more"]'), 'touch')
    expect(closing.down.defaultPrevented).toBe(true)
    expect(openPopoverCount()).toBe(0)
    await tick()
    // The second tap's press: nothing is open, so nothing is consumed – the wait for the first's
    // click is over, and this press's click is its own.
    const next = await tap(q('[data-anchor="more"]'))
    expect(next.down.defaultPrevented).toBe(false)
    expect(next.up.defaultPrevented).toBe(false)
    expect(next.click.defaultPrevented).toBe(false)
    expect(openPopoverCount()).toBe(1)
  })

  it('a cancelled touch – one that scrolled, one the platform took over – owes no click: the swallow ends with the cancel, as a mouse’s does with its release', async () => {
    const onDismiss = vi.fn()
    const onClick = vi.fn()
    const removed = vi.spyOn(window, 'removeEventListener')
    render(
      <Chrome onClick={onClick}>
        <Popover name="bubble" onDismiss={onDismiss} anchor="star" />
      </Chrome>
    )
    const init = { pointerType: 'touch', pointerId: 7, isPrimary: true }
    const down = pointer('pointerdown', q('[data-page]'), init)
    expect(onDismiss).toHaveBeenCalledWith('outside')
    expect(down.defaultPrevented).toBe(true)
    const cancel = pointer('pointercancel', q('[data-page]'), init)
    expect(cancel.defaultPrevented).toBe(true)
    rerender(<Chrome onClick={onClick} />)
    await tick()
    expect(removed).toHaveBeenCalledWith('click', expect.any(Function), true)
    // Nothing waits: a pointer's click now is a new press's.
    expect(pointerClick(q('[data-anchor="star"]'), 'touch').defaultPrevented).toBe(false)
    expect(onClick).toHaveBeenCalledWith('star')
    removed.mockRestore()
  })

  it('a release that owes no click: the swallow ends at the ceiling, the listeners come off, and a pointer’s click after it passes', () => {
    vi.useFakeTimers()
    const removed = vi.spyOn(window, 'removeEventListener')
    const bubble = document.createElement('div')
    const page = document.createElement('button')
    const onPage = vi.fn()
    page.addEventListener('click', onPage)
    document.body.append(bubble, page)
    try {
      // Short of the ceiling the swallow still waits: the tap's click, however late, is eaten.
      openPopover({ element: () => bubble, close: () => undefined })
      pointerPress(page, 'touch')
      expect(openPopoverCount()).toBe(0)
      vi.advanceTimersByTime(TAP_CLICK_CEILING_MS - 1)
      expect(removed).not.toHaveBeenCalledWith('click', expect.any(Function), true)
      expect(pointerClick(page, 'touch').defaultPrevented).toBe(true)
      expect(onPage).not.toHaveBeenCalled()
      // That click ended the press; the listeners are off.
      expect(removed).toHaveBeenCalledWith('click', expect.any(Function), true)
      removed.mockClear()
      // A release whose click never comes: at the ceiling the swallow ends and the listeners come
      // off, and a pointer's click after it – a new press's – passes.
      openPopover({ element: () => bubble, close: () => undefined })
      pointerPress(page, 'touch')
      expect(openPopoverCount()).toBe(0)
      vi.advanceTimersByTime(TAP_CLICK_CEILING_MS - 1)
      expect(removed).not.toHaveBeenCalledWith('click', expect.any(Function), true)
      vi.advanceTimersByTime(1)
      expect(removed).toHaveBeenCalledWith('click', expect.any(Function), true)
      expect(pointerClick(page, 'touch').defaultPrevented).toBe(false)
      expect(onPage).toHaveBeenCalledTimes(1)
    } finally {
      removed.mockRestore()
      vi.useRealTimers()
      bubble.remove()
      page.remove()
    }
  })

  it('the tap’s click, swallowed, ends the press: the listeners come off with it (none open behind them)', async () => {
    const onClick = vi.fn()
    const removed = vi.spyOn(window, 'removeEventListener')
    render(<Toggle onClick={onClick} />)
    await tap(q('[data-anchor="more"]'))
    const { down, up } = pointerPress(q('[data-anchor="more"]'), 'touch')
    expect(down.defaultPrevented).toBe(true)
    expect(up.defaultPrevented).toBe(true)
    await tick()
    // Still waiting for the click: the listeners are on.
    expect(removed).not.toHaveBeenCalledWith('click', expect.any(Function), true)
    const click = pointerClick(q('[data-anchor="more"]'), 'touch')
    expect(click.defaultPrevented).toBe(true)
    expect(removed).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
    expect(removed).toHaveBeenCalledWith('click', expect.any(Function), true)
    expect(openPopoverCount()).toBe(0)
    removed.mockRestore()
  })
})
