// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { viewportStore } from '@renderer/lib/formFactor'
import { HOVER_CARD_DELAY, HOVER_CARD_LEAVE_GRACE } from '@renderer/lib/hoverCard'
import { FrameDialogHost, POPOVER_WIDTH } from '@renderer/lib/portals'
import { LONG_PRESS_MS, RELEASE_DELAY_MS } from '../../../phone/useLongPress'
import { AddressReveal, ADDRESS_CARD_ID, type AddressHoldRequest } from '../AddressReveal'
import { RadioOption } from '../blocks'
import type { ActionRow, InfoRow, SwitchRow } from '../model'
import { RowView } from '../rows'
import { SheetStack } from '../sheets'

/*
 * §9.2's reveal of a shortened path or address (services seed #32; the lead's ruling on #685
 * item 4): a row whose address line is actually elided – its content wider than its box, read
 * at the hover, the focus or the hold, never watched – gets §9.31's hover card on a mouse after
 * Chrome's ~800 ms and at once under keyboard focus: a `role="tooltip"` on the tab card's
 * chrome at §9.20's 320, carrying the whole value; a value that fits shows nothing; nothing
 * carries a native `title`; a touch resting shows no card, and a hold on the row is the reveal
 * on touch – the row's hold sheet where the page draws sheets (a phone), whose title block reads
 * the label and the whole value, the same card standing under the row where it draws dialogs
 * (a tablet; the lead's look on #694). #685's pins stand: the row's own line is untouched by
 * the reveal.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// The core's bridge, for the copy a row with a `copy` runs on its own hold (SET-54).
Object.assign(window, { zen: { invoke: async () => null, on: () => () => undefined } })

let root: Root | null = null
let mount: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root?.render(element))
  return mount
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const PATH = '/home/user/Nextcloud/Documents/Work/Projects/2026/Zenium/Backups/Settings'
const ctx = { open: vi.fn() }

/** The page layout around its rows, with the host as the layouts mount it. */
function Page({
  children,
  hold
}: {
  children: ReactElement | ReactElement[]
  hold?: (request: AddressHoldRequest) => void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} className="zen-settings-phone">
      {children}
      <AddressReveal root={ref} hold={hold} />
    </div>
  )
}

function folder(patch: Partial<InfoRow> = {}): InfoRow {
  return {
    kind: 'info',
    id: 'sync-server-folder',
    label: 'Folder',
    description: PATH,
    address: true,
    ...patch
  }
}

function location(patch: Partial<ActionRow> = {}): ActionRow {
  return {
    kind: 'action',
    id: 'download-directory',
    label: 'Location',
    description: PATH,
    address: true,
    onPress: () => undefined,
    ...patch
  }
}

/** A desktop boolean whose description is a path (a skill's row): the box is the control, the words the row. */
function skill(patch: Partial<SwitchRow> = {}): SwitchRow {
  return {
    kind: 'switch',
    id: 'skill-ask',
    label: 'Ask before running',
    description: PATH,
    address: true,
    checked: true,
    onChange: () => undefined,
    ...patch
  }
}

function rowOf(el: HTMLElement, id: string): HTMLElement {
  const row = el.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

function lineOf(row: HTMLElement): HTMLElement {
  const line = row.querySelector<HTMLElement>('.zen-settings-description-address')
  if (!line) throw new Error('no address line')
  return line
}

/** The line's measure as the browser would give it: `content` wide in a `box` wide span. */
function measure(line: HTMLElement, content: number, box: number): void {
  Object.defineProperty(line, 'scrollWidth', { configurable: true, get: () => content })
  Object.defineProperty(line, 'clientWidth', { configurable: true, get: () => box })
}

const card = (): HTMLElement | null => document.getElementById(ADDRESS_CARD_ID)

function pointer(
  el: Element,
  type: string,
  init: PointerEventInit & { relatedTarget?: EventTarget | null } = {}
): boolean {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: 'mouse',
    pointerId: 1,
    isPrimary: true,
    button: 0,
    ...init
  })
  act(() => {
    el.dispatchEvent(event)
  })
  return event.defaultPrevented
}

