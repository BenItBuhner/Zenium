// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState, type JSX, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/*
 * The §9.23 confirmation prompt (components/dialogs/ConfirmDialog.tsx): one exported primitive
 * on the frame dialog host for every "Quit Zenium?", "Delete <folder>?" and "Clear site data?"
 * – a 320 notice (§9.20) with a title block, at most a check row for a body and the §9.11
 * footer; the container holding the focus as it opens with no ring (§9.22), Tab entering at the
 * first control and Shift+Tab at the verb with the keys wrapping at the ends, Enter from the
 * container or the check row activating the verb as the prompt's default button – a destructive
 * prompt's too, the coordinator's open question named in the component – Escape and the scrim
 * as Cancel; the one-hop return (§9.5) waiting for an `inert` to lift, the window chrome's held
 * through the prompt's exit animation or a lower dialog's dropped a render later, and never
 * `body`; the motion the host's, a 120 ms fade under reduced motion (§11.3).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  run: () => undefined,
  cmd: () => Promise.resolve(null),
  onEvent: () => () => undefined
}))

const { FrameDialogHost, useFrameDialog } = await import('@renderer/lib/portals')
const { ConfirmDialog } = await import('../ConfirmDialog')
type Props = Parameters<typeof ConfirmDialog>[0]

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')

let container: HTMLDivElement
let root: Root

function render(el: ReactElement): void {
  act(() => root.render(el))
}

/** Let the host mount its slot, the prompt come up and take the focus, and the effects settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="alertdialog"]:not([data-leaving])')
const buttons = (scope: ParentNode): HTMLButtonElement[] => [
  ...scope.querySelectorAll<HTMLButtonElement>('button')
]
const click = (el: Element | null | undefined): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
/** A key press on `from`; the event comes back, `defaultPrevented` when the prompt answered it. */
function press(from: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    from.dispatchEvent(e)
  })
  return e
}
const pressEscape = (): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}
const pressScrim = (): void => {
  act(() => {
    document
      .querySelector('.zen-frame-scrim')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
  })
}
/** The kept panels' exit animations end (happy-dom runs none): the host lets the chrome go. */
const endExit = (): void => {
  act(() => {
    for (const panel of document.querySelectorAll('.zen-frame-dialogs-slot > [data-leaving]'))
      panel.dispatchEvent(new Event('animationend'))
  })
}
/** A control that refuses the focus while it stands under an `inert`, as a browser's does. */
function refusingUnderInert(el: HTMLElement): void {
  const focus = el.focus.bind(el)
  el.focus = (options) => {
    if (!el.closest('[inert]')) focus(options)
  }
}

const base: Props = {
  name: 'test',
  title: 'Quit Zenium?',
  description: 'You are about to quit with 2 tabs open.',
  action: 'Quit',
  onCancel: () => undefined,
  onConfirm: () => undefined
}

