// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { FrameDialogHost, closeAllPopovers, openPopoverCount } from '@renderer/lib/portals'
import { viewportStore } from '@renderer/lib/formFactor'
import { openSheetCount } from '@renderer/lib/sheetStack'
import {
  DesktopDialog,
  DesktopPopover,
  Footer,
  ListRow,
  Menulist,
  MenulistSheet,
  RowValue,
  V2Sheet,
  type DialogApi
} from '../primitives'

/*
 * The v2 site-controls primitives on the chassis: a DesktopDialog is a positioned child of the
 * FrameDialogHost so it paints over the host's scrim after its pop animation, takes the 400 form
 * width, and hands focus back to its anchor on Escape and through `api.close` (not after a
 * scrim press), a desktop Footer has the two §9.20 forms (a gutter hairline then 12 over a row
 * list; 16 and no hairline under a body or a title block), a
 * DesktopPopover asked to focus its container (a prompt) arms no button and still hands focus
 * back on Escape, a DesktopPopover is dismissed by the chrome layer's registry (an outside
 * press, consumed; a resize – unless it follows its anchor – and a menulist opening inside it is
 * its child), a ListRow's trailing slot is capped at 55% of the row (the value truncates inside
 * it, the label keeps the larger share), and on a phone a stacked footer takes the chassis's
 * `flex: 1` off its buttons, a sheet over a sheet recedes and dims the lower one under the
 * stack's one scrim (§9.24), and a picker without a description opens on the 48 header.
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

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  // The swallow of a consumed press ends a tick after its release.
  await new Promise((resolve) => setTimeout(resolve, 0))
})

/** A press on `target`: down and up, then the click the browser synthesises. */
function press(target: Element): { down: PointerEvent; click: MouseEvent } {
  const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
  const up = new PointerEvent('pointerup', { bubbles: true, cancelable: true })
  const click = new MouseEvent('click', { bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(down)
    target.dispatchEvent(up)
    target.dispatchEvent(click)
  })
  return { down, click }
}