/** The wait for the card: the delay, then the resolved `prepare` and React's commit. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
  })
}

/**
 * A finger (or `pointerType`'s pointer) on `target`: the down, the hold, the lift and the click
 * the lift raises, then the turn a card would show in; whether the click was swallowed.
 */
async function hold(
  target: Element,
  ms = LONG_PRESS_MS,
  init: PointerEventInit = { pointerType: 'touch' }
): Promise<boolean> {
  pointer(target, 'pointerdown', init)
  await wait(ms)
  pointer(target, 'pointerup', init)
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  act(() => {
    target.dispatchEvent(click)
  })
  await wait(0)
  return click.defaultPrevented
}

describe('the hover card on a mouse', () => {
  it('shows after the delay for a line that is elided, carries the whole value on a role="tooltip", and no title anywhere', async () => {
    const el = render(
      <Page>
        <RowView row={folder()} ctx={ctx} />
      </Page>
    )
    const row = rowOf(el, 'sync-server-folder')
    measure(lineOf(row), 640, 280)
    pointer(lineOf(row), 'pointerover')
    expect(card()).toBeNull()
    await wait(HOVER_CARD_DELAY - 1)
    expect(card()).toBeNull()
    await wait(1)
    const shown = card()
    expect(shown).not.toBeNull()
    expect(shown?.getAttribute('role')).toBe('tooltip')
    expect(shown?.textContent).toBe(PATH)
    // The tab card's chrome (§9.20's panel) at the list width, a page surface in the chrome layer.
    expect(shown?.classList.contains('zen-tab-hover-card')).toBe(true)
    expect(shown?.classList.contains('zen-address-hover-card')).toBe(true)
    expect(shown?.style.width).toBe(`${POPOVER_WIDTH.list}px`)
    expect(shown?.getAttribute('data-surface')).toBe('page')
    expect(shown?.closest('#zen-chrome-layer')).not.toBeNull()
    expect(document.querySelector('[title]')).toBeNull()
    // The row's own line is what #685 made it: the whole value in its isolate, the modifier on.
    expect(lineOf(row).textContent).toBe(PATH)
    expect(lineOf(row).querySelector('bdi[dir="ltr"]')?.textContent).toBe(PATH)
  })

  it('shows nothing for a value that fits, and nothing for a prose description', async () => {
    const el = render(
      <Page>
        <RowView row={folder({ description: 'Backups/Zenium' })} ctx={ctx} />
        <RowView
          row={location({ description: 'The system Downloads folder', address: false })}
          ctx={ctx}
        />
      </Page>
    )
    const fits = rowOf(el, 'sync-server-folder')
    measure(lineOf(fits), 120, 280)
    pointer(lineOf(fits), 'pointerover')
    await wait(HOVER_CARD_DELAY + 50)
    expect(card()).toBeNull()
    const prose = rowOf(el, 'download-directory')
    pointer(prose, 'pointerover')
    await wait(HOVER_CARD_DELAY + 50)
    expect(card()).toBeNull()
  })

  it('leaves with the pointer after the grace, and never shows for a touch or pen pointer', async () => {
    const el = render(
      <Page>
        <RowView row={folder()} ctx={ctx} />
      </Page>
    )
    const row = rowOf(el, 'sync-server-folder')
    measure(lineOf(row), 640, 280)
    pointer(lineOf(row), 'pointerover')
    await wait(HOVER_CARD_DELAY)
    expect(card()).not.toBeNull()
    pointer(lineOf(row), 'pointerout', { relatedTarget: document.body })
    await wait(HOVER_CARD_LEAVE_GRACE)
    expect(card()).toBeNull()
    pointer(lineOf(row), 'pointerover', { pointerType: 'touch' })
    await wait(HOVER_CARD_DELAY + 50)
    expect(card()).toBeNull()
    pointer(lineOf(row), 'pointerover', { pointerType: 'pen' })
    await wait(HOVER_CARD_DELAY + 50)
    expect(card()).toBeNull()
  })

  it('a press takes it down, and so does the row leaving the DOM', async () => {
    const el = render(
      <Page>
        <RowView row={folder()} ctx={ctx} />
      </Page>
    )
    const row = rowOf(el, 'sync-server-folder')
    measure(lineOf(row), 640, 280)
    pointer(lineOf(row), 'pointerover')
    await wait(HOVER_CARD_DELAY)
    expect(card()).not.toBeNull()
    pointer(lineOf(row), 'pointerdown')
    await wait(0)
    expect(card()).toBeNull()
    // Up again on the pointer resting once more, then the row goes.
    pointer(lineOf(row), 'pointerout', { relatedTarget: document.body })
    pointer(lineOf(row), 'pointerover', { relatedTarget: document.body })
    await wait(HOVER_CARD_DELAY)
    expect(card()).not.toBeNull()
    act(() => row.remove())
    await wait(0)
    expect(card()).toBeNull()
  })
})

