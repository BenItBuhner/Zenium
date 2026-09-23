// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, useState, type JSX, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/*
 * The §9.23 confirmation prompt (components/dialogs/ConfirmDialog.tsx): one exported primitive
 * on the frame dialog host for every "Quit Zenium?", "Delete <folder>?" and "Clear site data?"
 * – a 320 notice (§9.20; 400 when it carries the check row) with a title block, at most a check
 * row for a body and the §9.11
 * footer; the container holding the focus as it opens with no ring (§9.22), Tab entering at the
 * first control and Shift+Tab at the verb with the keys wrapping at the ends, Enter from the
 * container or the check row activating the verb as the prompt's default button – on a prompt
 * whose verb is the primary; a destructive prompt has no default and swallows that Enter (§9.22
 * as amended by the design lead on #392) – Escape and the scrim
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
const { useEscape } = await import('@renderer/hooks/useEscape')
const { ConfirmDialog, PickerDialog, PromptDialog } = await import('../ConfirmDialog')
const { OWN_ENTER, useConfirmKeyboard } = await import('../confirmKeyboard')
type Props = Parameters<typeof ConfirmDialog>[0]
type PromptProps = Parameters<typeof PromptDialog>[0]
type PickerProps = Parameters<typeof PickerDialog>[0]
type Keyboard = Parameters<typeof useConfirmKeyboard>[1]

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')
/** The first rule at `selector` in main.css, comments and runs of whitespace gone. */
const rule = (selector: string): string => {
  const at = bare.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return bare.slice(at, bare.indexOf('}', at))
}

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

  it('takes a check row as the body’s only element at §9.20’s 400 for a prompt with a row, the shared checkbox with a 15 label, and answers its change', async () => {
    const onChange = vi.fn()
    render(
      <Prompt
        checkbox={{
          label: 'Confirm before closing multiple tabs',
          checked: true,
          onChange
        }}
      />
    )
    await settle()
    const d = dialog()!
    // §9.20: the notice is 320 and "takes 400 only when it carries a row or a field (a
    // credential row, a checkbox)".
    expect(d.style.width).toBe('400px')
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
      'Confirm before closing multiple tabs'
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

  it('a destructive prompt has no default (§9.22 as amended): Enter from the held container, or its check row, is swallowed and confirms nothing; Tab reaches Cancel then the verb, whose own Enter is left to the button', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <Prompt
        action="Delete"
        destructive
        onConfirm={onConfirm}
        onCancel={onCancel}
        checkbox={{ label: 'Also forget its pages', checked: false, onChange: () => undefined }}
      />
    )
    await settle()
    const d = dialog()!
    expect(document.activeElement).toBe(d)
    // The prompt takes the key so nothing beneath answers it, and does nothing with it.
    expect(press(d, 'Enter').defaultPrevented).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(d)
    const box = d.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => box.focus())
    expect(press(box, 'Enter').defaultPrevented).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
    // Tab enters at the row's box; the hops on to Cancel and the verb are the browser's own tab
    // order (which happy-dom does not run – the drive walks them in the app). A focused button
    // answers its own Enter and Space as any button – the prompt leaves those keys to it.
    act(() => d.focus())
    const [cancel, verb] = buttons(d)
    expect(press(d, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(box)
    act(() => cancel.focus())
    expect(press(cancel, 'Enter').defaultPrevented).toBe(false)
    act(() => verb.focus())
    expect(press(verb, 'Enter').defaultPrevented).toBe(false)
    expect(press(verb, ' ').defaultPrevented).toBe(false)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    click(verb)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
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

describe('the one-field prompt (PromptDialog, §9.12 on the primitive)', () => {
  const fieldBase: PromptProps = {
    name: 'rename',
    title: 'Name window',
    description:
      'The name stands in the title bar and in tab search in place of the active tab’s title.',
    action: 'Save',
    field: { label: 'Window name', value: 'Research', onChange: () => undefined },
    onCancel: () => undefined,
    onConfirm: () => undefined
  }
  function Field(props: Partial<PromptProps> & { open?: boolean }): JSX.Element {
    const { open = true, ...rest } = props
    return (
      <FrameDialogHost frame>{open && <PromptDialog {...fieldBase} {...rest} />}</FrameDialogHost>
    )
  }
  const prompt = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-confirm="rename"]:not([data-leaving])')
  const input = (): HTMLInputElement => prompt()!.querySelector<HTMLInputElement>('input')!

  it('is a dialog (not an alertdialog) at §9.20’s 400 – the field takes the form width – with the field as the body’s first element at the body’s full width: the shared .zen-v2-field, named by its aria-label, no placeholder, no visible label; the verb is the primary', async () => {
    render(<Field field={{ ...fieldBase.field, maxLength: 120 }} />)
    await settle()
    const d = prompt()!
    expect(d.getAttribute('role')).toBe('dialog')
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.style.width).toBe('400px')
    for (const cls of ['zen-v2-dialog', 'zen-confirm-dialog', 'zen-animate-pop'])
      expect(d.classList.contains(cls), cls).toBe(true)
    expect(d.querySelector('.zen-v2-title-block-title')!.textContent).toBe('Name window')
    expect(d.querySelectorAll('.zen-v2-title-block-description')).toHaveLength(1)
    const body = d.querySelector('.zen-confirm-dialog-body')!
    expect(body.children).toHaveLength(2)
    const f = input()
    expect(body.firstElementChild).toBe(f)
    expect(f.type).toBe('text')
    expect(f.classList.contains('zen-v2-field')).toBe(true)
    expect(f.getAttribute('aria-label')).toBe('Window name')
    expect(f.hasAttribute('placeholder')).toBe(false)
    expect(d.querySelector('label')).toBeNull()
    expect(f.value).toBe('Research')
    expect(f.maxLength).toBe(120)
    expect(f.getAttribute('autocomplete')).toBe('off')
    expect(f.getAttribute('spellcheck')).toBe('false')
    // The field runs the body's full width: `.zen-v2-field` is a block at 100% (main.css).
    expect(rule('.zen-v2-field')).toContain('width: 100%')
    expect(rule('.zen-v2-field')).toContain('display: block')
    const [cancel, verb] = buttons(d)
    expect(cancel.textContent).toBe('Cancel')
    expect(verb.textContent).toBe('Save')
    expect(verb.hasAttribute('data-primary')).toBe(true)
    expect(d.querySelector('[data-danger]')).toBeNull()
    expect(d.hasAttribute('data-destructive')).toBe(false)
    expect(body.lastElementChild!.classList.contains('zen-confirm-dialog-footer')).toBe(true)
  })

  it('focuses the field as it opens – a form, not §9.22’s held container – selecting the value when asked, and answers its change', async () => {
    const onChange = vi.fn()
    render(<Field field={{ ...fieldBase.field, onChange, autoSelect: true }} />)
    await settle()
    const f = input()
    expect(document.activeElement).toBe(f)
    expect(f.selectionStart).toBe(0)
    expect(f.selectionEnd).toBe('Research'.length)
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(f, 'Trip')
      f.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('Trip')

    // Without `autoSelect` the caret is placed and nothing is selected.
    render(<Field open={false} />)
    await settle()
    render(<Field field={{ ...fieldBase.field, value: 'Kept' }} />)
    await settle()
    expect(document.activeElement).toBe(input())
    expect(input().selectionStart).toBe(input().selectionEnd)
  })

  it('Enter in the field is the verb (an input is no own-Enter control), Escape cancels one hop, Tab wraps field → Cancel → verb → field', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<Field onConfirm={onConfirm} onCancel={onCancel} />)
    await settle()
    const d = prompt()!
    const f = input()
    expect(press(f, 'Enter').defaultPrevented).toBe(true)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(press(f, 'Enter', { repeat: true }).defaultPrevented).toBe(false)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    pressEscape()
    expect(onCancel).toHaveBeenCalledTimes(1)
    pressScrim()
    expect(onCancel).toHaveBeenCalledTimes(2)
    const [cancel, verb] = buttons(d)
    act(() => verb.focus())
    expect(press(verb, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(f)
    expect(press(f, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
    // Enter on a button is the button's own.
    act(() => cancel.focus())
    expect(press(cancel, 'Enter').defaultPrevented).toBe(false)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    click(verb)
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })

  it('over another dialog it is the 320 notice even with its field (§9.5: place beats content), and returns to that dialog’s control', async () => {
    function ItemDialog(): JSX.Element {
      useFrameDialog({})
      return (
        <div role="dialog" tabIndex={-1} data-dialog="item">
          <button data-action="rename">Rename</button>
        </div>
      )
    }
    function Stack({ prompt }: { prompt: boolean }): JSX.Element {
      return (
        <FrameDialogHost frame>
          <ItemDialog />
          {prompt && <PromptDialog {...fieldBase} />}
        </FrameDialogHost>
      )
    }
    render(<Stack prompt={false} />)
    await settle()
    const rename = document.querySelector<HTMLButtonElement>('[data-action="rename"]')!
    act(() => rename.focus())
    render(<Stack prompt />)
    await settle()
    const d = prompt()!
    expect(d.previousElementSibling).toBe(document.querySelector('[data-dialog="item"]'))
    expect(d.style.width).toBe('320px')
    expect(document.activeElement).toBe(input())
    render(<Stack prompt={false} />)
    await settle()
    expect(document.activeElement).toBe(rename)
  })

  it('returns nothing of its own with returnFocus false, as a prompt whose closer hands the keyboard to the page asks', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    render(<Field returnFocus={false} />)
    await settle()
    expect(document.activeElement).toBe(input())
    render(<Field open={false} returnFocus={false} />)
    await settle()
    endExit()
    await settle()
    expect(document.activeElement).not.toBe(opener)
  })
})

describe('the picker (PickerDialog, a list body on the primitive)', () => {
  /*
   * The device chooser's shape (services' `DeviceChooserDialog` is built on the export; none
   * stands in the primitive's file): the consumer's list – a single-select listbox with one row
   * tabbable, its roving focus its own – in the body's slot, and Connect waiting for a pick.
   */
  function Devices({ picked }: { picked?: string }): JSX.Element {
    return (
      <ul role="listbox" aria-label="Devices" data-devices>
        {['Arduino Uno', 'Keyboard'].map((device, i) => (
          <li
            key={device}
            role="option"
            tabIndex={i === 0 ? 0 : -1}
            aria-selected={picked === device}
            data-device={device}
          >
            {device}
          </li>
        ))}
      </ul>
    )
  }
  const pickBase: PickerProps = {
    name: 'devices',
    title: 'Connect a device',
    description: 'example.com wants to connect to a USB device.',
    action: 'Connect',
    body: <Devices />,
    disabled: true,
    onCancel: () => undefined,
    onConfirm: () => undefined
  }
  function Picker(props: Partial<PickerProps> & { open?: boolean }): JSX.Element {
    const { open = true, ...rest } = props
    return (
      <FrameDialogHost frame>{open && <PickerDialog {...pickBase} {...rest} />}</FrameDialogHost>
    )
  }
  const picker = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-confirm="devices"]:not([data-leaving])')
  const rows = (): HTMLElement[] => [...picker()!.querySelectorAll<HTMLElement>('[role="option"]')]

  it('is a dialog (not an alertdialog) at §9.20’s 400 – a list is a row body – carrying the consumer’s list in the body’s slot as its first element, the footer last; the verb is the primary', async () => {
    render(<Picker data={{ 'data-chooser': 'usb' }} />)
    await settle()
    const d = picker()!
    expect(d).not.toBeNull()
    expect(d.closest('.zen-frame-dialogs-slot')).not.toBeNull()
    expect(d.getAttribute('role')).toBe('dialog')
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.dataset.body).toBe('list')
    expect(d.dataset.chooser).toBe('usb')
    expect(d.dataset.surface).toBe('page')
    expect(d.style.width).toBe('400px')
    for (const cls of ['zen-v2-dialog', 'zen-confirm-dialog', 'zen-animate-pop'])
      expect(d.classList.contains(cls), cls).toBe(true)
    expect(d.querySelector('.zen-v2-title-block-title')!.textContent).toBe('Connect a device')
    expect(d.querySelectorAll('.zen-v2-title-block-description')).toHaveLength(1)
    const body = d.querySelector('.zen-confirm-dialog-body')!
    expect(body.children).toHaveLength(2)
    const slot = body.firstElementChild!
    expect(slot.classList.contains('zen-confirm-dialog-slot')).toBe(true)
    expect(slot.children).toHaveLength(1)
    expect(slot.firstElementChild).toBe(d.querySelector('[data-devices]'))
    expect(rows().map((r) => r.textContent)).toEqual(['Arduino Uno', 'Keyboard'])
    expect(d.querySelector('input')).toBeNull()
    expect(body.lastElementChild!.classList.contains('zen-confirm-dialog-footer')).toBe(true)
    const [cancel, verb] = buttons(d)
    expect(cancel.textContent).toBe('Cancel')
    expect(verb.textContent).toBe('Connect')
    expect(verb.hasAttribute('data-primary')).toBe(true)
    expect(d.querySelector('[data-danger]')).toBeNull()
    expect(d.hasAttribute('data-destructive')).toBe(false)
  })

  it('holds the focus on the CONTAINER as it opens – a choice, not a form: no row and no verb preselected – the first Tab enters the list at the row the consumer made tabbable, Shift+Tab lands on the verb, the keys wrap at the ends, and a step within the list is the consumer’s', async () => {
    render(<Picker />)
    await settle()
    const d = picker()!
    expect(d.tabIndex).toBe(-1)
    expect(document.activeElement).toBe(d)
    const [first, second] = rows()
    const [cancel, verb] = buttons(d)
    expect(press(d, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    // Within the list the keys are the consumer's: nothing of the prompt's answers them.
    expect(press(first, 'ArrowDown').defaultPrevented).toBe(false)
    expect(press(first, 'Tab').defaultPrevented).toBe(false)
    act(() => d.focus())
    expect(press(d, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
    expect(press(verb, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    expect(press(first, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
    // The second row, at tabindex −1, is the consumer's to reach by arrow: never the wrap's.
    expect(second.tabIndex).toBe(-1)
    act(() => cancel.focus())
    expect(press(cancel, 'Tab', { shiftKey: true }).defaultPrevented).toBe(false)
  })

  it('the verb before a pick is aria-disabled – §9.30’s one ink on a real, reachable button – and inert: Enter from the container or a row is consumed and connects nothing, a press is a no-op, its own Enter is the button’s; a pick enables it, and busy is not disabled', async () => {
    const onConfirm = vi.fn()
    render(<Picker onConfirm={onConfirm} />)
    await settle()
    const d = picker()!
    const [cancel, verb] = buttons(d)
    expect(verb.getAttribute('aria-disabled')).toBe('true')
    expect(verb.disabled).toBe(false)
    expect(verb.hasAttribute('aria-busy')).toBe(false)
    expect(press(d, 'Enter').defaultPrevented).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
    // From a row too: a row is no own-Enter control, so its Enter is the prompt's – inert here.
    expect(press(rows()[0], 'Enter').defaultPrevented).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
    click(verb)
    expect(onConfirm).not.toHaveBeenCalled()
    act(() => verb.focus())
    expect(press(verb, 'Enter').defaultPrevented).toBe(false)
    expect(onConfirm).not.toHaveBeenCalled()
    // Reachable: Shift+Tab from the container lands on it as on any verb – a `disabled` button
    // would have left the wrap, and the wrap would shift as the pick enabled it.
    act(() => d.focus())
    expect(press(d, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
    act(() => cancel.focus())
    expect(press(cancel, 'Tab').defaultPrevented).toBe(false)

    // A pick: the verb is an answer – Enter from the container or the row, and the press.
    render(
      <Picker onConfirm={onConfirm} disabled={false} body={<Devices picked="Arduino Uno" />} />
    )
    await settle()
    expect(picker()).toBe(d)
    expect(verb.hasAttribute('aria-disabled')).toBe(false)
    expect(rows()[0].getAttribute('aria-selected')).toBe('true')
    expect(press(d, 'Enter').defaultPrevented).toBe(true)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(press(rows()[0], 'Enter').defaultPrevented).toBe(true)
    expect(onConfirm).toHaveBeenCalledTimes(2)
    click(verb)
    expect(onConfirm).toHaveBeenCalledTimes(3)
    // Busy is not disabled (§9.30): a working verb keeps its ink and answers no second confirm.
    render(
      <Picker onConfirm={onConfirm} disabled={false} busy body={<Devices picked="Arduino Uno" />} />
    )
    await settle()
    expect(verb.getAttribute('aria-busy')).toBe('true')
    expect(verb.hasAttribute('aria-disabled')).toBe(false)
    click(verb)
    expect(press(d, 'Enter').defaultPrevented).toBe(true)
    expect(onConfirm).toHaveBeenCalledTimes(3)
  })

  it('over another dialog it is the 320 notice even with its list (§9.5: place beats content), holds the focus on its own container, Escape is one hop – its Cancel, not the dialog’s under it – and the keyboard returns to that dialog’s control', async () => {
    const onCancel = vi.fn()
    const onLowerEscape = vi.fn()
    function ItemDialog(): JSX.Element {
      useFrameDialog({})
      useEscape(onLowerEscape)
      return (
        <div role="dialog" tabIndex={-1} data-dialog="item">
          <button data-action="connect">Connect a device</button>
        </div>
      )
    }
    function Stack({ open }: { open: boolean }): JSX.Element {
      return (
        <FrameDialogHost frame>
          <ItemDialog />
          {open && <PickerDialog {...pickBase} onCancel={onCancel} />}
        </FrameDialogHost>
      )
    }
    render(<Stack open={false} />)
    await settle()
    const opener = document.querySelector<HTMLButtonElement>('[data-action="connect"]')!
    act(() => opener.focus())
    render(<Stack open />)
    await settle()
    const d = picker()!
    expect(d.previousElementSibling).toBe(document.querySelector('[data-dialog="item"]'))
    expect(d.style.width).toBe('320px')
    expect(document.activeElement).toBe(d)
    pressEscape()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onLowerEscape).not.toHaveBeenCalled()
    render(<Stack open={false} />)
    await settle()
    expect(document.activeElement).toBe(opener)
    // With the picker gone the next Escape is the dialog's under it.
    pressEscape()
    expect(onLowerEscape).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Escape, a press on the scrim and Cancel are Cancel, and none of them is Connect', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<Picker onCancel={onCancel} onConfirm={onConfirm} disabled={false} />)
    await settle()
    pressEscape()
    expect(onCancel).toHaveBeenCalledTimes(1)
    pressScrim()
    expect(onCancel).toHaveBeenCalledTimes(2)
    click(buttons(picker()!)[0])
    expect(onCancel).toHaveBeenCalledTimes(3)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('the slot runs edge to edge like the check row (§9.25) and scrolls under the title block at the list’s 80% cap (§9.20); the disabled verb is §9.30’s one ink – .4 on the whole control, its fill at rest under hover and press, no press scale, the primary’s accent kept – standing after the button’s press rules it overrides at equal specificity', () => {
    const slot = rule('.zen-confirm-dialog-body > .zen-confirm-dialog-slot')
    expect(slot).toContain('width: calc(100% + 2 * var(--v2-card-padding))')
    expect(slot).toContain('margin: 0 calc(-1 * var(--v2-card-padding))')
    expect(slot).toContain('min-height: 0')
    expect(slot).toContain('overflow-y: auto')
    expect(slot).toContain('overscroll-behavior: contain')
    // No gutter of the slot's own and no line: the rows inside carry §9.25's 16.
    expect(slot).not.toMatch(/border|[ ;]padding:/)
    expect(rule(".zen-confirm-dialog[data-body='list']")).toContain('max-height: 80%')
    expect(rule(".zen-confirm-dialog[data-body='list'] > .zen-confirm-dialog-body")).toContain(
      'min-height: 0'
    )
    // Only the list body takes the cap: the notice's own rule stands as tall as its content.
    expect(rule('.zen-confirm-dialog')).not.toMatch(/max-height/)
    expect(rule('.zen-confirm-dialog-body')).not.toMatch(/min-height|overflow/)
    const off = rule(".zen-confirm-dialog-footer > .zen-v2-button[aria-disabled='true']")
    expect(off).toContain('opacity: 0.4')
    expect(off).toContain('background: var(--v2-fill)')
    expect(off).toContain('transform: none')
    expect(
      rule(".zen-confirm-dialog-footer > .zen-v2-button[data-primary][aria-disabled='true']")
    ).toContain('background: var(--v2-accent)')
    // The order the override rests on: the shared press rules stand earlier in main.css, and
    // the hover rules in extensions.css, which main.css imports before any rule of its own.
    const offAt = bare.indexOf(
      ".zen-confirm-dialog-footer > .zen-v2-button[aria-disabled='true'] {"
    )
    for (const pressed of [
      '.zen-v2-button:active:not(:disabled) {',
      '.zen-v2-button[data-primary]:active:not(:disabled) {'
    ]) {
      expect(bare.indexOf(pressed), pressed).toBeGreaterThanOrEqual(0)
      expect(bare.indexOf(pressed), pressed).toBeLessThan(offAt)
    }
    const extensions = readFileSync(resolve(__dirname, '../../../assets/extensions.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
    for (const hovered of [
      '.zen-v2-button:hover:not(:disabled) {',
      '.zen-v2-button[data-primary]:hover:not(:disabled) {'
    ])
      expect(extensions, hovered).toContain(hovered)
    expect(bare.indexOf("@import './extensions.css';")).toBeGreaterThanOrEqual(0)
    expect(bare.indexOf("@import './extensions.css';")).toBeLessThan(
      bare.indexOf('.zen-confirm-dialog {')
    )
    // Nothing of the picker's draws a ring rule of its own or reaches for `:disabled`.
    expect(bare).not.toMatch(/\.zen-confirm-dialog[^{,]*:disabled/)
  })
})

describe('the exported keyboard (useConfirmKeyboard, dialogs/confirmKeyboard.ts) on a bare container', () => {
  /**
   * Any held container – no dialog, no host: a `tabIndex -1` box with a text field and two
   * buttons, held by the hook alone. `inner` puts the ref on a body inside it and names the box
   * through `container`, a phone sheet's shape.
   */
  function Bare(props: Partial<Keyboard> & { inner?: boolean }): JSX.Element {
    const { inner = false, confirm = () => undefined, destructive = false, ...rest } = props
    const ref = useRef<HTMLDivElement>(null)
    useConfirmKeyboard(ref, { destructive, confirm, ...rest })
    const controls = (
      <>
        <input data-field />
        <button data-cancel>Cancel</button>
        <button data-verb>Verb</button>
      </>
    )
    return (
      <div data-bare tabIndex={-1} ref={inner ? undefined : ref}>
        {inner ? (
          <div data-body ref={ref}>
            {controls}
          </div>
        ) : (
          controls
        )}
      </div>
    )
  }
  const box = (): HTMLElement => document.querySelector<HTMLElement>('[data-bare]')!
  const part = (name: string): HTMLElement => box().querySelector<HTMLElement>(`[data-${name}]`)!

  it('exports the own-Enter selector the phone’s sheet keeps a copy of: buttons, links, selects and textareas, never a text input', () => {
    expect(OWN_ENTER).toBe('button, a[href], [role="button"], select, textarea')
    render(<Bare />)
    expect(part('cancel').matches(OWN_ENTER)).toBe(true)
    expect(part('field').matches(OWN_ENTER)).toBe(false)
  })

  it('Enter from the container, or from a text field in it, is the verb – once, with no modifier, not a held key’s repeat, not one composing – and reaches nothing beneath; on a button it is that button’s own', async () => {
    const confirm = vi.fn()
    const beneath = vi.fn()
    document.addEventListener('keydown', beneath)
    render(<Bare confirm={confirm} />)
    await settle()
    act(() => box().focus())
    expect(press(box(), 'Enter').defaultPrevented).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(beneath).not.toHaveBeenCalled()
    // A field's Enter submits the prompt as a form's does: an input is not an own-Enter control.
    act(() => part('field').focus())
    expect(press(part('field'), 'Enter').defaultPrevented).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(press(box(), 'Enter', { repeat: true }).defaultPrevented).toBe(false)
    for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }])
      expect(press(box(), 'Enter', init).defaultPrevented).toBe(false)
    expect(press(box(), 'Enter', { isComposing: true }).defaultPrevented).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(2)
    // Enter on a button is the button's – left alone, and it bubbles on as any key does.
    act(() => part('cancel').focus())
    expect(press(part('cancel'), 'Enter').defaultPrevented).toBe(false)
    expect(press(part('verb'), 'Enter').defaultPrevented).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(2)
    // The repeat, the four modified, the composing one and the two buttons' own: eight bubbled.
    expect(beneath).toHaveBeenCalledTimes(8)
    expect(press(box(), ' ').defaultPrevented).toBe(false)
    document.removeEventListener('keydown', beneath)
  })

  it('a destructive container has no default: Enter from it, or from its field, is swallowed and confirms nothing, and a button’s own Enter is left to the button', async () => {
    const confirm = vi.fn()
    const beneath = vi.fn()
    document.addEventListener('keydown', beneath)
    render(<Bare destructive confirm={confirm} />)
    await settle()
    act(() => box().focus())
    expect(press(box(), 'Enter').defaultPrevented).toBe(true)
    expect(press(part('field'), 'Enter').defaultPrevented).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(beneath).not.toHaveBeenCalled()
    expect(press(part('verb'), 'Enter').defaultPrevented).toBe(false)
    expect(press(part('verb'), ' ').defaultPrevented).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    document.removeEventListener('keydown', beneath)
  })

  it('Tab from the container enters at its first control, Shift+Tab at its last, and wraps at the ends; a step within is the browser’s; `tab: false` leaves the key to the chassis', async () => {
    render(<Bare />)
    await settle()
    const [field, cancel, verb] = [part('field'), part('cancel'), part('verb')]
    act(() => box().focus())
    expect(press(box(), 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(field)
    expect(press(field, 'Tab').defaultPrevented).toBe(false)
    act(() => verb.focus())
    expect(press(verb, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(field)
    expect(press(field, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
    act(() => box().focus())
    expect(press(box(), 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
    expect(cancel).not.toBe(document.activeElement)

    render(<Bare tab={false} />)
    await settle()
    act(() => box().focus())
    expect(press(box(), 'Tab').defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(box())
    // Enter is still the hook's.
    expect(press(box(), 'Enter').defaultPrevented).toBe(true)
  })

  it('`enabled: false` leaves every key alone, and back on it listens again; `container` places the listener on the element found up from the ref – a sheet’s body to its dialog root', async () => {
    const confirm = vi.fn()
    render(<Bare confirm={confirm} enabled={false} />)
    await settle()
    act(() => box().focus())
    expect(press(box(), 'Enter').defaultPrevented).toBe(false)
    expect(press(box(), 'Tab').defaultPrevented).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    render(<Bare confirm={confirm} enabled />)
    await settle()
    expect(press(box(), 'Enter').defaultPrevented).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    root = createRoot(container)
    const later = vi.fn()
    render(
      <Bare inner confirm={later} container={(body) => body.closest<HTMLElement>('[data-bare]')} />
    )
    await settle()
    // The focus held on the box, above the body the ref names: heard, because the listener
    // stands on the box.
    act(() => box().focus())
    expect(press(box(), 'Enter').defaultPrevented).toBe(true)
    expect(later).toHaveBeenCalledTimes(1)
    expect(press(box(), 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(part('field'))
  })

  it('reads the verb and the destructive flag at the key, not at the binding: a prompt whose verb turns busy or destructive answers as it stands', async () => {
    const first = vi.fn()
    const second = vi.fn()
    render(<Bare confirm={first} />)
    await settle()
    render(<Bare confirm={second} />)
    act(() => box().focus())
    expect(press(box(), 'Enter').defaultPrevented).toBe(true)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    render(<Bare confirm={second} destructive />)
    expect(press(box(), 'Enter').defaultPrevented).toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
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

  it('a getter’s null falls back to the opener – #401’s rowControl, the row’s control looked up after the verb removed its row – unless the opener is gone too; a getter’s false is nowhere, as a plain false is', async () => {
    // A settings page's row with its confirmation; the keyboard stood on a toolbar button as the
    // prompt came (the row was reached by pointer), so that button is the opener.
    const opener = chromeControl()
    opener.focus()
    const list = document.createElement('div')
    const row = document.createElement('button')
    row.setAttribute('data-row', 'clear')
    list.appendChild(row)
    document.body.appendChild(list)
    const rowControl = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-row="clear"]')
    render(<Prompt returnFocus={rowControl} />)
    await settle()
    expect(document.activeElement).toBe(dialog())
    // The verb removed the row: the getter yields null as the prompt leaves – one hop down to
    // the opener (once the chrome's inert lifts), never nowhere.
    row.remove()
    render(<Prompt open={false} returnFocus={rowControl} />)
    await settle()
    endExit()
    await settle()
    expect(document.activeElement).toBe(opener)

    // While the row stands it is the target, whatever the opener.
    list.appendChild(row)
    render(<Prompt returnFocus={rowControl} />)
    await settle()
    render(<Prompt open={false} returnFocus={rowControl} />)
    await settle()
    endExit()
    await settle()
    expect(document.activeElement).toBe(row)

    // The row gone and the opener with it (an item dialog's control, closed under the prompt):
    // nowhere – that dialog's own return governs.
    act(() => opener.focus())
    render(<Prompt returnFocus={rowControl} />)
    await settle()
    row.remove()
    opener.remove()
    render(<Prompt open={false} returnFocus={rowControl} />)
    await settle()
    endExit()
    await settle()
    expect(document.activeElement).toBe(document.body)

    // A getter that means nowhere says so: its `false` is not the opener's fallback.
    const again = chromeControl()
    again.focus()
    render(<Prompt returnFocus={() => false} />)
    await settle()
    expect(document.activeElement).toBe(dialog())
    render(<Prompt open={false} returnFocus={() => false} />)
    await settle()
    endExit()
    await settle()
    expect(document.activeElement).not.toBe(again)
    expect(again.isConnected).toBe(true)
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

  it('over an item dialog it is the 320 notice even with a check row (§9.5: never the 400 of the dialog it covers), and returns to that dialog’s control – covered under the prompt, its inert dropped a render later – not to body', async () => {
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
              checkbox={{ label: 'Also clear cookies', checked: false, onChange: () => {} }}
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
    // The later sibling in the one slot, above the dialog it covers – and the notice's width
    // over it although it carries a row (alone, the row would make it 400).
    expect(d.parentElement).toBe(item.parentElement)
    expect(d.previousElementSibling).toBe(item)
    expect(d.style.width).toBe('320px')
    expect(d.querySelector('.zen-confirm-dialog-check')).not.toBeNull()
    // The prompt answers through its verb (a destructive prompt has no default for Enter to
    // reach) and leaves; the item dialog is still covered as the cleanup runs.
    expect(press(d, 'Enter').defaultPrevented).toBe(true)
    expect(dialog()).toBe(d)
    click(buttons(d)[1])
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
    // The check row runs edge to edge (§9.25), its box at the gutter – past the row primitive's
    // own unlayered `width: 100%`, which stands LATER in the file at one class: a one-class rule
    // here lost to it by order while the negative margin still applied, and the row ran from
    // the left border to 32 short of the right (pr-392 A1). The body's specificity wins
    // whatever the order.
    const check = rule('.zen-confirm-dialog-body > .zen-confirm-dialog-check')
    expect(check).toContain('width: calc(100% + 2 * var(--v2-card-padding))')
    expect(check).toContain('margin: 0 calc(-1 * var(--v2-card-padding))')
    const row = rule('.zen-v2-row')
    expect(row).toContain('width: 100%')
    expect(bare.indexOf('.zen-v2-row {')).toBeGreaterThan(
      bare.indexOf('.zen-confirm-dialog-body > .zen-confirm-dialog-check {')
    )
    // No one-class rule for the row is left to lose that way: every rule on it is the body's.
    const rules = [...bare.matchAll(/\.zen-confirm-dialog-check \{/g)].map((m) => m.index)
    expect(rules.length).toBeGreaterThan(0)
    for (const at of rules) expect(bare.slice(0, at)).toMatch(/\.zen-confirm-dialog-body > $/)
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