describe('DesktopDialog in the FrameDialogHost', () => {
  it('renders its panel in the host slot after the scrim, in flow and never fixed', () => {
    const el = render(
      <FrameDialogHost>
        <DesktopDialog labelledBy="t" onCancel={() => undefined} data-testid="dlg">
          <h2 id="t">Clear browsing data</h2>
        </DesktopDialog>
      </FrameDialogHost>
    )
    const scrim = el.querySelector('.zen-frame-scrim')
    const panel = el.querySelector<HTMLElement>('[role="dialog"]')
    expect(scrim).not.toBeNull()
    expect(panel).not.toBeNull()
    expect(scrim!.compareDocumentPosition(panel!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The slot's stacking context lifts the panel over the scrim; the panel positions nothing.
    expect(panel!.closest('.zen-frame-dialogs-slot')).not.toBeNull()
    expect(panel!.classList.contains('fixed')).toBe(false)
    expect(panel!.getAttribute('aria-modal')).toBe('true')
    expect(panel!.getAttribute('data-testid')).toBe('dlg')
    // A dialog takes the popover's form width unless it asks for the table's (§9.20).
    expect(panel!.style.width).toBe('400px')
  })

  it('a desktop footer is the panel form over a row list, the prompt form under a title block', () => {
    const el = render(
      <>
        <Footer count={2}>
          <button type="button">Clear site data</button>
          <button type="button">Reload</button>
        </Footer>
        <Footer count={2} hairline={false}>
          <button type="button">Cancel</button>
          <button type="button">Clear data</button>
        </Footer>
      </>
    )
    const [panel, prompt] = Array.from(el.querySelectorAll<HTMLElement>('[data-footer]'))
    // The panel form: a hairline in the gutter, then the buttons at 12 above and below, 16 aside.
    const hairline = panel!.firstElementChild as HTMLElement
    expect(hairline.getAttribute('aria-hidden')).toBe('true')
    expect(hairline.classList.contains('mx-4')).toBe(true)
    expect(hairline.classList.contains('h-px')).toBe(true)
    const panelRow = panel!.lastElementChild as HTMLElement
    expect(panelRow.classList.contains('py-3')).toBe(true)
    expect(panelRow.classList.contains('px-4')).toBe(true)
    // The prompt and dialog form: no hairline, the buttons 16 under the body and 16 to the edge.
    expect(prompt!.children.length).toBe(1)
    const promptRow = prompt!.firstElementChild as HTMLElement
    expect(promptRow.classList.contains('pt-4')).toBe(true)
    expect(promptRow.classList.contains('pb-4')).toBe(true)
    expect(promptRow.className).not.toMatch(/border/)
  })

  function withAnchor(): HTMLButtonElement {
    const anchor = document.createElement('button')
    anchor.textContent = 'Clear browsing data…'
    document.body.appendChild(anchor)
    anchor.focus()
    expect(document.activeElement).toBe(anchor)
    return anchor
  }

  it('moves focus in, and Escape hands it back to the anchor before cancelling', () => {
    const anchor = withAnchor()
    const onCancel = vi.fn()
    render(
      <FrameDialogHost>
        <DesktopDialog labelledBy="t" onCancel={onCancel}>
          <h2 id="t">Clear browsing data</h2>
          <button type="button">Cancel</button>
        </DesktopDialog>
      </FrameDialogHost>
    )
    expect(document.activeElement?.textContent).toBe('Cancel')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(anchor)
    anchor.remove()
  })

  it('a footer button closing through the api returns focus too; a scrim press leaves it', () => {
    const anchor = withAnchor()
    const onCancel = vi.fn()
    const api = { current: null as DialogApi | null }
    const el = render(
      <FrameDialogHost>
        <DesktopDialog labelledBy="t" onCancel={onCancel} api={api}>
          <h2 id="t">Clear browsing data</h2>
          <button type="button" onClick={() => api.current?.close()}>
            Cancel
          </button>
        </DesktopDialog>
      </FrameDialogHost>
    )
    const cancel = el.querySelector<HTMLButtonElement>('[role="dialog"] button')!
    cancel.focus()
    act(() => cancel.click())
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(anchor)

    // Opened again: an outside press on the scrim cancels without touching focus (§9.22).
    act(() => root!.unmount())
    anchor.focus()
    const again = vi.fn()
    const el2 = render(
      <FrameDialogHost>
        <DesktopDialog labelledBy="t" onCancel={again}>
          <h2 id="t">Clear browsing data</h2>
          <button type="button">Cancel</button>
        </DesktopDialog>
      </FrameDialogHost>
    )
    const scrim = el2.querySelector<HTMLElement>('.zen-frame-scrim')!
    act(() => {
      scrim.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
      scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      scrim.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(again).toHaveBeenCalledTimes(1)
    expect(document.activeElement).not.toBe(anchor)
    anchor.remove()
  })
})

describe('on a phone', () => {
  const desktop = viewportStore.get()
  const phone = (): void => viewportStore.set({ ...desktop, formFactor: 'phone' })
  afterEach(() => viewportStore.set(desktop))

  it('a stacked footer keeps every button at its own height', () => {
    phone()
    const el = render(
      <Footer count={3}>
        <button type="button">Allow</button>
        <button type="button">Allow once</button>
        <button type="button">Block</button>
      </Footer>
    )
    const footer = el.querySelector<HTMLElement>('.zen-sheet-footer')!
    expect(footer.classList.contains('flex-col')).toBe(true)
    // The chassis's `> * { flex: 1 }` shares a row's width between peers; in a column it would
    // share the height, so the stack takes it off (§9.11: each button 40).
    expect(footer.classList.contains('[&>*]:flex-none')).toBe(true)
    const pair = render(
      <Footer count={2}>
        <button type="button">Cancel</button>
        <button type="button">Clear data</button>
      </Footer>
    ).querySelector<HTMLElement>('.zen-sheet-footer')!
    expect(pair.classList.contains('flex-col')).toBe(false)
    expect(pair.classList.contains('[&>*]:flex-none')).toBe(false)
  })

  it('a sheet over a sheet: one scrim, the lower receded and inert, whole again when the upper leaves', () => {
    phone()
    function Stack({ upper }: { upper: boolean }): ReactElement {
      return (
        <>
          <V2Sheet
            name="lower"
            title="Clear browsing data"
            handleLabel="Resize lower"
            onDismissed={() => undefined}
            data-testid="lower"
          >
            <div>rows</div>
          </V2Sheet>
          {upper && (
            <V2Sheet
              name="upper"
              title="Time range"
              handleLabel="Resize upper"
              onDismissed={() => undefined}
              data-testid="upper"
            >
              <div>options</div>
            </V2Sheet>
          )}
        </>
      )
    }
    render(<Stack upper={false} />)
    expect(openSheetCount()).toBe(1)
    const layers = (): NodeListOf<HTMLElement> =>
      document.querySelectorAll<HTMLElement>('#zen-chrome-layer .zen-sheet')
    const lower = layers()[0]!
    expect(document.documentElement.dataset.receding).toBe('true')
    expect(lower.hasAttribute('inert')).toBe(false)

    act(() => root!.render(<Stack upper />))
    expect(openSheetCount()).toBe(2)
    const [, upper] = [...layers()]
    expect(upper).toBeDefined()
    // The upper draws the stack's scrim itself: no override thins it.
    const scrims = document.querySelectorAll<HTMLElement>('#zen-chrome-layer .zen-sheet-scrim')
    expect(scrims).toHaveLength(2)
    expect(upper!.closest('.fixed')!.className).not.toContain('bg-transparent')
    // With no layout to measure, the motion reads the sheet as fully present at once: the lower
    // is receded, dimmed out and inert from the upper's first frame, and the page's recede is
    // left where the lower put it.
    expect(lower.style.getPropertyValue('--zen-sheet-recede')).toBe('1.0000')
    expect(lower.hasAttribute('inert')).toBe(true)
    expect(scrims[0]!.style.opacity).toBe('0.0000')
    expect(scrims[1]!.style.opacity).toBe('1.0000')
    expect(document.documentElement.dataset.receding).toBe('true')

    act(() => root!.render(<Stack upper={false} />))
    expect(openSheetCount()).toBe(1)
    expect(lower.hasAttribute('inert')).toBe(false)
    expect(lower.style.getPropertyValue('--zen-sheet-recede')).toBe('')
    expect(
      document.querySelector<HTMLElement>('#zen-chrome-layer .zen-sheet-scrim')!.style.opacity
    ).toBe('1.0000')
    expect(document.documentElement.dataset.receding).toBe('true')

    act(() => root!.unmount())
    expect(openSheetCount()).toBe(0)
    expect(document.documentElement.dataset.receding).toBeUndefined()
  })

  it('a picker without a description opens on the 48 header, with one on a title block', () => {
    phone()
    const options = [
      { value: 'hour', label: 'Last hour' },
      { value: 'all', label: 'All time' }
    ]
    render(
      <MenulistSheet
        name="range"
        title="Time range"
        value="hour"
        options={options}
        onPick={() => undefined}
        onDismissed={() => undefined}
      />
    )
    const header = document.querySelector<HTMLElement>('.zen-sheet-header .zen-sheet-title')
    expect(header?.textContent).toBe('Time range')
    expect(document.querySelector('.zen-sheet-title-block')).toBeNull()
    expect(document.querySelector('[role="radiogroup"]')?.getAttribute('aria-labelledby')).toBe(
      header!.id
    )
    act(() => root!.unmount())

    render(
      <MenulistSheet
        name="camera"
        title="Camera"
        description="What sites may do with the camera"
        value="hour"
        options={options}
        onPick={() => undefined}
        onDismissed={() => undefined}
      />
    )
    expect(document.querySelector('.zen-sheet-header')).toBeNull()
    expect(document.querySelector('.zen-sheet-title-block h2')?.textContent).toBe('Camera')
  })
})

describe('DesktopPopover focus', () => {
  const anchor = { x: 100, y: 40, width: 24, height: 24 }

  it('moves focus to the first button by default', () => {
    const el = render(
      <DesktopPopover anchor={anchor} labelledBy="t" onClosed={() => undefined}>
        {() => (
          <>
            <h2 id="t">Site information</h2>
            <button type="button">Connection</button>
          </>
        )}
      </DesktopPopover>
    )
    expect(el.ownerDocument.activeElement?.textContent).toBe('Connection')
  })

  it('with focus="container" holds the panel itself, and Escape hands focus back to the opener', () => {
    const opener = document.createElement('button')
    opener.textContent = 'site chip'
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const onDismiss = vi.fn()
    render(
      <DesktopPopover
        anchor={anchor}
        labelledBy="t"
        focus="container"
        onDismiss={onDismiss}
        onClosed={() => undefined}
      >
        {() => (
          <>
            <h2 id="t">Allow example.com to use your camera?</h2>
            <button type="button">Allow</button>
          </>
        )}
      </DesktopPopover>
    )
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')
    // No button is armed: a stray Enter grants nothing.
    expect(document.activeElement).toBe(panel)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    // The opener, not the panel the hook saw holding focus, gets it back.
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})

describe('DesktopPopover light dismiss', () => {
  const anchor = { x: 100, y: 40, width: 24, height: 24 }

  function popover(props: { onDismiss: () => void; follow?: boolean }): ReactElement {
    return (
      <DesktopPopover anchor={anchor} labelledBy="t" onClosed={() => undefined} {...props}>
        {() => (
          <>
            <h2 id="t">Site information</h2>
            <button type="button">Connection</button>
          </>
        )}
      </DesktopPopover>
    )
  }

  it('registers with the chrome layer, and an outside press dismisses it and is consumed', () => {
    const onDismiss = vi.fn()
    render(popover({ onDismiss }))
    expect(openPopoverCount()).toBe(1)
    // The popover draws no window-wide backdrop of its own: the registry's listener is the one.
    expect(document.querySelector('#zen-chrome-layer .fixed.inset-0')).toBeNull()

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    const { down, click } = press(outside)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(down.defaultPrevented).toBe(true)
    expect(click.defaultPrevented).toBe(true)

    const inside = document.querySelector<HTMLElement>('[role="dialog"] button')!
    press(inside)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    outside.remove()
  })

  it('a resize closes it, unless it follows its anchor – then the next outside press still does', () => {
    const onDismiss = vi.fn()
    render(popover({ onDismiss }))
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    act(() => root!.unmount())

    const onDismissFollowing = vi.fn()
    render(popover({ onDismiss: onDismissFollowing, follow: true }))
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(onDismissFollowing).not.toHaveBeenCalled()
    // Registered again: the registry still knows it.
    expect(openPopoverCount()).toBe(1)
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    press(outside)
    expect(onDismissFollowing).toHaveBeenCalledTimes(1)
    outside.remove()
  })

  it('a menulist opening inside it is its child: the popover stays up, a press in the list keeps both', () => {
    const onDismiss = vi.fn()
    render(
      <DesktopPopover
        anchor={anchor}
        labelledBy="t"
        onClosed={() => undefined}
        onDismiss={onDismiss}
      >
        {() => (
          <>
            <h2 id="t">Permissions</h2>
            <Menulist
              value="ask"
              options={[
                { value: 'ask', label: 'Ask' },
                { value: 'allow', label: 'Allow' }
              ]}
              onChange={() => undefined}
              label="Camera"
            />
          </>
        )}
      </DesktopPopover>
    )
    const trigger = document.querySelector<HTMLElement>('[aria-haspopup="listbox"]')!
    press(trigger)
    const list = document.querySelector<HTMLElement>('[role="listbox"]')
    expect(list).not.toBeNull()
    expect(openPopoverCount()).toBe(2)
    expect(onDismiss).not.toHaveBeenCalled()

    press(list!.querySelector('[role="option"]')!)
    expect(onDismiss).not.toHaveBeenCalled()
  })
})

describe('ListRow trailing values', () => {
  it('caps the trailing slot at 55% of the row and lets the value truncate inside it', () => {
    const el = render(
      <ListRow label="Connection" trailing={<RowValue>Secure connection</RowValue>} chevron />
    )
    const value = el.querySelector<HTMLElement>('span.truncate')
    expect(value).not.toBeNull()
    expect(value!.textContent).toBe('Secure connection')
    // The percentage cap lives on the slot, whose containing block is the row: on the value
    // itself it would resolve against the shrink-to-fit slot and truncate almost everything.
    expect(value!.classList.contains('max-w-[55%]')).toBe(false)
    expect(value!.classList.contains('min-w-0')).toBe(true)
    const slot = value!.parentElement!
    expect(slot.classList.contains('max-w-[55%]')).toBe(true)
    expect(slot.classList.contains('shrink-0')).toBe(true)
  })

  it('forwards data attributes to its root in both forms', () => {
    const el = render(
      <>
        <ListRow label="A" onClick={() => undefined} data-safety-row="updates" />
        <ListRow label="B" data-safety-row="passwords" />
      </>
    )
    expect(el.querySelector('button[data-safety-row="updates"]')).not.toBeNull()
    expect(el.querySelector('div[data-safety-row="passwords"]')).not.toBeNull()
  })
})