describe('the card under the keyboard', () => {
  it('keyboard focus on an elided row shows the card at once, and focus leaving takes it down; a fitting row shows none', async () => {
    const el = render(
      <Page>
        <RowView row={location()} ctx={ctx} />
        <RowView row={location({ id: 'short', description: '/tmp' })} ctx={ctx} />
      </Page>
    )
    const row = rowOf(el, 'download-directory')
    expect(row.tagName).toBe('BUTTON')
    measure(lineOf(row), 640, 280)
    // A pane shortcut's landing (`KEYBOARD_FOCUS_ATTR`): the keyboard's, whatever `:focus-visible` says here.
    row.setAttribute('data-keyboard-focus', '')
    act(() => {
      row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    await wait(0)
    expect(card()?.textContent).toBe(PATH)
    expect(card()?.getAttribute('data-by')).toBe('focus')
    act(() => {
      row.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await wait(HOVER_CARD_LEAVE_GRACE)
    expect(card()).toBeNull()
    const short = rowOf(el, 'short')
    measure(lineOf(short), 40, 280)
    short.setAttribute('data-keyboard-focus', '')
    act(() => {
      short.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    await wait(0)
    expect(card()).toBeNull()
  })

  it('a picker’s option is a row too: its elided line gets the card', async () => {
    const el = render(
      <Page>
        <div role="radiogroup">
          <RadioOption
            label="Forum"
            description={PATH}
            address
            checked
            onSelect={() => undefined}
          />
        </div>
      </Page>
    )
    const option = el.querySelector<HTMLElement>('[role="radio"]')
    if (!option) throw new Error('no option')
    measure(lineOf(option), 640, 280)
    pointer(option, 'pointerover')
    await wait(HOVER_CARD_DELAY)
    expect(card()?.textContent).toBe(PATH)
  })
})

describe('the hold on touch where the page draws sheets', () => {
  it('a hold on an elided row asks for the row’s hold sheet with the label and the whole value, raises no card, and swallows the click the lift raises', async () => {
    const open = vi.fn<(request: AddressHoldRequest) => void>()
    const el = render(
      <Page hold={open}>
        <RowView row={location()} ctx={ctx} />
      </Page>
    )
    const row = rowOf(el, 'download-directory')
    measure(lineOf(row), 640, 280)
    expect(await hold(lineOf(row))).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({
      kind: 'address',
      rowId: 'download-directory',
      label: 'Location',
      text: PATH
    })
    expect(card()).toBeNull()
    // The next tap is a tap again.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    act(() => {
      row.dispatchEvent(click)
    })
    expect(click.defaultPrevented).toBe(false)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('a hold that is not one asks nothing: a tap, a scroll, a fitting value, a row that copies, or a mouse held where the page draws dialogs', async () => {
    const open = vi.fn<(request: AddressHoldRequest) => void>()
    const el = render(
      <Page hold={open}>
        <RowView row={location()} ctx={ctx} />
        <RowView row={location({ id: 'short', description: '/tmp' })} ctx={ctx} />
        <RowView row={folder({ copy: { text: PATH, confirmation: 'Folder copied' } })} ctx={ctx} />
      </Page>
    )
    const row = rowOf(el, 'download-directory')
    measure(lineOf(row), 640, 280)
    // A tap: lifted before the hold.
    expect(await hold(lineOf(row), LONG_PRESS_MS - 1)).toBe(false)
    expect(open).not.toHaveBeenCalled()
    // A scroll: the finger moved past the slop before the hold.
    pointer(lineOf(row), 'pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 })
    await wait(LONG_PRESS_MS / 2)
    pointer(lineOf(row), 'pointermove', { pointerType: 'touch', clientX: 10, clientY: 40 })
    await wait(LONG_PRESS_MS)
    pointer(lineOf(row), 'pointerup', { pointerType: 'touch', clientX: 10, clientY: 40 })
    await wait(RELEASE_DELAY_MS + 1)
    expect(open).not.toHaveBeenCalled()
    // A value that fits.
    const short = rowOf(el, 'short')
    measure(lineOf(short), 40, 280)
    expect(await hold(lineOf(short))).toBe(false)
    expect(open).not.toHaveBeenCalled()
    // A row that copies on the hold keeps its copy (SET-54).
    const copies = rowOf(el, 'sync-server-folder')
    expect(copies.hasAttribute('data-copies')).toBe(true)
    measure(lineOf(copies), 640, 280)
    await hold(lineOf(copies))
    await wait(RELEASE_DELAY_MS + 1)
    expect(open).not.toHaveBeenCalled()
    // A page that draws dialogs mounts the host without `hold`: a mouse held there is no hold
    // (a mouse's reveal is the hover) – the finger's hold there is the standing card, below.
    act(() => root?.unmount())
    mount?.remove()
    const desktop = render(
      <Page>
        <RowView row={location()} ctx={ctx} variant="desktop" />
      </Page>
    )
    const desktopRow = rowOf(desktop, 'download-directory')
    measure(lineOf(desktopRow), 640, 280)
    expect(await hold(lineOf(desktopRow), LONG_PRESS_MS, { pointerType: 'mouse' })).toBe(false)
    await wait(RELEASE_DELAY_MS + 1)
    expect(open).not.toHaveBeenCalled()
    expect(card()).toBeNull()
  })

  it('Chromium’s own long press (`contextmenu` from the touch) is the hold’s cue: the sheet is asked for at once and the menu suppressed', async () => {
    const open = vi.fn<(request: AddressHoldRequest) => void>()
    const el = render(
      <Page hold={open}>
        <RowView row={location()} ctx={ctx} />
      </Page>
    )
    const row = rowOf(el, 'download-directory')
    measure(lineOf(row), 640, 280)
    pointer(lineOf(row), 'pointerdown', { pointerType: 'touch' })
    await wait(LONG_PRESS_MS + 20)
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => {
      lineOf(row).dispatchEvent(menu)
    })
    expect(menu.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]?.[0]?.text).toBe(PATH)
  })

  it('a hold on a control inside the row is the control’s – no sheet, and the lift’s click reaches it – while the row’s own line still asks; a picker’s option, itself the control, keeps its hold', async () => {
    const open = vi.fn<(request: AddressHoldRequest) => void>()
    const press = vi.fn()
    // The two panes inside the phone shell (a phone in landscape) draw the desktop's rows – a
    // control row with its trailing button, a check row on its box – and the phone's sheets.
    const el = render(
      <Page hold={open}>
        <RowView
          row={location({ button: 'Change…', onPress: press })}
          ctx={ctx}
          variant="desktop"
        />
        <RowView row={skill()} ctx={ctx} variant="desktop" />
        <div role="radiogroup">
          <RadioOption
            label="Forum"
            description={PATH}
            address
            checked
            onSelect={() => undefined}
          />
        </div>
      </Page>
    )
    const control = rowOf(el, 'download-directory')
    expect(control.hasAttribute('data-static')).toBe(true)
    const button = control.querySelector<HTMLElement>('button')
    if (!button) throw new Error('no button')
    expect(button.textContent).toBe('Change…')
    measure(lineOf(control), 640, 280)
    // The finger rests on the button: no hold arms, and the click its lift raises is the button's.
    expect(await hold(button)).toBe(false)
    await wait(RELEASE_DELAY_MS + 1)
    expect(open).not.toHaveBeenCalled()
    expect(press).toHaveBeenCalledTimes(1)
    // On the row's own line the hold is the row's.
    expect(await hold(lineOf(control))).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenLastCalledWith({
      kind: 'address',
      rowId: 'download-directory',
      label: 'Location',
      text: PATH
    })
    expect(press).toHaveBeenCalledTimes(1)
    // A desktop switch: its box is the control, its words are the row.
    const check = rowOf(el, 'skill-ask')
    expect(check.tagName).toBe('LABEL')
    const box = check.querySelector<HTMLElement>('input')
    if (!box) throw new Error('no box')
    measure(lineOf(check), 640, 280)
    expect(await hold(box)).toBe(false)
    await wait(RELEASE_DELAY_MS + 1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(await hold(lineOf(check))).toBe(true)
    expect(open).toHaveBeenCalledTimes(2)
    expect(open.mock.calls[1]?.[0]?.rowId).toBe('skill-ask')
    // A picker's option is the button itself: its hold stands.
    const option = el.querySelector<HTMLElement>('[role="radio"]')
    if (!option) throw new Error('no option')
    measure(lineOf(option), 640, 280)
    expect(await hold(option)).toBe(true)
    expect(open).toHaveBeenCalledTimes(3)
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'address', text: PATH }))
  })
})

/*
 * The lead's look on #694, point 4: "§9.2 promises the reveal on touch, and a finger on a
 * tablet is touch. The fix is not a new sheet: the hold raises the same card under the row, and
 * the card stands until a tap outside, a scroll or Escape takes it down." The tablet's two
 * panes draw dialogs, so they mount the host without `hold`.
 */
describe('the standing card under a touch hold where the page draws dialogs (a tablet)', () => {
  const OTHER = 'https://cloud.example.com/remote.php/dav/files/alice/Backups/Personal/Devices'
  /** The Folder row's box in the tablet's second pane, as the desktop still measured it. */
  const FOLDER_BOX = { x: 490, y: 296, width: 696, height: 52 }
  const OTHER_BOX = { x: 490, y: 400, width: 696, height: 52 }

  beforeEach(() => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'tablet' })
  })

  afterEach(() => {
    act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' }))
  })

  /** The row's box as the layout would give it: the geometry the card hangs from. */
  function place(
    row: HTMLElement,
    box: { x: number; y: number; width: number; height: number }
  ): void {
    row.getBoundingClientRect = () =>
      ({
        ...box,
        top: box.y,
        left: box.x,
        right: box.x + box.width,
        bottom: box.y + box.height,
        toJSON: () => box
      }) as DOMRect
  }

  /** The tablet's page: two elided rows, a fitting one and one that copies on its hold. */
  function tablet(): {
    folder: HTMLElement
    other: HTMLElement
    short: HTMLElement
    copies: HTMLElement
  } {
    const el = render(
      <Page>
        <RowView row={folder()} ctx={ctx} variant="desktop" />
        <RowView
          row={location({ id: 'other', label: 'Server', description: OTHER })}
          ctx={ctx}
          variant="desktop"
        />
        <RowView row={location({ id: 'short', description: '/tmp' })} ctx={ctx} variant="desktop" />
        <RowView
          row={folder({ id: 'copies', copy: { text: PATH, confirmation: 'Folder copied' } })}
          ctx={ctx}
          variant="desktop"
        />
      </Page>
    )
    const rows = {
      folder: rowOf(el, 'sync-server-folder'),
      other: rowOf(el, 'other'),
      short: rowOf(el, 'short'),
      copies: rowOf(el, 'copies')
    }
    place(rows.folder, FOLDER_BOX)
    place(rows.other, OTHER_BOX)
    measure(lineOf(rows.folder), 640, 280)
    measure(lineOf(rows.other), 640, 280)
    measure(lineOf(rows.short), 40, 280)
    measure(lineOf(rows.copies), 640, 280)
    return rows
  }

  it('a touch hold on an elided row raises the same card under the row at once – role="tooltip", the whole value, `data-by="hold"` – standing with no leave, and swallows the click the lift raises', async () => {
    const { folder: row } = tablet()
    expect(await hold(lineOf(row))).toBe(true)
    const shown = card()
    expect(shown).not.toBeNull()
    expect(shown?.getAttribute('role')).toBe('tooltip')
    expect(shown?.textContent).toBe(PATH)
    expect(shown?.getAttribute('data-by')).toBe('hold')
    expect(shown?.classList.contains('zen-tab-hover-card')).toBe(true)
    expect(shown?.classList.contains('zen-address-hover-card')).toBe(true)
    expect(shown?.style.width).toBe(`${POPOVER_WIDTH.list}px`)
    // Under the row, flush with its bottom edge and start-aligned with it (`placeAddressCard`).
    expect(shown?.getAttribute('data-side')).toBe('below')
    expect(shown?.style.left).toBe(`${FOLDER_BOX.x}px`)
    expect(shown?.style.top).toBe(`${FOLDER_BOX.y + FOLDER_BOX.height}px`)
    expect(document.querySelector('[title]')).toBeNull()
    // It stands: no delay ran and no leave takes it – the finger leaving the row is no leave.
    pointer(lineOf(row), 'pointerout', { pointerType: 'touch', relatedTarget: document.body })
    await wait(HOVER_CARD_DELAY + HOVER_CARD_LEAVE_GRACE)
    expect(card()?.getAttribute('data-by')).toBe('hold')
    // The row's own line is #685's, untouched.
    expect(lineOf(row).textContent).toBe(PATH)
  })

  it('a tap outside takes it down; a tap on the card itself keeps it', async () => {
    const { folder: row } = tablet()
    await hold(lineOf(row))
    expect(card()).not.toBeNull()
    // A tap outside: the press elsewhere (`bindHoverCardDismissals`' `pointerdown`).
    pointer(document.body, 'pointerdown', { pointerType: 'touch' })
    await wait(0)
    expect(card()).toBeNull()
    pointer(document.body, 'pointerup', { pointerType: 'touch' })
    await wait(RELEASE_DELAY_MS + 1)
    expect(card()).toBeNull()
    // A tap on the card: the card takes the pointer, so the press names it, and it stays.
    await hold(lineOf(row))
    const shown = card()
    expect(shown).not.toBeNull()
    if (!shown) throw new Error('no card')
    expect(await hold(shown, LONG_PRESS_MS - 1)).toBe(false)
    expect(card()).toBe(shown)
    // A hold on the card: Chromium's `contextmenu` is suppressed and the card stays too.
    pointer(shown, 'pointerdown', { pointerType: 'touch' })
    await wait(LONG_PRESS_MS + 20)
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => {
      shown.dispatchEvent(menu)
    })
    expect(menu.defaultPrevented).toBe(true)
    pointer(shown, 'pointerup', { pointerType: 'touch' })
    await wait(RELEASE_DELAY_MS + 1)
    expect(card()).toBe(shown)
  })

  it('a scroll or a wheel takes it down', async () => {
    const { folder: row } = tablet()
    await hold(lineOf(row))
    expect(card()).not.toBeNull()
    // A scroll anywhere (`scroll`, capture, on the document).
    act(() => {
      document.dispatchEvent(new Event('scroll'))
    })
    await wait(0)
    expect(card()).toBeNull()
    await hold(lineOf(row))
    expect(card()).not.toBeNull()
    // A wheel (a tablet with a mouse).
    act(() => {
      row.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }))
    })
    await wait(0)
    expect(card()).toBeNull()
  })

  it('Escape takes it down; the rows’ own keys leave it', async () => {
    const { folder: row } = tablet()
    await hold(lineOf(row))
    expect(card()).not.toBeNull()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    await wait(0)
    expect(card()).not.toBeNull()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await wait(0)
    expect(card()).toBeNull()
  })

  it('a hold on a fitting row shows nothing, a hold on a row that copies keeps its copy and shows nothing, and a mouse held shows nothing', async () => {
    const { short, copies, folder: row } = tablet()
    expect(await hold(lineOf(short))).toBe(false)
    await wait(RELEASE_DELAY_MS + 1)
    expect(card()).toBeNull()
    expect(copies.hasAttribute('data-copies')).toBe(true)
    await hold(lineOf(copies))
    await wait(RELEASE_DELAY_MS + 1)
    expect(card()).toBeNull()
    expect(await hold(lineOf(row), LONG_PRESS_MS, { pointerType: 'mouse' })).toBe(false)
    await wait(RELEASE_DELAY_MS + 1)
    expect(card()).toBeNull()
  })

  it('Chromium’s own long press (`contextmenu` from the touch) raises the card at once with the menu suppressed, and a second hold on another row moves it', async () => {
    const { folder: row, other } = tablet()
    pointer(lineOf(row), 'pointerdown', { pointerType: 'touch' })
    await wait(LONG_PRESS_MS + 20)
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => {
      lineOf(row).dispatchEvent(menu)
    })
    expect(menu.defaultPrevented).toBe(true)
    await wait(0)
    expect(card()?.textContent).toBe(PATH)
    expect(card()?.getAttribute('data-by')).toBe('hold')
    // The lift under the standing card: its click is swallowed, the card stays.
    pointer(lineOf(row), 'pointerup', { pointerType: 'touch' })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    act(() => {
      lineOf(row).dispatchEvent(click)
    })
    expect(click.defaultPrevented).toBe(true)
    await wait(RELEASE_DELAY_MS + 1)
    expect(card()?.textContent).toBe(PATH)
    // A hold on the next row: the press takes the first card down, the hold raises the next.
    pointer(lineOf(other), 'pointerdown', { pointerType: 'touch' })
    await wait(0)
    expect(card()).toBeNull()
    await wait(LONG_PRESS_MS)
    pointer(lineOf(other), 'pointerup', { pointerType: 'touch' })
    await wait(RELEASE_DELAY_MS + 1)
    expect(card()?.textContent).toBe(OTHER)
    expect(card()?.style.top).toBe(`${OTHER_BOX.y + OTHER_BOX.height}px`)
  })

  it('a hold on a control inside the row is the control’s – no card, and the lift’s click reaches it – while the row’s own line raises the card', async () => {
    const press = vi.fn()
    const el = render(
      <Page>
        <RowView
          row={location({ button: 'Change…', onPress: press })}
          ctx={ctx}
          variant="desktop"
        />
        <RowView row={skill()} ctx={ctx} variant="desktop" />
      </Page>
    )
    const control = rowOf(el, 'download-directory')
    const check = rowOf(el, 'skill-ask')
    place(control, FOLDER_BOX)
    place(check, OTHER_BOX)
    measure(lineOf(control), 640, 280)
    measure(lineOf(check), 640, 280)
    const button = control.querySelector<HTMLElement>('button')
    const box = check.querySelector<HTMLElement>('input')
    if (!button || !box) throw new Error('no control')
    // The finger rests on the button or the box: no hold arms, the click its lift raises is the control's.
    expect(await hold(button)).toBe(false)
    await wait(RELEASE_DELAY_MS + 1)
    expect(card()).toBeNull()
    expect(press).toHaveBeenCalledTimes(1)
    expect(await hold(box)).toBe(false)
    await wait(RELEASE_DELAY_MS + 1)
    expect(card()).toBeNull()
    // On the row's own line the hold is the row's: the card stands under it, and moves with the next.
    expect(await hold(lineOf(control))).toBe(true)
    expect(card()?.textContent).toBe(PATH)
    expect(card()?.getAttribute('data-by')).toBe('hold')
    expect(card()?.style.top).toBe(`${FOLDER_BOX.y + FOLDER_BOX.height}px`)
    expect(press).toHaveBeenCalledTimes(1)
    expect(await hold(lineOf(check))).toBe(true)
    expect(card()?.style.top).toBe(`${OTHER_BOX.y + OTHER_BOX.height}px`)
  })
})

