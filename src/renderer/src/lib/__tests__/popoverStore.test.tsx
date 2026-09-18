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
