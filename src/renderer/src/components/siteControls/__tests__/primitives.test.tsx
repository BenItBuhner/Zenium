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
import {
  DesktopDialog,
  DesktopPopover,
  Footer,
  ListRow,
  Menulist,
  RowValue,
  TitleBlock,
  V2Sheet,
  type DialogApi
} from '../primitives'

/*
 * The v2 site-controls primitives on the chassis: a DesktopDialog is a positioned child of the
 * FrameDialogHost so it paints over the host's scrim after its pop animation, takes the 400 form
 * width, and hands focus back to its anchor on Escape and through `api.close` (not after a
 * scrim press), a desktop Footer has the two §9.20 forms (a gutter hairline then 12 over a row
 * list; 16 and no hairline under a body or a title block), a DesktopPopover asked to focus its
 * container (a prompt) arms no button and still hands focus back on Escape, one beside a chip
 * takes no focus at all and collapses into the chip on "not now" (§9.22), a DesktopPopover is
 * dismissed by the chrome layer's registry (an outside press, consumed; a resize – unless it
 * follows its anchor – and a menulist opening inside it is its child), a ListRow's trailing slot
 * is capped at 55% of the row (the value truncates inside it, the label keeps the larger share)
 * and a row without a press is `data-static` (§9.34), a busy menulist is read-only at full
 * opacity (§9.30), and on a phone a stacked footer takes the chassis's `flex: 1` off its
 * buttons and a sheet opens on the 48 header with a title, on a title block with one (§9.23;
 * the stack over another sheet, its one scrim and the focus are the chassis's, tested with it).
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

  /** The owner's `onCancel` clears its store flag and the dialog unmounts: what `Dialog` stands in for. */
  function Dialog({
    open,
    onCancel,
    api
  }: {
    open: boolean
    onCancel: () => void
    api?: { current: DialogApi | null }
  }): ReactElement {
    return (
      <FrameDialogHost>
        {open && (
          <DesktopDialog labelledBy="t" onCancel={onCancel} api={api}>
            <h2 id="t">Clear browsing data</h2>
            <button type="button" onClick={() => api?.current?.close()}>
              Cancel
            </button>
          </DesktopDialog>
        )}
      </FrameDialogHost>
    )
  }

  it('moves focus in, and Escape cancels; focus goes back to the anchor as the dialog leaves', () => {
    const anchor = withAnchor()
    const onCancel = vi.fn()
    render(<Dialog open onCancel={onCancel} />)
    expect(document.activeElement?.textContent).toBe('Cancel')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    // The chassis's `usePopover` (§9.22): the owner unmounts the dialog and focus returns.
    act(() => root!.render(<Dialog open={false} onCancel={onCancel} />))
    expect(document.activeElement).toBe(anchor)
    anchor.remove()
  })

  it('a footer button closing through the api returns focus too; a scrim press leaves it', () => {
    const anchor = withAnchor()
    const onCancel = vi.fn()
    const api = { current: null as DialogApi | null }
    const el = render(<Dialog open onCancel={onCancel} api={api} />)
    const cancel = el.querySelector<HTMLButtonElement>('[role="dialog"] button')!
    cancel.focus()
    act(() => cancel.click())
    expect(onCancel).toHaveBeenCalledTimes(1)
    act(() => root!.render(<Dialog open={false} onCancel={onCancel} api={api} />))
    expect(document.activeElement).toBe(anchor)

    // Opened again: an outside press on the scrim cancels without touching focus (§9.22) – the
    // press moved it off the dialog already, so nothing is inside to bring back.
    act(() => root!.unmount())
    anchor.focus()
    const again = vi.fn()
    const el2 = render(<Dialog open onCancel={again} />)
    const scrim = el2.querySelector<HTMLElement>('.zen-frame-scrim')!
    act(() => {
      scrim.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
      scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      scrim.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(again).toHaveBeenCalledTimes(1)
    expect(document.activeElement).not.toBe(anchor)
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    act(() => root!.render(<Dialog open={false} onCancel={again} />))
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
      <div className="zen-sheet-footer">
        <Footer count={3}>
          <button type="button">Allow</button>
          <button type="button">Allow once</button>
          <button type="button">Block</button>
        </Footer>
      </div>
    )
    const slot = el.querySelector<HTMLElement>('.zen-sheet-footer')!
    // Three or more: one column wrapper in the chassis's slot, so the slot's `> * { flex: 1 }`
    // widens the wrapper rather than sharing a height between the buttons (§9.11: each 40).
    expect(slot.children).toHaveLength(1)
    const stack = slot.firstElementChild as HTMLElement
    expect(stack.classList.contains('flex-col')).toBe(true)
    expect(stack.classList.contains('[&>*]:flex-none')).toBe(true)
    expect(stack.children).toHaveLength(3)
    // Two peers: the buttons themselves, splitting the slot's row.
    const pair = render(
      <div className="zen-sheet-footer">
        <Footer count={2}>
          <button type="button">Cancel</button>
          <button type="button">Clear data</button>
        </Footer>
      </div>
    ).querySelector<HTMLElement>('.zen-sheet-footer')!
    expect(pair.children).toHaveLength(2)
    expect(pair.firstElementChild?.tagName).toBe('BUTTON')
  })

  it('a sheet with a title opens on the 48 header; a prompt opens on a title block with its glyph first (§9.23)', () => {
    phone()
    render(
      <V2Sheet
        name="range"
        title="Time range"
        handleLabel="Resize"
        onDismissed={() => undefined}
        data-testid="range"
      >
        <div>options</div>
      </V2Sheet>
    )
    const header = document.querySelector<HTMLElement>(
      '#zen-chrome-layer .zen-sheet-header .zen-sheet-title'
    )
    expect(header?.textContent).toBe('Time range')
    expect(document.querySelector('.zen-sheet-title-block')).toBeNull()
    expect(document.querySelector('[data-testid="range"]')?.textContent).toBe('options')
    act(() => root!.unmount())

    render(
      <V2Sheet
        name="prompt"
        handleLabel="Resize"
        onDismissed={() => undefined}
        titleBlock={
          <TitleBlock
            id="t"
            glyph={<svg data-glyph="camera" />}
            title="Allow example.com to use your camera?"
            description="Your choice is remembered for this site."
          />
        }
        footer={
          <Footer count={2}>
            <button type="button">Block</button>
            <button type="button">Allow</button>
          </Footer>
        }
      >
        <div />
      </V2Sheet>
    )
    expect(document.querySelector('.zen-sheet-header')).toBeNull()
    const block = document.querySelector<HTMLElement>('.zen-sheet-title-block')!
    // The chassis's title block: the glyph on the title's start inside the heading, the
    // description under both (no fill tile, nothing but the block's own padding).
    const heading = block.querySelector('h2')!
    expect(heading.firstElementChild?.querySelector('[data-glyph="camera"]')).not.toBeNull()
    expect(heading.textContent).toBe('Allow example.com to use your camera?')
    expect(block.querySelector('p')?.textContent).toBe('Your choice is remembered for this site.')
    // The footer is the chassis's, outside the scrolling body.
    const footer = document.querySelector<HTMLElement>('#zen-chrome-layer .zen-sheet-footer')!
    expect(footer.closest('.zen-sheet-body')).toBeNull()
    expect(footer.textContent).toBe('BlockAllow')
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

  it('with focus="none" leaves the focus with the page, and "not now" collapses it into its chip', () => {
    vi.useFakeTimers()
    try {
      const page = document.createElement('button')
      page.textContent = 'page'
      document.body.appendChild(page)
      page.focus()
      const onClosed = vi.fn()
      function Prompt({ closing }: { closing: boolean }): ReactElement {
        return (
          <DesktopPopover
            anchor={anchor}
            labelledBy="t"
            focus="none"
            closing={closing}
            collapse
            onDismiss={() => undefined}
            onClosed={onClosed}
            data-testid="prompt"
          >
            {() => (
              <>
                <h2 id="t">Allow example.com to use your camera?</h2>
                <button type="button">Allow</button>
              </>
            )}
          </DesktopPopover>
        )
      }
      render(<Prompt closing={false} />)
      const panel = document.querySelector<HTMLElement>('[role="dialog"]')!
      // A page event raised it beside a chip: nothing in it is armed, the page keeps the focus.
      expect(document.activeElement).toBe(page)
      expect(panel.hasAttribute('data-collapsing')).toBe(false)

      act(() => root!.render(<Prompt closing />))
      // The reversed pop: the transition CSS draws it toward the anchor, fading (§9.20, 180 ms).
      expect(panel.getAttribute('data-collapsing')).toBe('true')
      expect(panel.style.opacity).toBe('0')
      expect(panel.style.transform).toContain('scale(0.94)')
      expect(panel.style.transition).toContain('180ms')
      expect(onClosed).not.toHaveBeenCalled()
      act(() => {
        panel.dispatchEvent(new Event('transitionend'))
      })
      expect(onClosed).toHaveBeenCalledTimes(1)
      // The page keeps the focus throughout: a popover that took none hands none back.
      expect(document.activeElement).toBe(page)
      page.remove()
    } finally {
      vi.useRealTimers()
    }
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
    // The owner answers the dismissal and the popover leaves: the opener gets the focus back.
    act(() => root!.unmount())
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

  it('a menulist opening inside it is its child: the popover stays up, a press in the list keeps both', async () => {
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
    // The list holds its first paint until the page's capture is in place (useFloatingChrome):
    // a few microtasks in the test, where there is no page.
    await act(async () => {
      press(trigger)
      await Promise.resolve()
    })
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

  it('forwards data attributes to its root in both forms; a row without a press is static (§9.34)', () => {
    const el = render(
      <>
        <ListRow label="A" onClick={() => undefined} data-safety-row="updates" />
        <ListRow label="B" data-safety-row="passwords" />
        <ListRow
          label="C"
          control
          trailing={<button type="button">Reset</button>}
          data-site="example.com"
        />
      </>
    )
    const pressable = el.querySelector('button[data-safety-row="updates"]')!
    expect(pressable.hasAttribute('data-static')).toBe(false)
    expect(pressable.classList.contains('zen-v2-row')).toBe(true)
    // A fact and a row holding a control of its own are not targets: no hover or press fill.
    expect(el.querySelector('div[data-safety-row="passwords"]')?.hasAttribute('data-static')).toBe(
      true
    )
    const holder = el.querySelector<HTMLElement>('div[data-site="example.com"]')!
    expect(holder.hasAttribute('data-static')).toBe(true)
    expect(holder.querySelector('button')?.textContent).toBe('Reset')
  })
})

describe('ListRow holding a control (§9.21, pr-228 nit 2)', () => {
  it('marks a one-line control row data-control for the primitive’s control + 8 padding, in both forms', () => {
    const el = render(
      <>
        <ListRow label="Font" control trailing={<button type="button">Sans</button>} />
        <ListRow
          label="Reset"
          control
          onClick={() => undefined}
          trailing={<button type="button">Reset</button>}
        />
        <ListRow label="Connection" trailing={<RowValue>Secure</RowValue>} />
        <ListRow
          label="Column width"
          description="How wide the article runs"
          control
          trailing={<button type="button">Wide</button>}
        />
      </>
    )
    const rows = [...el.querySelectorAll<HTMLElement>('.zen-v2-row')]
    expect(rows).toHaveLength(4)
    const [oneLine, pressable, textOnly, twoLine] = rows
    expect(oneLine.hasAttribute('data-control')).toBe(true)
    expect(pressable.hasAttribute('data-control')).toBe(true)
    // A text-only row is the base row on `--v2-row-pad`.
    expect(textOnly.hasAttribute('data-control')).toBe(false)
    // A two-line row (52 / 64) holds its control inside its lines and keeps the row pad.
    expect(twoLine.hasAttribute('data-control')).toBe(false)
    // The height and padding are the primitive's (main.css `.zen-v2-row`, `[data-control]`): no
    // utility restates them – an unlayered rule beats a utility, so a restatement would only
    // mislead a reader about which number wins.
    for (const row of rows)
      expect([...row.classList].filter((c) => /^(py-|min-h-)/.test(c))).toEqual([])
  })
})

describe('Menulist in a busy form (§9.30)', () => {
  it('read-only keeps its value at full opacity and opens nothing', () => {
    const el = render(
      <Menulist
        value="hour"
        options={[
          { value: 'hour', label: 'Last hour' },
          { value: 'all', label: 'All time' }
        ]}
        onChange={() => undefined}
        label="Time range"
        readOnly
      />
    )
    const trigger = el.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!
    expect(trigger.disabled).toBe(false)
    expect(trigger.getAttribute('aria-readonly')).toBe('true')
    expect(trigger.textContent).toBe('Last hour')
    press(trigger)
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(openPopoverCount()).toBe(0)
  })
})