describe('the hold sheet', () => {
  let sizes: Array<[string, PropertyDescriptor | undefined]> = []

  beforeEach(() => {
    vi.useRealTimers()
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    sizes = ['clientHeight', 'offsetHeight'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    ])
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
  })

  afterEach(() => {
    act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' }))
    for (const [name, descriptor] of sizes) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    }
  })

  it('reads the row’s label as its title and the whole value as the title block’s paragraph, on the Settings sheet with the address rule', async () => {
    render(
      <FrameDialogHost>
        <SheetStack
          requests={[{ kind: 'address', rowId: 'sync-server-folder', label: 'Folder', text: PATH }]}
          groups={[]}
          ctx={{ open: () => undefined }}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
    await act(async () => {
      await Promise.resolve()
    })
    const dialog = mount?.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.classList.contains('zen-settings-sheet')).toBe(true)
    expect(dialog?.classList.contains('zen-settings-sheet-address')).toBe(true)
    const block = dialog?.querySelector<HTMLElement>('.zen-sheet-title-block')
    expect(block).not.toBeNull()
    expect(block?.querySelector('h2')?.textContent).toBe('Folder')
    expect(block?.querySelector('p')?.textContent).toBe(PATH)
    // Named by its title, described by the value (§9.22): the sheet itself takes the focus.
    expect(dialog?.getAttribute('aria-labelledby')).toBe(block?.querySelector('h2')?.id)
    expect(dialog?.getAttribute('aria-describedby')).toBe(block?.querySelector('p')?.id)
    expect(dialog?.querySelector('[title]')).toBeNull()
    // Nothing else: no rows, no verbs (the grip's handle is the chassis's own).
    expect(dialog?.querySelector('.zen-settings-row')).toBeNull()
    expect(dialog?.querySelector('.zen-settings-sheet-body')?.textContent).toBe('')
    expect(dialog?.querySelector('.zen-settings-sheet-footer')).toBeNull()
  })
})

