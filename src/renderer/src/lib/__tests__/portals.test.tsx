// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect, useRef, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Rect } from '@shared/types'
import { dispatchBackEvent, topBackSurface } from '../back'
import { viewportStore } from '../formFactor'
import { registerRecedeLayer } from '../motion/recede'
import { BACK_PEEK, sheetBackPosition } from '../motion/sheet'
import { invalidateSnapshot, pageHidden, uiStore } from '../ui'
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
  intrinsicSize,
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
/** The panels the hosts keep for the way out, in tree order. */
const leaving = (): HTMLElement[] => [
  ...mount!.querySelectorAll<HTMLElement>('.zen-frame-dialogs-slot > [data-leaving]')
]
/**
 * End the way out on a mouse: every kept panel's exit animation reports its end (happy-dom
 * runs no animation; the host listens for the event on the panel itself).
 */
const endExit = (): void => {
  act(() => {
    for (const panel of leaving()) panel.dispatchEvent(new Event('animationend'))
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

/** The stylesheet, whitespace folded (prettier breaks a long selector over several lines). */
const cssText = (): string =>
  readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8').replace(/\s+/g, ' ')

/** The stylesheet's rules for a selector, as one string (`main.css` is not loaded in happy-dom). */
function cssRule(selector: string): string {
  const css = cssText()
  const at = css.indexOf(`${selector} {`)
  expect(at, `a rule for ${selector}`).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
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
    // The panel and the scrim stay for the way out (tested below); at its end both are gone.
    expect(leaving()).toEqual([panel])
    endExit()
    expect(scrim()).toBeNull()
    expect(slot()).not.toBeNull()
    expect(slot().childElementCount).toBe(0)
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
    // The prompt's panel and the host's scrim leave together; the sheet's own scrim stays.
    expect(leaving().map((el) => el.dataset.dialog)).toEqual(['prompt'])
    expect(scrim()!.getAttribute('data-leaving')).toBe('true')
    endExit()
    expect(scrim()).toBeNull()
    expect(slot().querySelector('[data-dialog="menu"]')).not.toBeNull()
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
    // The sheet goes; the host closes, its scrim fading out with the kept panel (the way out,
    // tested below).
    rerender(
      <>
        <FrameDialogHost frame />
        <div data-panel />
      </>
    )
    expect(host().hasAttribute('data-open')).toBe(false)
    expect(scrim()!.getAttribute('data-leaving')).toBe('true')
    endExit()
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

/**
 * A dialog that returns null the moment its state clears – the page's alert (`PageDialogs`),
 * the window's prompts, the bookmark dialogs, the star card on a phone – with its panel placed
 * through the host.
 */
function Prompt({
  open,
  name = 'prompt',
  onScrimPress
}: {
  open: boolean
  name?: string
  onScrimPress?: () => void
}): JSX.Element | null {
  if (!open) return null
  return <Dialog name={name} onScrimPress={onScrimPress} />
}
const dialogNames = (): Array<string | undefined> =>
  [...slot().children].map((el) => (el as HTMLElement).dataset.dialog)

/*
 * The way out on a mouse (lib/portals.tsx, `useLeavingPanels`): a dialog that unmounts its
 * panel the moment its state clears leaves the panel with the host, which keeps the element
 * itself in the slot – `data-leaving`, `inert`, `aria-hidden` – through the pop in reverse and
 * the scrim's fade, and drops it as its animation ends. Until then the host is up for it – it
 * keeps the pointer, the chrome stays inert and the page stays under its picture – and a dialog
 * opening meanwhile ends the way out at once. No dialog needs to know. The phone pose is not
 * the host's (the sheet chassis runs the leave there; tested with the chassis below).
 */
describe('the way out: the host keeps a closed dialog’s panel through its exit', () => {
  afterEach(() => {
    uiStore.set({ snapshot: null, snapshotTabId: null, pageDialogOpen: false })
  })

  it('keeps the panel in the slot – the element itself, inert and hidden from AT – and drops it as its exit animation ends', () => {
    render(
      <Chrome>
        <FrameDialogHost>
          <Prompt open />
        </FrameDialogHost>
      </Chrome>
    )
    const panel = slot().querySelector<HTMLElement>('[data-dialog="prompt"]')!
    rerender(
      <Chrome>
        <FrameDialogHost>
          <Prompt open={false} />
        </FrameDialogHost>
      </Chrome>
    )
    // The very element, back where it stood, marked for the way out: it takes no press and no
    // focus and is nothing to assistive technology (§9.22).
    expect(panel.parentElement).toBe(slot())
    expect(panel.hasAttribute('data-leaving')).toBe(true)
    expect(panel.hasAttribute('inert')).toBe(true)
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    // The host is still up for it: no dialog (`data-open` off) but `data-leaving` on, so it
    // keeps the pointer; the scrim fades with the panel; the chrome stays inert (§9.5).
    expect(host().hasAttribute('data-open')).toBe(false)
    expect(host().getAttribute('data-leaving')).toBe('true')
    expect(scrim()!.getAttribute('data-leaving')).toBe('true')
    expect(inert(chrome('sidebar'))).toBe(true)
    expect(chromeInertHeld()).toBe(true)
    // A descendant's animation ending is not the panel's.
    act(() => {
      const child = panel.appendChild(document.createElement('span'))
      child.dispatchEvent(new Event('animationend', { bubbles: true }))
    })
    expect(panel.parentElement).toBe(slot())
    // Its own end: gone for good, the host idle, the chrome back.
    endExit()
    expect(panel.parentElement).toBeNull()
    expect(slot().childElementCount).toBe(0)
    expect(host().hasAttribute('data-leaving')).toBe(false)
    expect(scrim()).toBeNull()
    expect(inert(chrome('sidebar'))).toBe(false)
    expect(chromeInertHeld()).toBe(false)
  })

  it('runs the pop in reverse on the kept panel and fades the scrim, the 180 ms of the way in; a 120 ms fade in place under reduced motion; none of it on the phone sheet', () => {
    // The pose rules are the mouse's alone: gated on `:not([data-sheet])`, so a panel the sheet
    // chassis marks `data-leaving` for its way down on a phone gets nothing from them.
    expect(
      cssRule('.zen-frame-dialogs:not([data-sheet]) .zen-frame-dialogs-slot > [data-leaving]')
    ).toContain('animation: zen-pop-out 180ms var(--zen-ease) forwards')
    expect(
      cssRule('.zen-frame-dialogs:not([data-sheet]) .zen-frame-scrim[data-leaving]')
    ).toContain('animation: zen-fade-out 180ms var(--zen-ease) forwards')
    expect(cssRule('@keyframes zen-pop-out')).toMatch(/from \{ opacity: 1; transform: none;/)
    expect(cssRule('.zen-frame-dialogs[data-open], .zen-frame-dialogs[data-leaving]')).toContain(
      'pointer-events: auto'
    )
    // §11.3: the departure stays a fade, the pop's scale dropped – written out in full and
    // `!important`, past the global reduced-motion rule that removes every other animation
    // (reduced motion removes, never shortens: reducedMotion.test.ts).
    const reduced = cssRule(
      '.zen-frame-dialogs:not([data-sheet]) .zen-frame-dialogs-slot > [data-leaving], .zen-frame-dialogs:not([data-sheet]) .zen-frame-scrim[data-leaving]'
    )
    expect(reduced).toContain('animation: zen-fade-out 120ms var(--zen-ease) forwards !important')
    // Every `[data-leaving]` rule on the slot's panels and the scrim is so gated – none reaches
    // a sheet host – and on a phone the chassis slides the slot: the panels' own animation is
    // off there.
    const text = cssText()
    const count = (s: string): number => text.split(s).length - 1
    expect(count('.zen-frame-dialogs-slot > [data-leaving]')).toBeGreaterThan(0)
    expect(count('.zen-frame-dialogs-slot > [data-leaving]')).toBe(
      count('.zen-frame-dialogs:not([data-sheet]) .zen-frame-dialogs-slot > [data-leaving]')
    )
    expect(count('.zen-frame-scrim[data-leaving]')).toBe(
      count('.zen-frame-dialogs:not([data-sheet]) .zen-frame-scrim[data-leaving]')
    )
    expect(cssRule('.zen-frame-dialogs[data-sheet] .zen-frame-dialogs-slot > *')).toContain(
      'animation: none'
    )
  })

  it('goes regardless after 600 ms when no animation reports its end (a background window)', () => {
    vi.useFakeTimers()
    try {
      render(
        <FrameDialogHost>
          <Prompt open />
        </FrameDialogHost>
      )
      rerender(
        <FrameDialogHost>
          <Prompt open={false} />
        </FrameDialogHost>
      )
      expect(leaving()).toHaveLength(1)
      act(() => {
        vi.advanceTimersByTime(599)
      })
      expect(leaving()).toHaveLength(1)
      expect(chromeInertHeld()).toBe(true)
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(leaving()).toHaveLength(0)
      expect(chromeInertHeld()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a dialog opening during the way out ends it at once: no stale panel under the new one, the chrome never let go of', () => {
    render(
      <Chrome>
        <FrameDialogHost>
          <Prompt open name="first" />
        </FrameDialogHost>
      </Chrome>
    )
    const first = slot().querySelector<HTMLElement>('[data-dialog="first"]')!
    rerender(
      <Chrome>
        <FrameDialogHost>
          <Prompt open={false} name="first" />
        </FrameDialogHost>
      </Chrome>
    )
    expect(leaving()).toEqual([first])
    const watched = new MutationObserver(() => {})
    watched.observe(chrome('sidebar'), { attributes: true, attributeFilter: ['inert'] })
    rerender(
      <Chrome>
        <FrameDialogHost>
          <Prompt open name="second" />
        </FrameDialogHost>
      </Chrome>
    )
    expect(first.parentElement).toBeNull()
    expect(leaving()).toEqual([])
    expect(dialogNames()).toEqual(['second'])
    expect(host().getAttribute('data-open')).toBe('true')
    expect(host().hasAttribute('data-leaving')).toBe(false)
    expect(scrim()!.hasAttribute('data-leaving')).toBe(false)
    expect(chromeInertHeld()).toBe(true)
    // One hold throughout: the sidebar's `inert` was never removed and put back.
    expect(watched.takeRecords()).toEqual([])
    watched.disconnect()
  })

  it('a prompt answered as the next mounts in its place shows no ghost: the new panel alone (PageDialogs’ queue)', () => {
    render(
      <FrameDialogHost>
        <Dialog key="a" name="a" />
      </FrameDialogHost>
    )
    rerender(
      <FrameDialogHost>
        <Dialog key="b" name="b" />
      </FrameDialogHost>
    )
    expect(leaving()).toEqual([])
    expect(dialogNames()).toEqual(['b'])
  })

  it('two stacked: the one leaving keeps its place in the stack over or under the one that stays; both at once leave together, the host up for the last', () => {
    render(
      <FrameDialogHost>
        <Prompt open name="edit" />
        <Prompt open name="prompt" />
      </FrameDialogHost>
    )
    const edit = slot().querySelector<HTMLElement>('[data-dialog="edit"]')!
    const prompt = slot().querySelector<HTMLElement>('[data-dialog="prompt"]')!
    // The top one goes: kept above the dialog it left over, whose scrim stays, not fading.
    rerender(
      <FrameDialogHost>
        <Prompt open name="edit" />
        <Prompt open={false} name="prompt" />
      </FrameDialogHost>
    )
    expect(leaving()).toEqual([prompt])
    expect([...slot().children]).toEqual([edit, prompt])
    expect(host().getAttribute('data-open')).toBe('true')
    expect(scrim()!.hasAttribute('data-leaving')).toBe(false)
    endExit()
    expect([...slot().children]).toEqual([edit])
    expect(host().getAttribute('data-open')).toBe('true')
    // The lower one goes while the top stays: kept in its place under it.
    rerender(
      <FrameDialogHost>
        <Prompt open name="edit" />
        <Prompt open name="prompt" />
      </FrameDialogHost>
    )
    const prompt2 = slot().querySelector<HTMLElement>('[data-dialog="prompt"]')!
    rerender(
      <FrameDialogHost>
        <Prompt open={false} name="edit" />
        <Prompt open name="prompt" />
      </FrameDialogHost>
    )
    expect(leaving()).toEqual([edit])
    expect([...slot().children]).toEqual([edit, prompt2])
    endExit()
    expect([...slot().children]).toEqual([prompt2])
    // Both at once: both kept, in order, the scrim fading; one ending first leaves the host up
    // for the other, and the chrome comes back with the last.
    rerender(
      <FrameDialogHost>
        <Prompt open name="edit" />
        <Prompt open name="prompt" />
      </FrameDialogHost>
    )
    const edit3 = slot().querySelector<HTMLElement>('[data-dialog="edit"]')!
    rerender(
      <FrameDialogHost>
        <Prompt open={false} name="edit" />
        <Prompt open={false} name="prompt" />
      </FrameDialogHost>
    )
    expect(leaving()).toEqual([edit3, prompt2])
    expect(scrim()!.getAttribute('data-leaving')).toBe('true')
    act(() => {
      prompt2.dispatchEvent(new Event('animationend'))
    })
    expect([...slot().children]).toEqual([edit3])
    expect(host().getAttribute('data-leaving')).toBe('true')
    expect(chromeInertHeld()).toBe(true)
    endExit()
    expect(slot().childElementCount).toBe(0)
    expect(host().hasAttribute('data-leaving')).toBe(false)
    expect(chromeInertHeld()).toBe(false)
  })

  it('keeps nothing for a sheet that draws its own scrim – its motion is its own way out – nor for a dialog whose panel stays as it goes inactive', () => {
    function Sheet(): JSX.Element {
      useFrameDialog({ onScrimPress: () => {}, ownScrim: true })
      return <div data-dialog="sheet" data-sheet-layer="true" />
    }
    render(
      <FrameDialogHost>
        <Sheet />
      </FrameDialogHost>
    )
    rerender(<FrameDialogHost />)
    expect(leaving()).toEqual([])
    expect(slot().childElementCount).toBe(0)
    expect(host().hasAttribute('data-leaving')).toBe(false)
    expect(chromeInertHeld()).toBe(false)
    // Inactive but still rendered (a form-factor change places the dialog elsewhere): nothing
    // left the slot, so nothing is kept and the host is idle at once.
    rerender(
      <FrameDialogHost>
        <Dialog name="edit" />
      </FrameDialogHost>
    )
    rerender(
      <FrameDialogHost>
        <Dialog name="edit" active={false} />
      </FrameDialogHost>
    )
    expect(leaving()).toEqual([])
    expect(host().hasAttribute('data-leaving')).toBe(false)
    expect(chromeInertHeld()).toBe(false)
    expect(slot().querySelector('[data-dialog="edit"]')!.hasAttribute('inert')).toBe(false)
  })

  it('a dialog placed through FrameDialogPortal leaves the same way', () => {
    render(
      <>
        <FrameDialogHost frame />
        <div data-panel>
          <FrameDialogPortal>
            <Dialog name="edit" />
          </FrameDialogPortal>
        </div>
      </>
    )
    const panel = slot().querySelector<HTMLElement>('[data-dialog="edit"]')!
    rerender(
      <>
        <FrameDialogHost frame />
        <div data-panel />
      </>
    )
    expect(leaving()).toEqual([panel])
    expect(host().getAttribute('data-leaving')).toBe('true')
    endExit()
    expect(slot().childElementCount).toBe(0)
    expect(host().hasAttribute('data-leaving')).toBe(false)
  })

  it('keeps the page under its picture from the dialog’s open to the end of the way out, past the flag that hid it', () => {
    uiStore.set({ snapshot: 'data:,page', snapshotTabId: 't1' })
    render(
      <FrameDialogHost>
        <Prompt open />
      </FrameDialogHost>
    )
    // Nothing covers the page yet (a page dialog captures it and sets its flag once it is up):
    // the host holds nothing – hiding the page now would show a blank frame.
    expect(uiStore.get().frameDialogCover).toBe(0)
    expect(pageHidden(uiStore.get())).toBe(false)
    act(() => uiStore.set({ pageDialogOpen: true }))
    expect(uiStore.get().frameDialogCover).toBe(1)
    // The dialog closes: its flag clears and the capture is asked to go (`closePageDialog`) –
    // the host's hold keeps the view hidden and the capture for the way out.
    rerender(
      <FrameDialogHost>
        <Prompt open={false} />
      </FrameDialogHost>
    )
    act(() => {
      uiStore.set({ pageDialogOpen: false })
      invalidateSnapshot()
    })
    expect(leaving()).toHaveLength(1)
    expect(uiStore.get().frameDialogCover).toBe(1)
    expect(pageHidden(uiStore.get())).toBe(true)
    expect(uiStore.get().snapshot).toBe('data:,page')
    endExit()
    expect(uiStore.get().frameDialogCover).toBe(0)
    expect(pageHidden(uiStore.get())).toBe(false)
    expect(uiStore.get().snapshot).toBeNull()
  })

  it('covers the way out of a dialog whose state is the flag itself, cleared before its panel has left (the bookmark dialogs, the star card)', () => {
    function StoreDialog(): JSX.Element | null {
      const open = uiStore.use((s) => s.pageDialogOpen)
      return open ? <Dialog name="store" /> : null
    }
    uiStore.set({ snapshot: 'data:,page', snapshotTabId: 't1', pageDialogOpen: true })
    render(
      <FrameDialogHost>
        <StoreDialog />
      </FrameDialogHost>
    )
    expect(uiStore.get().frameDialogCover).toBe(1)
    act(() => {
      uiStore.set({ pageDialogOpen: false })
      invalidateSnapshot()
    })
    expect(leaving().map((el) => el.dataset.dialog)).toEqual(['store'])
    expect(uiStore.get().snapshot).toBe('data:,page')
    expect(pageHidden(uiStore.get())).toBe(true)
    endExit()
    expect(uiStore.get().snapshot).toBeNull()
    expect(uiStore.get().frameDialogCover).toBe(0)
  })

  it('holds nothing over a page that shows live, and a hold outlasts a dialog only by its way out', () => {
    render(
      <FrameDialogHost>
        <Prompt open />
      </FrameDialogHost>
    )
    rerender(
      <FrameDialogHost>
        <Prompt open={false} />
      </FrameDialogHost>
    )
    expect(uiStore.get().frameDialogCover).toBe(0)
    endExit()
    // A dialog that hid the page and closed with nothing to keep (its panel stays, inactive):
    // the hold goes with it at once.
    rerender(
      <FrameDialogHost>
        <Dialog name="edit" />
      </FrameDialogHost>
    )
    act(() => uiStore.set({ pageDialogOpen: true }))
    expect(uiStore.get().frameDialogCover).toBe(1)
    rerender(
      <FrameDialogHost>
        <Dialog name="edit" active={false} />
      </FrameDialogHost>
    )
    expect(uiStore.get().frameDialogCover).toBe(0)
  })
})

/*
 * On a phone the host is a sheet on the recede chassis (design language v2 draft §11.1, §11.5):
 * one progress value is the scrim's opacity, the slot's slide over its panels' full height
 * across the frame's bottom edge and – through the recede registry – the page's recede; the
 * close reverses it on the same spring; a sheet above recedes the slot and makes it inert. The
 * frame loop is cranked by hand, the layout given sizes: the slot is 800 px tall and a panel
 * stands 300 px above its bottom edge (a bottom-aligned card 300 px tall), so the slide is 300.
 */
describe('FrameDialogHost on a phone (the sheet chassis, §11)', () => {
  let now = 0
  let queue = new Map<number, (now: number) => void>()
  let seq = 0
  const frames = (n: number): void => {
    for (let i = 0; i < n; i++) {
      now += 16
      const pending = [...queue.values()]
      queue.clear()
      for (const cb of pending) cb(now)
    }
  }
  const scheduled = (): boolean => queue.size > 0
  const recedeVar = (): string => document.documentElement.style.getPropertyValue('--zen-recede')
  const opacity = (el: HTMLElement | null): number => Number(el?.style.opacity)
  /** The slot's vertical translation (px) as written this frame. */
  const translateY = (): number => {
    const m = /translate3d\(0, (-?[\d.]+)px, 0\)/.exec(slot().style.transform)
    expect(m, `a translation in ${slot().style.transform}`).not.toBeNull()
    return Number(m![1])
  }
  const SLOT_HEIGHT = 800
  const PANEL_TOP = 500
  const TRAVEL = SLOT_HEIGHT - PANEL_TOP
  let sizes: Array<[string, PropertyDescriptor | undefined]> = []
  /** Let the wait for the page's cover resolve (at once with no page) and the spring start. */
  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    now = 0
    queue = new Map()
    seq = 0
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++seq
      queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => now })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    sizes = ['clientHeight', 'offsetTop'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    ])
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('zen-frame-dialogs-slot') ? SLOT_HEIGHT : 0
      }
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-dialog') ? Number(this.dataset.top ?? PANEL_TOP) : 0
      }
    })
  })

  afterEach(() => {
    act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' }))
    vi.unstubAllGlobals()
    for (const [name, descriptor] of sizes) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    }
  })

  it('marks the host a sheet and keeps a scrim at nothing while no dialog is open', () => {
    render(<FrameDialogHost />)
    expect(host().getAttribute('data-sheet')).toBe('true')
    expect(host().hasAttribute('data-open')).toBe(false)
    expect(host().hasAttribute('data-sheet-up')).toBe(false)
    expect(scrim()).not.toBeNull()
    expect(scrim()!.style.opacity).toBe('0')
    expect(scrim()!.classList.contains('zen-animate-in')).toBe(false)
    expect(document.documentElement.dataset.receding).toBeUndefined()
  })

  it('a dialog opening runs one progress into the scrim, the slot and the page recede; closing reverses it on the same spring', async () => {
    render(
      <FrameDialogHost>
        <Dialog name="edit" />
      </FrameDialogHost>
    )
    // Open, on the stack at 0, painted at nothing before the first frame: no pop of the panel,
    // which stands its whole height below the frame's bottom edge.
    expect(host().getAttribute('data-open')).toBe('true')
    expect(document.documentElement.dataset.receding).toBe('true')
    expect(recedeVar()).toBe('0.0000')
    expect(opacity(scrim())).toBe(0)
    expect(slot().style.opacity).toBe('0')
    expect(translateY()).toBe(TRAVEL)
    expect(host().hasAttribute('data-sheet-up')).toBe(false)

    await settle()
    // The sheet holds the page under its cover from before the slide (§11.5): the host is asked
    // to hide the page views by the sheet itself, not by the dialog it hosts.
    expect(uiStore.get().frameSheetOpen).toBe(true)
    expect(scheduled()).toBe(true)
    let last = 0
    for (let i = 0; i < 60 && scheduled(); i++) {
      frames(1)
      const p = opacity(scrim())
      expect(Number(recedeVar())).toBeCloseTo(p, 4)
      // The slide is `p` over the panel's full travel (§11.1), the slot shown throughout; the
      // spring's hair of overshoot past 1 shows in the slide while the opacities stop at 1.
      if (p < 1) expect(translateY()).toBeCloseTo((1 - p) * TRAVEL, 1)
      else expect(translateY()).toBeLessThanOrEqual(0)
      expect(slot().style.opacity).toBe('1')
      expect(p).toBeGreaterThanOrEqual(last - 1e-9)
      last = p
    }
    expect(recedeVar()).toBe('1.0000')
    expect(slot().style.transform).toContain(
      'translate3d(0, 0.00px, 0) scale(var(--zen-layer-scale, 1))'
    )
    expect(host().hasAttribute('data-sheet-up')).toBe(true)

    // The dialog goes: the scrim stays for the way down and everything runs back to 0 together;
    // the page stays under its cover until the spring has landed, then comes back where it was.
    rerender(<FrameDialogHost />)
    expect(host().hasAttribute('data-open')).toBe(false)
    expect(scrim()).not.toBeNull()
    expect(document.documentElement.dataset.receding).toBe('true')
    expect(uiStore.get().frameSheetOpen).toBe(true)
    last = 1
    for (let i = 0; i < 60 && scheduled(); i++) {
      frames(1)
      const p = opacity(scrim())
      expect(Number(recedeVar())).toBeCloseTo(p, 4)
      expect(p).toBeLessThanOrEqual(last + 1e-9)
      expect(last - p).toBeLessThan(0.25)
      // The same slide back down, `p` over the same travel.
      if (p > 0) expect(translateY()).toBeCloseTo((1 - p) * TRAVEL, 1)
      last = p
      if (p > 0) expect(uiStore.get().frameSheetOpen).toBe(true)
    }
    expect(opacity(scrim())).toBe(0)
    expect(host().hasAttribute('data-sheet-up')).toBe(false)
    expect(document.documentElement.dataset.receding).toBeUndefined()
    expect(recedeVar()).toBe('')
    expect(uiStore.get().frameSheetOpen).toBe(false)
  })

  it('the slide is the panels’ full height across the frame’s bottom edge (22:49 ruling), from the highest panel’s top; a sheet on its own chassis does not count', async () => {
    // Two panels open at once stack in the slot: the taller one (its top 200 px down the 800
    // slot) sets the travel, 600, so at 0 nothing of either stands above the edge. A
    // `BottomSheet` placed `hosted` (`data-sheet-layer`, filling the slot) runs its own track.
    function Tall(): JSX.Element {
      useFrameDialog()
      return <div data-dialog="tall" data-top="200" />
    }
    render(
      <FrameDialogHost>
        <Dialog name="edit" />
        <Tall />
        <div data-sheet-layer="true" data-dialog="own-sheet" data-top="0" />
      </FrameDialogHost>
    )
    expect(translateY()).toBe(SLOT_HEIGHT - 200)
    await settle()
    frames(60)
    expect(translateY()).toBe(0)
    // With the panels gone on the way down the last measure stands: the empty slot keeps its
    // geometry and runs the same slide back, not a jump to a fresh 0.
    rerender(<FrameDialogHost />)
    frames(3)
    const p = opacity(scrim())
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1)
    expect(translateY()).toBeCloseTo((1 - p) * (SLOT_HEIGHT - 200), 1)
  })

  it('promotes the scrim and the slot only while the sheet is about to move or moving (§9.33), and keeps the desktop dialog’s pop off the phone sheet', () => {
    // The gate: `data-open` (a dialog open, the wait for the cover included) or `data-sheet-up`
    // (anything of the sheet showing, the way down included); never the idle host.
    const gate = '.zen-frame-dialogs[data-sheet]:is([data-open], [data-sheet-up])'
    expect(cssRule(`${gate} .zen-frame-scrim`)).toContain('will-change: opacity')
    expect(cssRule(`${gate} .zen-frame-dialogs-slot`)).toContain('will-change: transform, opacity')
    expect(cssRule('.zen-frame-dialogs[data-sheet] .zen-frame-scrim')).not.toContain('will-change')
    expect(cssRule('.zen-frame-dialogs[data-sheet] .zen-frame-dialogs-slot')).not.toContain(
      'will-change'
    )
    // The panels' own §9.5 pop (the desktop dialog's 24 px rise and fade) is off on the sheet:
    // the slide is the whole motion.
    expect(cssRule('.zen-frame-dialogs[data-sheet] .zen-frame-dialogs-slot > *')).toContain(
      'animation: none'
    )
  })

  it('a dialog gone before the sheet came up lets the page back without a slide', async () => {
    render(
      <FrameDialogHost>
        <Dialog name="edit" />
      </FrameDialogHost>
    )
    // Closed while the wait for the page's cover is still on (nothing on screen yet).
    rerender(<FrameDialogHost />)
    await settle()
    frames(2)
    expect(opacity(scrim())).toBe(0)
    expect(host().hasAttribute('data-sheet-up')).toBe(false)
    expect(document.documentElement.dataset.receding).toBeUndefined()
    expect(uiStore.get().frameSheetOpen).toBe(false)
  })

  it('a dialog opening again on the way down catches the spring where it is: no jump', async () => {
    render(
      <FrameDialogHost>
        <Dialog name="edit" />
      </FrameDialogHost>
    )
    await settle()
    frames(60)
    rerender(<FrameDialogHost />)
    frames(4)
    const midway = opacity(scrim())
    expect(midway).toBeGreaterThan(0)
    expect(midway).toBeLessThan(1)
    rerender(
      <FrameDialogHost>
        <Dialog name="edit" />
      </FrameDialogHost>
    )
    await settle()
    frames(1)
    expect(Math.abs(opacity(scrim()) - midway)).toBeLessThan(0.2)
    // The cover was never let go of on the way down: the page stayed hidden throughout.
    expect(uiStore.get().frameSheetOpen).toBe(true)
    frames(60)
    expect(recedeVar()).toBe('1.0000')
    expect(opacity(scrim())).toBe(1)
    expect(uiStore.get().frameSheetOpen).toBe(true)
  })

  it('under a sheet registered above it the slot recedes about its bottom centre, is inert, and gives up its scrim', async () => {
    render(
      <FrameDialogHost>
        <Dialog name="edit" />
      </FrameDialogHost>
    )
    await settle()
    frames(60)
    const above = registerRecedeLayer()
    try {
      // Registered above but showing nothing yet: the slot stays live (§11.2: inert from q > 0).
      expect(slot().hasAttribute('inert')).toBe(false)
      above.progress(0.5)
      expect(slot().hasAttribute('inert')).toBe(true)
      expect(slot().style.getPropertyValue('--zen-layer-recede')).toBe('0.5000')
      expect(opacity(scrim())).toBeCloseTo(0.5, 4)
      expect(recedeVar()).toBe('1.0000')
      above.progress(1)
      expect(opacity(scrim())).toBe(0)
      expect(cssRule('.zen-frame-dialogs[data-sheet] .zen-frame-dialogs-slot')).toContain(
        'transform-origin: 50% 100%'
      )
    } finally {
      above.release()
    }
    expect(slot().hasAttribute('inert')).toBe(false)
    expect(opacity(scrim())).toBe(1)
  })

  it('the back gesture over a dismissable dialog peeks the sheet with the finger, springs back on cancel and dismisses on commit (#24)', async () => {
    const onScrimPress = vi.fn()
    render(
      <FrameDialogHost>
        <Dialog name="picker" onScrimPress={onScrimPress} />
      </FrameDialogHost>
    )
    await settle()
    frames(60)
    expect(recedeVar()).toBe('1.0000')
    expect(topBackSurface()?.name).toBe('frame-sheet')

    // The finger: the sheet follows it down its track and the page comes back with it.
    expect(dispatchBackEvent('start', { edge: 'left' })).toBe(true)
    dispatchBackEvent('progress', { progress: 0.5 })
    expect(Number(recedeVar())).toBeCloseTo(sheetBackPosition(1, 0.5), 4)
    expect(opacity(scrim())).toBeCloseTo(sheetBackPosition(1, 0.5), 4)
    dispatchBackEvent('progress', { progress: 1 })
    expect(Number(recedeVar())).toBeCloseTo(1 - BACK_PEEK, 4)
    expect(scheduled()).toBe(false)

    // Let go before the threshold: back up to 1 on the spring, from where the finger left it.
    dispatchBackEvent('cancel')
    expect(scheduled()).toBe(true)
    frames(1)
    expect(Number(recedeVar())).toBeGreaterThan(1 - BACK_PEEK)
    expect(Number(recedeVar())).toBeLessThan(0.85)
    frames(60)
    expect(recedeVar()).toBe('1.0000')
    expect(onScrimPress).not.toHaveBeenCalled()

    // Through: the commit is the scrim press, and the close runs down from the peeked position.
    dispatchBackEvent('start', { edge: 'left' })
    dispatchBackEvent('progress', { progress: 1 })
    expect(dispatchBackEvent('commit')).toBe(true)
    expect(onScrimPress).toHaveBeenCalledTimes(1)
    rerender(<FrameDialogHost />)
    frames(1)
    const first = Number(recedeVar())
    expect(first).toBeLessThan(1 - BACK_PEEK)
    expect(first).toBeGreaterThan(0.4)
    frames(60)
    expect(recedeVar()).toBe('')
    expect(topBackSurface()).toBeNull()
  })

  it('leaves the back gesture to a prompt that gave no scrim handler', async () => {
    render(
      <FrameDialogHost>
        <Dialog name="prompt" />
      </FrameDialogHost>
    )
    await settle()
    frames(60)
    expect(topBackSurface()).toBeNull()
    expect(dispatchBackEvent('start', { edge: 'left' })).toBe(false)
    dispatchBackEvent('cancel')
    expect(recedeVar()).toBe('1.0000')
  })

  it('leaves the desktop host alone: no sheet, the §9.5 scrim animating in', () => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
    render(
      <FrameDialogHost>
        <Dialog name="edit" />
      </FrameDialogHost>
    )
    expect(host().hasAttribute('data-sheet')).toBe(false)
    expect(scrim()!.classList.contains('zen-animate-in')).toBe(true)
    expect(document.documentElement.dataset.receding).toBeUndefined()
  })

  it('keeps its chassis down for a sheet that brings its own (`ownScrim`): one recede, one scrim, the sheet takes the pointer', async () => {
    function OwnSheet(): JSX.Element {
      useFrameDialog({ onScrimPress: () => {}, ownScrim: true })
      return <div data-sheet-layer="true" data-dialog="own" />
    }
    render(
      <FrameDialogHost>
        <OwnSheet />
      </FrameDialogHost>
    )
    await settle()
    frames(60)
    // Nothing of the host's chassis ran: the sheet inside is the chassis (it registers its own
    // recede layer and draws the stack's scrim), so the page recedes once, not twice.
    expect(host().getAttribute('data-open')).toBe('true')
    expect(document.documentElement.dataset.receding).toBeUndefined()
    expect(scrim()!.style.opacity).toBe('0')
    expect(slot().style.opacity).toBe('')
    expect(slot().style.transform).toBe('')
    expect(host().hasAttribute('data-sheet-up')).toBe(false)
    // The pointer cut for a chassis at 0 leaves the sheet's own layer alone.
    expect(
      cssRule(
        '.zen-frame-dialogs[data-sheet]:not([data-sheet-up]) .zen-frame-dialogs-slot > :not([data-sheet-layer])'
      )
    ).toContain('pointer-events: none')
  })

  it('shows the slot as rendered again once its chassis has come down, for a sheet with its own that opens next', async () => {
    render(
      <FrameDialogHost>
        <Dialog name="edit" />
      </FrameDialogHost>
    )
    await settle()
    frames(60)
    expect(slot().style.opacity).toBe('1')
    rerender(<FrameDialogHost />)
    frames(90)
    expect(scheduled()).toBe(false)
    expect(slot().style.opacity).toBe('')
    expect(slot().style.transform).toBe('')
    expect(scrim()!.style.opacity).toBe('0')
  })

  /*
   * The way out is not the host's here: on a phone the dialogs are sheets and their leave is
   * the sheet chassis' (v2 draft §11.1; the Android program's sheet-leave work, #187, on this
   * same slot). `data-sheet` is the gate – the host keeps, holds and marks nothing – so the
   * slot's children are what React renders, and whatever the chassis does with the slot's
   * children is its own.
   */
  it('keeps, holds and marks nothing for a dialog that unmounted its panel as it closed: the host retains nothing on a phone', async () => {
    uiStore.set({ snapshot: 'data:,page', snapshotTabId: 't1' })
    render(
      <Chrome>
        <FrameDialogHost>
          <Prompt open />
        </FrameDialogHost>
      </Chrome>
    )
    await settle()
    frames(60)
    expect(recedeVar()).toBe('1.0000')
    // The page is the sheet's to cover (`frameSheetOpen`), not the host's (`frameDialogCover`).
    act(() => uiStore.set({ pageDialogOpen: true }))
    expect(uiStore.get().frameDialogCover).toBe(0)
    expect(uiStore.get().frameSheetOpen).toBe(true)
    const panel = slot().querySelector<HTMLElement>('[data-dialog="prompt"]')!
    rerender(
      <Chrome>
        <FrameDialogHost>
          <Prompt open={false} />
        </FrameDialogHost>
      </Chrome>
    )
    act(() => {
      uiStore.set({ pageDialogOpen: false })
      invalidateSnapshot()
    })
    // In the commit that removed it the host put nothing back and marked nothing – the panel
    // is out of the slot as React left it, unmarked – and the host's own state follows its
    // registered dialogs alone: no `data-leaving` on the host or its scrim, `data-open` off,
    // no cover hold. (Whatever the sheet chassis then does with the slot's children for its
    // way down – a kept panel of its own, its hold on the chrome to the landing – is the
    // chassis', #187, and none of the host's.)
    expect(panel.isConnected).toBe(false)
    expect(panel.hasAttribute('data-leaving')).toBe(false)
    expect(panel.hasAttribute('inert')).toBe(false)
    expect(panel.hasAttribute('aria-hidden')).toBe(false)
    expect(leaving()).toEqual([])
    expect(host().hasAttribute('data-open')).toBe(false)
    expect(host().hasAttribute('data-leaving')).toBe(false)
    expect(scrim()!.hasAttribute('data-leaving')).toBe(false)
    expect(uiStore.get().frameDialogCover).toBe(0)
    // The sheet's own way down runs: scrim and recede back on the spring, the page under the
    // sheet's cover until the landing – nothing of it the host's retention.
    expect(uiStore.get().frameSheetOpen).toBe(true)
    let last = 1
    for (let i = 0; i < 120 && scheduled(); i++) {
      act(() => frames(1))
      const p = opacity(scrim())
      expect(Number(recedeVar())).toBeCloseTo(p, 4)
      expect(p).toBeLessThanOrEqual(last + 1e-9)
      last = p
      expect(host().hasAttribute('data-leaving')).toBe(false)
      expect(scrim()!.hasAttribute('data-leaving')).toBe(false)
      expect(uiStore.get().frameDialogCover).toBe(0)
    }
    expect(scheduled()).toBe(false)
    expect(host().hasAttribute('data-sheet-up')).toBe(false)
    expect(uiStore.get().frameSheetOpen).toBe(false)
    expect(uiStore.get().frameDialogCover).toBe(0)
    expect(recedeVar()).toBe('')
  })

  it('a dialog opening again on the way down finds nothing kept: the new panel alone, as rendered', async () => {
    render(
      <FrameDialogHost>
        <Prompt open name="first" />
      </FrameDialogHost>
    )
    await settle()
    frames(60)
    const first = slot().querySelector<HTMLElement>('[data-dialog="first"]')!
    rerender(
      <FrameDialogHost>
        <Prompt open={false} name="first" />
      </FrameDialogHost>
    )
    expect(first.isConnected).toBe(false)
    act(() => frames(4))
    const midway = opacity(scrim())
    expect(midway).toBeGreaterThan(0)
    expect(midway).toBeLessThan(1)
    rerender(
      <FrameDialogHost>
        <Prompt open name="second" />
      </FrameDialogHost>
    )
    expect(dialogNames()).toEqual(['second'])
    expect(leaving()).toEqual([])
    expect(host().getAttribute('data-open')).toBe('true')
    expect(host().hasAttribute('data-leaving')).toBe(false)
    // The chassis turns the spring round where it is, as on main.
    await settle()
    act(() => frames(1))
    expect(Math.abs(opacity(scrim()) - midway)).toBeLessThan(0.2)
    act(() => frames(60))
    expect(recedeVar()).toBe('1.0000')
    expect(slot().querySelector('[data-dialog="second"]')!.hasAttribute('inert')).toBe(false)
  })

  it('the gate follows the pose: a panel kept on a mouse is dropped at once as the host becomes a sheet mid-exit, and a mouse host keeps again', () => {
    act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' }))
    render(
      <FrameDialogHost>
        <Prompt open />
      </FrameDialogHost>
    )
    const panel = slot().querySelector<HTMLElement>('[data-dialog="prompt"]')!
    rerender(
      <FrameDialogHost>
        <Prompt open={false} />
      </FrameDialogHost>
    )
    expect(panel.parentElement).toBe(slot())
    expect(host().getAttribute('data-leaving')).toBe('true')
    expect(chromeInertHeld()).toBe(true)
    // The form factor changes under the way out: the sheet chassis owns the leave from here,
    // and what the mouse pose kept goes with it – nothing stale for the chassis to find.
    act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' }))
    expect(panel.isConnected).toBe(false)
    expect(slot().childElementCount).toBe(0)
    expect(host().getAttribute('data-sheet')).toBe('true')
    expect(host().hasAttribute('data-leaving')).toBe(false)
    expect(chromeInertHeld()).toBe(false)
    // A sheet host keeps nothing; back on a mouse the host keeps again.
    rerender(
      <FrameDialogHost>
        <Prompt open name="on-phone" />
      </FrameDialogHost>
    )
    const onPhone = slot().querySelector<HTMLElement>('[data-dialog="on-phone"]')!
    rerender(
      <FrameDialogHost>
        <Prompt open={false} name="on-phone" />
      </FrameDialogHost>
    )
    expect(onPhone.isConnected).toBe(false)
    expect(leaving()).toEqual([])
    act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' }))
    rerender(
      <FrameDialogHost>
        <Prompt open name="on-mouse" />
      </FrameDialogHost>
    )
    const onMouse = slot().querySelector<HTMLElement>('[data-dialog="on-mouse"]')!
    rerender(
      <FrameDialogHost>
        <Prompt open={false} name="on-mouse" />
      </FrameDialogHost>
    )
    expect(onMouse.parentElement).toBe(slot())
    expect(onMouse.hasAttribute('data-leaving')).toBe(true)
    endExit()
    expect(onMouse.isConnected).toBe(false)
    expect(chromeInertHeld()).toBe(false)
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
    // Inert until the prompt's panel has left (its way out, below), and live at once after.
    expect(inert(chrome('sidebar'))).toBe(true)
    endExit()
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
    endExit()
    expect(inert(chrome('sidebar'))).toBe(true)
    rerender(
      <Chrome>
        <FrameDialogHost />
        <FrameDialogHost />
      </Chrome>
    )
    endExit()
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
    endExit()
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

describe('intrinsicSize (§5: a menu is as wide as its longest row)', () => {
  it('reads the used size from the computed style and rounds it up, so a panel pinned to it never runs short of the row it was measured by', () => {
    // The offsets round the longest row's fraction of a pixel away; a menu pinned to 269 for a
    // row of 269.4 put an ellipsis on that row (the app menu's "New Private Window  Ctrl+Shift+N").
    const el = document.createElement('div')
    document.body.appendChild(el)
    el.style.width = '269.4px'
    el.style.height = '660.5px'
    expect(intrinsicSize(el)).toEqual({ width: 270, height: 661 })
    el.remove()
  })

  it('falls back to the offsets where the style carries no used size (no layout)', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    Object.defineProperty(el, 'offsetWidth', { value: 260, configurable: true })
    Object.defineProperty(el, 'offsetHeight', { value: 200, configurable: true })
    expect(intrinsicSize(el)).toEqual({ width: 260, height: 200 })
    el.remove()
  })
})

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
