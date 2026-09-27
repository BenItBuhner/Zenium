// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, type JSX, type ReactElement } from 'react'
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
  // The swallow of a consumed press ends a tick after its release.
  await tick()
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
    // The reset (`tab.setZoom null`, as the F7 drive invoked it – Ctrl+0's and the menu's path,
    // not the bubble's own Reset, which since W8-F12 raises no bubble) is a `zoom.changed`:
    // `showZoomBubble` raises the step's own bubble – a notice that opened by itself, with no
    // chip to hang from (the chip left with the zoom) and holding no focus.
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