/** TabDialogs' mounting: the prompt inside the frame's host while it is asked. */
function Prompt(props: Partial<Props> & { open?: boolean }): JSX.Element {
  const { open = true, ...rest } = props
  return <FrameDialogHost frame>{open && <ConfirmDialog {...base} {...rest} />}</FrameDialogHost>
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('the confirmation prompt', () => {
  it('is the §9.23 notice at 320 on the frame’s host: alertdialog, the title block with one description, Cancel then the primary verb at the right', async () => {
    render(<Prompt glyph={<svg data-glyph />} data={{ 'data-window-prompt': 'quit' }} />)
    await settle()
    const d = dialog()!
    expect(d).not.toBeNull()
    expect(d.closest('.zen-frame-dialogs-slot')).not.toBeNull()
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.dataset.confirm).toBe('test')
    expect(d.dataset.surface).toBe('page')
    expect(d.dataset.windowPrompt).toBe('quit')
    expect(d.style.width).toBe('320px')
    for (const cls of ['zen-v2-dialog', 'zen-confirm-dialog', 'zen-animate-pop'])
      expect(d.classList.contains(cls), cls).toBe(true)
    const title = d.querySelector<HTMLElement>('.zen-v2-title-block-title')!
    expect(title.tagName).toBe('H2')
    expect(title.textContent).toBe('Quit Zenium?')
    expect(title.firstElementChild?.hasAttribute('data-glyph')).toBe(true)
    expect(d.getAttribute('aria-labelledby')).toBe(title.id)
    const description = d.querySelectorAll('.zen-v2-title-block-description')
    expect(description).toHaveLength(1)
    expect(description[0].textContent).toBe('You are about to quit with 2 tabs open.')
    expect(d.getAttribute('aria-describedby')).toBe(description[0].id)
    // The body holds the footer alone: no check row was asked for.
    const body = d.querySelector('.zen-confirm-dialog-body')!
    expect(body.children).toHaveLength(1)
    expect(body.firstElementChild!.classList.contains('zen-confirm-dialog-footer')).toBe(true)
    const [cancel, verb] = buttons(d)
    expect(buttons(d)).toHaveLength(2)
    expect(cancel.textContent).toBe('Cancel')
    expect(cancel.classList.contains('zen-v2-button')).toBe(true)
    expect(cancel.hasAttribute('data-primary')).toBe(false)
    expect(verb.textContent).toBe('Quit')
    expect(verb.classList.contains('zen-v2-button')).toBe(true)
    expect(verb.hasAttribute('data-primary')).toBe(true)
    expect(verb.hasAttribute('data-danger')).toBe(false)
    expect(d.hasAttribute('data-destructive')).toBe(false)
    // The frame's scrim stands under it.
    expect(document.querySelector('.zen-frame-scrim')).not.toBeNull()
  })

  it('names no description when there is none, and a destructive prompt has no primary: its verb is the secondary in the danger ink', async () => {
    render(<Prompt description={undefined} action="Delete" destructive />)
    await settle()
    const d = dialog()!
    expect(d.querySelector('.zen-v2-title-block-description')).toBeNull()
    expect(d.hasAttribute('aria-describedby')).toBe(false)
    expect(d.dataset.destructive).toBe('true')
    const verb = buttons(d)[1]
    expect(verb.textContent).toBe('Delete')
    expect(verb.hasAttribute('data-danger')).toBe(true)
    expect(d.querySelector('[data-primary]')).toBeNull()
  })

  it('takes a check row as the body’s only element, the shared checkbox with a 15 label, and answers its change', async () => {
    const onChange = vi.fn()
    render(
      <Prompt
        checkbox={{
          label: 'Warn before closing a window with multiple tabs',
          checked: true,
          onChange
        }}
      />
    )
    await settle()
    const d = dialog()!
    const body = d.querySelector('.zen-confirm-dialog-body')!
    expect(body.children).toHaveLength(2)
    const row = body.firstElementChild as HTMLLabelElement
    expect(row.tagName).toBe('LABEL')
    for (const cls of ['zen-v2-row', 'zen-v2-check-row', 'zen-confirm-dialog-check'])
      expect(row.classList.contains(cls), cls).toBe(true)
    const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(box.classList.contains('zen-v2-checkbox')).toBe(true)
    expect(box.checked).toBe(true)
    expect(row.querySelector('.zen-v2-label')!.textContent).toBe(
      'Warn before closing a window with multiple tabs'
    )
    expect(row.querySelector('.zen-v2-description')).toBeNull()
    act(() => {
      box.click()
    })
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('shows the verb at work as aria-busy with the spinner over its kept label, and answers no second confirm meanwhile', async () => {
    const onConfirm = vi.fn()
    render(<Prompt busy onConfirm={onConfirm} />)
    await settle()
    const d = dialog()!
    const verb = buttons(d)[1]
    expect(verb.getAttribute('aria-busy')).toBe('true')
    expect(verb.querySelector('.zen-v2-button-label')!.textContent).toBe('Quit')
    expect(verb.querySelector('.zen-v2-spinner')).not.toBeNull()
    click(verb)
    press(d, 'Enter')
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('the keyboard (§9.22)', () => {
  it('holds the focus on the container as it opens – tabindex −1, no verb preselected – and the chassis draws no ring on it', async () => {
    render(<Prompt />)
    await settle()
    const d = dialog()!
    expect(d.tabIndex).toBe(-1)
    expect(document.activeElement).toBe(d)
    expect(buttons(d)).not.toContain(document.activeElement)
    expect(bare).toContain(
      ":root [role='dialog'][tabindex='-1']:focus-visible, :root [role='alertdialog'][tabindex='-1']:focus-visible { outline: none; }"
    )
    // Nothing of the prompt's own chrome draws one over the container.
    expect(bare).not.toMatch(/\.zen-confirm-dialog[^{,]*:focus/)
    expect(bare).not.toMatch(/\.zen-v2-dialog[^{,]*:focus/)
  })

  it('Tab from the container enters at the first control, Shift+Tab at the verb, and the keys wrap at the ends (lib/popover.ts wrapTab)', async () => {
    render(<Prompt />)
    await settle()
    const d = dialog()!
    const [cancel, verb] = buttons(d)
    expect(press(d, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancel)
    // A step within the prompt is the browser's.
    expect(press(cancel, 'Tab').defaultPrevented).toBe(false)
    act(() => verb.focus())
    expect(press(verb, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancel)
    expect(press(cancel, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
    act(() => d.focus())
    expect(press(d, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
  })

  it('with a check row, Tab enters at the row’s box before Cancel and the verb', async () => {
    render(<Prompt checkbox={{ label: 'Keep asking', checked: true, onChange: () => undefined }} />)
    await settle()
    const d = dialog()!
    const box = d.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    const [cancel, verb] = buttons(d)
    expect(press(d, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(box)
    act(() => cancel.focus())
    expect(press(cancel, 'Tab', { shiftKey: true }).defaultPrevented).toBe(false)
    act(() => verb.focus())
    expect(press(verb, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(box)
    expect(press(box, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
  })

  it('Enter from the container activates the verb as the default button; on a button it is that button’s own; with a modifier it is nothing', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<Prompt onConfirm={onConfirm} onCancel={onCancel} />)
    await settle()
    const d = dialog()!
    const [cancel, verb] = buttons(d)
    expect(press(d, 'Enter').defaultPrevented).toBe(true)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    // A held key repeats nothing.
    expect(press(d, 'Enter', { repeat: true }).defaultPrevented).toBe(false)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }])
      expect(press(d, 'Enter', init).defaultPrevented).toBe(false)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    // Enter on Cancel is Cancel's click, never the default: the prompt leaves it to the button.
    act(() => cancel.focus())
    expect(press(cancel, 'Enter').defaultPrevented).toBe(false)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    act(() => verb.focus())
    expect(press(verb, 'Enter').defaultPrevented).toBe(false)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    // Space and other keys are nothing of the prompt's.
    expect(press(d, ' ').defaultPrevented).toBe(false)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('Enter from the check row activates the verb too, as a form’s Enter submits it', async () => {
    const onConfirm = vi.fn()
    render(
      <Prompt
        onConfirm={onConfirm}
        checkbox={{ label: 'Keep asking', checked: true, onChange: () => undefined }}
      />
    )
    await settle()
    const box = dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => box.focus())
    expect(press(box, 'Enter').defaultPrevented).toBe(true)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('a destructive prompt answers Enter with its verb as well: one rule until the design language says otherwise (the named question)', async () => {
    const onConfirm = vi.fn()
    render(<Prompt action="Delete" destructive onConfirm={onConfirm} />)
    await settle()
    expect(press(dialog()!, 'Enter').defaultPrevented).toBe(true)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('Escape and a press on the scrim are Cancel; the buttons answer as themselves', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<Prompt onConfirm={onConfirm} onCancel={onCancel} />)
    await settle()
    pressEscape()
    expect(onCancel).toHaveBeenCalledTimes(1)
    pressScrim()
    expect(onCancel).toHaveBeenCalledTimes(2)
    const [cancel, verb] = buttons(dialog()!)
    click(cancel)
    expect(onCancel).toHaveBeenCalledTimes(3)
    click(verb)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('the way back (§9.5, §9.22)', () => {
  /** A toolbar button in the window chrome, which the host makes inert while the prompt stands. */
  function chromeControl(): HTMLButtonElement {
    const chrome = document.createElement('div')
    chrome.setAttribute('data-surface', 'window')
    const button = document.createElement('button')
    button.textContent = 'Menu'
    chrome.appendChild(button)
    document.body.appendChild(chrome)
    refusingUnderInert(button)
    return button
  }

  it('returns the keyboard to the control that had it, one hop, once the chrome’s inert – held through the exit animation – lifts, never leaving it on body', async () => {
    const opener = chromeControl()
    opener.focus()
    expect(document.activeElement).toBe(opener)
    render(<Prompt />)
    await settle()
    expect(document.activeElement).toBe(dialog())
    // The chrome is inert while the prompt stands (§9.5).
    expect(opener.closest('[inert]')).not.toBeNull()
    render(<Prompt open={false} />)
    await settle()
    // The prompt has left; the chrome is still held for its panel's way out, so the control
    // refuses the focus – and nothing else has it.
    expect(dialog()).toBeNull()
    expect(document.querySelector('[data-leaving]')).not.toBeNull()
    expect(opener.closest('[inert]')).not.toBeNull()
    expect(document.activeElement).not.toBe(opener)
    endExit()
    await settle()
    expect(opener.closest('[inert]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('returns to nothing of its own with returnFocus false, and to what a function names at the leave', async () => {
    const opener = chromeControl()
    opener.focus()
    render(<Prompt returnFocus={false} />)
    await settle()
    render(<Prompt open={false} returnFocus={false} />)
    await settle()
    endExit()
    await settle()
    expect(document.activeElement).not.toBe(opener)

    const other = document.createElement('button')
    document.body.appendChild(other)
    let answer: 'cancel' | 'delete' = 'delete'
    const where = (): HTMLElement | null => (answer === 'cancel' ? other : null)
    render(<Prompt returnFocus={where} />)
    await settle()
    expect(document.activeElement).toBe(dialog())
    answer = 'cancel'
    render(<Prompt open={false} returnFocus={where} />)
    await settle()
    expect(document.activeElement).toBe(other)
  })

  it('leaves a focus the user has already placed elsewhere alone', async () => {
    const opener = chromeControl()
    opener.focus()
    render(<Prompt />)
    await settle()
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    act(() => elsewhere.focus())
    render(<Prompt open={false} />)
    await settle()
    endExit()
    await settle()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('over an item dialog, returns to that dialog’s control – covered under the prompt, its inert dropped a render later – and not to body', async () => {
    /** A form dialog on the host that covers itself while its prompt stands, as the settings dialogs do. */
    function ItemDialog({
      covered,
      children
    }: {
      covered: boolean
      children?: ReactNode
    }): JSX.Element {
      useFrameDialog({})
      return (
        <div role="dialog" tabIndex={-1} data-dialog="item" inert={covered || undefined}>
          <button data-action="clear">Clear all</button>
          {children}
        </div>
      )
    }
    function Stack(): JSX.Element {
      const [prompt, setPrompt] = useState(false)
      const [covered, setCovered] = useState(false)
      return (
        <FrameDialogHost frame>
          <ItemDialog covered={covered}>
            <button
              data-action="open"
              onClick={() => {
                setPrompt(true)
                setCovered(true)
              }}
            >
              open
            </button>
            <button data-action="uncover" onClick={() => setCovered(false)}>
              uncover
            </button>
          </ItemDialog>
          {prompt && (
            <ConfirmDialog
              {...base}
              action="Clear"
              destructive
              onCancel={() => setPrompt(false)}
              onConfirm={() => setPrompt(false)}
            />
          )}
        </FrameDialogHost>
      )
    }
    render(<Stack />)
    await settle()
    const item = document.querySelector<HTMLElement>('[data-dialog="item"]')!
    const clear = item.querySelector<HTMLButtonElement>('[data-action="clear"]')!
    refusingUnderInert(clear)
    // The form's control is the opener: it has the focus as the prompt comes.
    act(() => clear.focus())
    expect(document.activeElement).toBe(clear)
    click(item.querySelector('[data-action="open"]'))
    await settle()
    const d = dialog()!
    expect(document.activeElement).toBe(d)
    expect(item.hasAttribute('inert')).toBe(true)
    // The prompt answers and leaves; the item dialog is still covered as the cleanup runs.
    press(d, 'Enter')
    await settle()
    expect(dialog()).toBeNull()
    expect(item.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).not.toBe(clear)
    // Its owner drops the cover a render later: the control takes the focus as the inert goes.
    click(item.querySelector('[data-action="uncover"]'))
    await settle()
    expect(item.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(clear)
    expect(document.activeElement).not.toBe(document.body)
  })
})

describe('the chrome and the motion (main.css)', () => {
  const rule = (selector: string): string => {
    const at = bare.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThanOrEqual(0)
    return bare.slice(at, bare.indexOf('}', at))
  }

  it('lays the notice out on the card padding with no hairline and no footer margin: 128 for one description line, 148 for two', () => {
    expect(rule('.zen-confirm-dialog')).toContain('flex-direction: column')
    const body = rule('.zen-confirm-dialog-body')
    expect(body).toContain('gap: var(--v2-card-padding)')
    expect(body).toContain('padding: 0 var(--v2-card-padding) var(--v2-card-padding)')
    const footer = rule('.zen-confirm-dialog-footer')
    expect(footer).toContain('display: flex')
    expect(footer).toContain('justify-content: flex-end')
    expect(footer).toContain('gap: 8px')
    expect(footer).not.toMatch(/margin/)
    // The check row runs edge to edge (§9.25), its box at the gutter.
    const check = rule('.zen-confirm-dialog-check')
    expect(check).toContain('width: calc(100% + 2 * var(--v2-card-padding))')
    expect(check).toContain('margin: 0 calc(-1 * var(--v2-card-padding))')
    // Nothing of the prompt's draws a border.
    for (const selector of [
      '.zen-confirm-dialog',
      '.zen-confirm-dialog-body',
      '.zen-confirm-dialog-check',
      '.zen-confirm-dialog-footer'
    ])
      expect(rule(selector), selector).not.toMatch(/border/)
    // The buttons are the v2 button's 96 (§9.20's 96 + 8 + 96 in 288).
    expect(rule('.zen-v2-button')).toContain('min-width: 96px')
    // The title block's arithmetic the 128 and 148 rest on: 16 · 22 · 4 · 20 · 16.
    expect(bare).toContain('--v2-card-padding: 16px')
    expect(bare).toContain('--v2-line-heading: 22px')
    expect(bare).toContain('--v2-line-body: 20px')
    expect(bare).toContain('--v2-control: 32px')
  })

  it('draws the accent ring outside every legacy .zen-button at the shared offset (§4): offset 0 on the primary’s accent fill was 1.00:1', () => {
    const ring = rule('.zen-button:focus-visible')
    expect(ring).toContain('outline: 2px solid var(--v2-accent)')
    expect(ring).toContain('outline-offset: var(--v2-ring-offset)')
    expect(ring).not.toMatch(/outline-offset: 0/)
  })

  it('pops in and out with the host and fades in place in 120 ms under reduced motion (§11.3)', () => {
    expect(bare).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{ \.zen-animate-pop, \.zen-animate-in, \.zen-animate-fade \{ animation: zen-fade 120ms var\(--zen-ease\) !important; \}/
    )
    expect(bare).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{ \.zen-frame-dialogs:not\(\[data-sheet\]\) \.zen-frame-dialogs-slot > \[data-leaving\], \.zen-frame-dialogs:not\(\[data-sheet\]\) \.zen-frame-scrim\[data-leaving\] \{ animation: zen-fade-out 120ms var\(--zen-ease\) forwards !important; \}/
    )
    // Each hosted root is its own stacking context, ranked by the slot (§9.24).
    expect(rule('.zen-frame-dialogs-slot > *')).toContain('isolation: isolate')
  })
})