describe('main.css', () => {
  function stylesheet(): string {
    return readFileSync(resolve(__dirname, '../../../../assets/main.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
  }

  function declarations(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = css.match(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`))
    if (!m) throw new Error(`no rule for ${selector}`)
    return m[1].trim()
  }

  it('the card’s value wraps anywhere at the body size with no clamp, the held card takes the pointer and no selection, the sheet’s paragraph wraps anywhere, and the tab card’s chrome is untouched', () => {
    const css = stylesheet()
    const value = declarations(css, '.zen-address-hover-card-value')
    expect(value).toContain('overflow-wrap: anywhere')
    expect(value).toContain('font-size: var(--v2-font-body)')
    expect(value).toContain('line-height: var(--v2-line-body)')
    expect(value).not.toContain('line-clamp')
    // The tablet's standing card: live rows lie under it, so a tap on it must land on it, and
    // its text is no hidden copy route.
    const held = declarations(css, ".zen-address-hover-card[data-by='hold']")
    expect(held).toContain('pointer-events: auto')
    expect(held).toContain('user-select: none')
    expect(declarations(css, '.zen-settings-sheet-address .zen-sheet-title-block p')).toContain(
      'overflow-wrap: anywhere'
    )
    const chrome = declarations(css, '.zen-tab-hover-card')
    expect(chrome).toContain('padding: 16px')
    expect(chrome).toContain('border-radius: 8px')
    expect(chrome).toContain('background: var(--v2-panel)')
    expect(chrome).toContain('border: 1px solid var(--v2-border)')
    expect(chrome).toContain('box-shadow: var(--v2-shadow-panel)')
    expect(chrome).toContain('pointer-events: none')
  })
})
