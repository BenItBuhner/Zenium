import type { JSX, ReactNode } from 'react'
import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { useEscape } from '@renderer/hooks/useEscape'
import { returnFocusTo } from '@renderer/lib/popover'
import { FrameDialogPortal, POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
import { V2TitleBlock } from '../extensions/v2'
import { useConfirmKeyboard } from './confirmKeyboard'

/**
 * Where the keyboard goes as a prompt leaves (§9.5, §9.22): the control that had it as the
 * prompt opened (the OPENER – the default, `undefined`), an element, or `false` for no return
 * of the prompt's own (a consumer that hands the keyboard to the page itself); or a function
 * read at the leave, for a consumer that decides by the answer – a keyboard's Cancel to the row
 * it came from, a Delete whose row goes with it. What the function yields reads the same way:
 * an element is the target, `false` is nowhere, and `null` or `undefined` – a row control looked
 * up after its row was removed (#401's `rowControl`) – FALLS BACK TO THE OPENER (one hop down,
 * unless the opener is gone too), never to nowhere: a getter that means nowhere says `false`.
 */
export type ConfirmReturnFocus =
  HTMLElement | (() => HTMLElement | null | undefined | false) | false

export interface ConfirmDialogProps {
  /** The prompt's name on its root, `data-confirm="<name>"`: a test's and a drive's handle. */
  name: string
  /** The question, 17/600: "Quit Zenium?", "Delete Trip planning?". */
  title: ReactNode
  /** A 16 glyph at the title's start (a deletion's trash); the quit prompt carries none (§9.23). */
  glyph?: ReactNode
  /**
   * The title block's ONE description, 15 at 69%: every fact the prompt states, as peers in one
   * paragraph (§9.23's composed-prompt rule). Empty for a question that needs no more words.
   */
  description?: ReactNode
  /** The verb's label: Quit, Close tabs, Delete, Clear. Cancel is always Cancel. */
  action: string
  /**
   * A destructive confirmation has no primary (§6): its verb is a secondary in the danger ink
   * beside Cancel, and it has no default key either (§9.22 as amended) – Enter from the held
   * container does nothing; Delete answers only its own Enter or Space. Otherwise the verb is
   * the accent primary and the prompt's default.
   */
  destructive?: boolean
  /**
   * The verb is at work (§9.30): `aria-busy` with the spinner over its label, and neither a
   * press on it nor Enter confirms again.
   */
  busy?: boolean
  /**
   * The verb is not yet an answer (§9.30): a picker's Connect until a device is picked. One
   * ink – .4 on the whole control, no hover or press fill – as `aria-disabled`, not `disabled`:
   * the verb stays in the tab order, so Tab from Cancel still finds it and a reader hears why,
   * and the wrap does not shift as a pick enables it. A press on it does nothing, and Enter from
   * the held container is inert while it stands – consumed, as §9.22 has it, answering nothing.
   * Busy is not disabled (§9.30): a working verb keeps its ink; the two do not combine.
   */
  disabled?: boolean
  /** The body's one element, when the prompt has one: a check row under the description (§9.23). */
  checkbox?: { label: string; checked: boolean; onChange: (next: boolean) => void }
  /** Cancel: the button, Escape and a press on the scrim. */
  onCancel: () => void
  /**
   * The verb: its button, and – on a prompt that is not `destructive` – Enter from the prompt's
   * container or its check row.
   */
  onConfirm: () => void
  returnFocus?: ConfirmReturnFocus
  /** A consumer's own `data-*` handles on the root (`data-window-prompt`, `data-folder-delete`). */
  data?: Record<`data-${string}`, string | number | boolean | undefined>
  className?: string
}

/**
 * The §9.23 confirmation prompt: a notice at §9.20's 320 on the frame's dialog host, over the
 * page's picture under the frame's scrim (§9.5). A title block – the question at 17/600 with an
 * optional 16 glyph, one description at 15 in the deemphasised ink, 16 to the body – then, when
 * the prompt has one, a check row as the body's only element, then the §9.11 footer: Cancel and
 * the verb, 96 | 8 | 96 hugging the right at 16, the verb in the danger ink when the answer
 * destroys something and the accent primary otherwise. Nothing else: a prompt with more is a
 * form dialog (the one-field prompt is `PromptDialog` and the list picker `PickerDialog`, below,
 * on the same panel). The width is §9.20's, by content and by place: the 320 notice for a title block
 * and its two buttons; 400 when the prompt carries the check row ("takes 400 only when it
 * carries a row or a field (a credential row, a checkbox)" – at 320 the quit prompt's two
 * sentences ran to three lines and its checkbox label wrapped, measured); and the notice again,
 * row or not, when it opens over another dialog in the slot ("a 400 prompt over a 400 dialog is
 * the unreadable stack of §9"; §9.5: "never the 400 of the dialog it covers"). The place is read
 * once, as the prompt mounts, before its first paint.
 *
 * The keyboard (§9.22 as amended by the design lead on #392; `useConfirmKeyboard` in
 * `confirmKeyboard.ts` beside this file, the one implementation of it, for any held
 * container): the CONTAINER holds the focus as
 * the prompt opens – its root is `tabIndex -1`, the container the keyboard is sent to and cannot
 * reach by Tab, so the chassis draws no ring on it
 * (`[role='alertdialog'][tabindex='-1']:focus-visible` in main.css) and no verb is preselected.
 * Tab enters at Cancel, Shift+Tab at the verb, and between them the keys wrap at the ends
 * (lib/popover.ts `wrapTab`). On a prompt whose verb is the primary (Quit), Enter from the
 * container, or from the check row, activates the verb as the prompt's default button – as
 * Firefox's and Chrome's dialogs answer Enter from the dialog itself, because they draw the verb
 * as their primary. A DESTRUCTIVE prompt has no default: §6 draws it with no primary because
 * the app recommends neither answer, and a default key is a recommendation as much as a fill –
 * so Enter from its held container (or its check row) is inert, consumed and answering nothing;
 * Tab reaches Cancel then the verb, and a focused button answers Enter and Space as any button
 * does (a double Return through a native menu – Shift+F10, Up, Return, Return – lands on the
 * container and deletes nothing). Enter on a button is that button's own in either form.
 * Escape and a press on the scrim are Cancel.
 *
 * The return (§9.5, one hop down): as the prompt leaves, the keyboard goes back to where it
 * came from through `returnFocusTo`, which waits for an `inert` to lift – the window chrome's,
 * held by the host through the prompt's exit animation, or a lower dialog's, whose owner drops
 * its cover a render later than this cleanup runs – and never lets the focus fall to `body`;
 * unless something else took the focus meanwhile. The panel renders through
 * `FrameDialogPortal`: into the nearest host from inside a page or a dialog, else the frame's.
 *
 * Motion is the host's: the §9.5 pop in and out, the §11.3 120 ms fade in place under reduced
 * motion (`zen-animate-pop`, the slot's `[data-leaving]` rule); the slot gives each root its
 * `isolation` and its rank.
 */
export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
  return (
    <FrameDialogPortal>
      <ConfirmPanel {...props} />
    </FrameDialogPortal>
  )
}

/**
 * A prompt's one field (§9.12): its name, its value, whether the value is selected on open, and
 * – for a field that asks for one kind of value – the input's own options: what keyboard a
 * touch host raises (`inputMode`), what the value must match (`pattern`), what the host may
 * fill in (`autoComplete`), and a class of the consumer's on the `<input>` itself
 * (`className`) for what the field's look needs that the shared `.zen-v2-field` does not draw.
 * The case that asked for them (#418's Bluetooth `providePin` prompt): six digits typed into
 * the field – `inputMode: 'numeric'` so a phone or a tablet raises the digit keyboard,
 * `pattern: '[0-9]*'`, and a class carrying `font-variant-numeric: tabular-nums` and the
 * letter-spacing that sets digits apart, which until these options existed had to reach into
 * the primitive from outside (`.zen-confirm-dialog[data-pairing-kind='providePin']
 * .zen-v2-field[aria-label='PIN']`). The field stays `type="text"` whatever the options say: a
 * number field's spinner and a `tel` field's semantics are not a prompt's (§9.12), and the
 * keyboard on a touch host is `inputMode`'s to choose.
 */
export interface PromptField {
  /**
   * The field's name, its `aria-label` – a one-field prompt whose title names what is asked
   * draws no visible label (§9.12: the title is the label), and never a placeholder standing in
   * for one (the #396 ruling: a placeholder is example text; Chrome's field here is empty).
   */
  label: string
  value: string
  onChange: (next: string) => void
  maxLength?: number
  /** Select the value as the prompt opens, so typing replaces it (a rename, a window's name). */
  autoSelect?: boolean
  /**
   * The keyboard a touch host raises for the field (the `inputmode` attribute): `numeric` for
   * a PIN or a count, `decimal` for a measure, `tel`, `email`, `url` for those; `text` – the
   * default, drawn as no attribute – for words. A mouse host ignores it.
   */
  inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url'
  /**
   * What the value must match, as the `pattern` attribute (`[0-9]*` for digits): the host's
   * own constraint, read by ATs and by a touch keyboard beside `inputMode`; the consumer keeps
   * the value clean in `onChange` all the same (a PIN's `sanitizePin`), since a pattern does
   * not stop a paste.
   */
  pattern?: string
  /**
   * The `autocomplete` attribute: `off` – the default – for a value the host must not fill in
   * (a name, a PIN: `one-time-code` is a code sent to the user, which a pairing PIN is not);
   * a consumer that wants the host's help names the token (`username`, `url`).
   */
  autoComplete?: string
  /**
   * A class of the consumer's on the `<input>`, beside the shared `.zen-v2-field`: the PIN's
   * `tabular-nums` and letter-spacing, a monospace value – the look of the value, never the
   * field's box, which is the chassis's.
   */
  className?: string
}

export type PromptDialogProps = Omit<ConfirmDialogProps, 'checkbox' | 'destructive'> & {
  /** The body's one element: the field, `.zen-v2-field` at the body's full width under the description. */
  field: PromptField
}

/**
 * The one-field prompt (§9.23's composition with §9.12's field): the confirmation primitive
 * above with a text field for its body's one element – "Name window", a rename – and nothing
 * else; a prompt that needs a second field, a menulist or a validation message is a form dialog
 * (`pages/settings`' `SettingsDialog`, the bookmarks' `EditBookmarkDialog`). A thin export
 * composed on the same panel rather than a `field` prop on `ConfirmDialog`: the confirmation's
 * public surface stays what §9.23 names (title, description, at most a check row, two buttons),
 * `destructive` and the check row do not combine with a field (a value asked for has a primary,
 * and a field with a row is a form), and each consumer reads as what it is. The one panel keeps
 * the chassis, the width rule, the keyboard and the return in one place.
 *
 * The width is §9.20's `form` 400 – "takes 400 only when it carries a row or a field" – and the
 * 320 notice again when it opens over another dialog in the slot ("place beats content").
 *
 * The focus lands IN THE FIELD as the prompt opens (selected when `autoSelect`): a prompt
 * carrying a field is a form, and a form focuses its first field – §9.22's container-focus
 * rule, which the confirmation above keeps, is for title-and-notice prompts, whose only
 * controls are the way out. Enter in the field is the verb (the primitive's default key: a text
 * input is not an `OWN_ENTER` control, so the field's Enter submits as a form's does); Tab wraps
 * field → Cancel → verb; Escape and the scrim are Cancel, one hop. The footer is the
 * confirmation's: Cancel | verb at 96 | 8 | 96 (§9.11), the verb the accent primary.
 */
export function PromptDialog(props: PromptDialogProps): JSX.Element {
  return (
    <FrameDialogPortal>
      <ConfirmPanel {...props} />
    </FrameDialogPortal>
  )
}

export type PickerDialogProps = Omit<ConfirmDialogProps, 'checkbox' | 'destructive'> & {
  /**
   * The body's one element: the consumer's list – the rows to choose from, its own markup – in
   * the body's slot (`.zen-confirm-dialog-slot`) under the description, at the prompt's full
   * width: edge to edge, as the check row runs (§9.25: the row's own 16 is the prompt's one
   * gutter, so a row's text stands where the title's does), and scrolling under the title block
   * when the prompt stands at its 80% cap (§9.20). The list's roving focus – arrows, one row
   * tabbable at a time – is the consumer's.
   */
  body: ReactNode
  /** The verb until a pick: `aria-disabled` at §9.30's .4, inert to Enter and to a press. */
  disabled?: boolean
}

/**
 * The picker (§9.23's prompt with a list for its body): the confirmation primitive above with
 * the consumer's list as the body's one element and a verb that waits for a pick – the device
 * chooser's Connect over its WebUSB, HID, serial or Bluetooth rows (services'
 * `DeviceChooserDialog` is built on it; no consumer stands in this file). A thin export composed
 * on the same panel, as `PromptDialog` is: the confirmation's public surface stays what §9.23
 * names, `destructive` and the check row do not combine with a list (a pick has a primary, and
 * a list with a row is a form), and the one panel keeps the chassis, the width rule, the
 * keyboard and the return in one place.
 *
 * It is a `dialog`, not an `alertdialog`: a choice is asked, not a notice confirmed. The width
 * is §9.20's `form` 400 – "takes 400 only when it carries a row or a field", and a list is rows
 * – and the 320 notice again when it opens over another dialog in the slot ("place beats
 * content"); carrying a list it stands at most 80% of the frame's height (`data-body="list"`),
 * the list scrolling under the title block with the footer in reach (§9.20's list rule).
 *
 * The CONTAINER holds the focus as it opens (§9.22): a picker is a choice, not a form – no row
 * is preselected by the keyboard and no verb is – so the first Tab enters the list at the row
 * the consumer made tabbable, Shift+Tab lands on the verb, and between them the keys wrap at
 * the ends; a step within the list is the consumer's roving focus. Enter is the prompt's
 * throughout (§9.22): from the container or from a row – a row is not an `OWN_ENTER` control –
 * it is the verb once a pick has enabled it, as Chrome's chooser connects the highlighted device
 * on Return, and inert while `disabled` (consumed, answering nothing); so a row picks on click,
 * Space or the arrows, never on Enter. Escape and the scrim are Cancel, one hop; the return is
 * the primitive's.
 */
export function PickerDialog(props: PickerDialogProps): JSX.Element {
  return (
    <FrameDialogPortal>
      <ConfirmPanel {...props} />
    </FrameDialogPortal>
  )
}

function ConfirmPanel({
  name,
  title,
  glyph,
  description,
  action,
  destructive = false,
  busy = false,
  disabled = false,
  checkbox,
  field,
  body,
  onCancel,
  onConfirm,
  returnFocus,
  data,
  className
}: ConfirmDialogProps & { field?: PromptField; body?: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const titleId = `${id}title`
  const descriptionId = `${id}description`
  const latest = useRef({ onConfirm, busy, disabled, returnFocus, autoSelect: field?.autoSelect })
  useLayoutEffect(() => {
    latest.current = { onConfirm, busy, disabled, returnFocus, autoSelect: field?.autoSelect }
  })
  useEscape(onCancel)
  useFrameDialog({ onScrimPress: onCancel })

  // The width (§9.20), before the first paint: 400 for a prompt carrying the check row, the
  // field or the list, the 320 notice otherwise – and the notice whatever it carries when it
  // covers another dialog in the slot (a panel on its way out is not one). Read as the prompt
  // mounts; the row's presence is the one prop that can move it.
  const hasBody = body !== undefined
  const hasRow = checkbox !== undefined || field !== undefined || hasBody
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    let below = root.previousElementSibling
    while (below?.hasAttribute('data-leaving')) below = below.previousElementSibling
    root.style.width = `${hasRow && !below ? POPOVER_WIDTH.form : POPOVER_WIDTH.list}px`
  }, [hasRow])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    // The opener: whatever held the focus as the prompt came – a control of the chrome, a row
    // of a page, or a lower dialog's control for a prompt over one – and not `body`.
    const active = document.activeElement
    const opener =
      active instanceof HTMLElement && active !== document.body && !root.contains(active)
        ? active
        : null
    // The container holds the focus (§9.22) – a notice's, and a picker's too: a choice is not a
    // form, so no row and no verb is preselected and the first Tab enters the list – unless the
    // prompt carries a field: a form focuses its first field, selected when asked, so typing
    // replaces the value.
    const input = fieldRef.current
    if (input) {
      input.focus({ preventScroll: true })
      if (latest.current.autoSelect) input.select()
    } else root.focus({ preventScroll: true })
    return () => {
      const wanted = latest.current.returnFocus
      // A getter's element is the target and its `false` is nowhere, as a plain value's; its
      // null – the row it names gone – is the opener, as `undefined` is.
      const named = typeof wanted === 'function' ? wanted() : wanted
      const target = named === false ? null : (named ?? opener)
      if (!target?.isConnected) return
      // Only a focus the prompt's leave loses is given back: one still on the prompt (kept in
      // the slot on its way out), fallen to `body`, or under an `inert`; one the user or a
      // dialog opened over the way out has already placed is left alone.
      const now = document.activeElement
      const lost =
        !now ||
        now === document.body ||
        root.contains(now) ||
        now.closest('[inert], [data-leaving]') !== null
      if (lost) returnFocusTo(target)
    }
  }, [])

  // The verb, from its button or from the container's Enter: nothing while it is at work
  // (`busy`) or not yet an answer (`disabled`) – the key is consumed either way, inert.
  const confirm = (): void => {
    if (latest.current.busy || latest.current.disabled) return
    latest.current.onConfirm()
  }
  // The keyboard (§9.22 as amended): Tab wrapping at the ends; Enter from the held container or
  // its check row as the verb – or, on a destructive prompt, swallowed and answering nothing.
  useConfirmKeyboard(ref, { destructive, confirm })
  return (
    <div
      {...data}
      ref={ref}
      // A confirmation is an alertdialog; a prompt asking for a value or a choice – the field,
      // the list – is a dialog.
      role={field || hasBody ? 'dialog' : 'alertdialog'}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-confirm={name}
      data-destructive={destructive || undefined}
      // A list body takes §9.20's 80% cap and scrolls under the title block (main.css).
      data-body={hasBody ? 'list' : undefined}
      data-surface="page"
      tabIndex={-1}
      className={cn('zen-v2-dialog zen-confirm-dialog zen-animate-pop', className)}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <V2TitleBlock
        id={titleId}
        title={title}
        glyph={glyph}
        description={description}
        descriptionId={descriptionId}
      />
      <div className="zen-confirm-dialog-body">
        {field && (
          <input
            ref={fieldRef}
            type="text"
            className={cn('zen-v2-field', field.className)}
            aria-label={field.label}
            value={field.value}
            onChange={(e) => field.onChange(e.target.value)}
            maxLength={field.maxLength}
            // `text` is the attribute's default: drawn as none, so a words field stays as it was.
            inputMode={field.inputMode === 'text' ? undefined : field.inputMode}
            pattern={field.pattern}
            spellCheck={false}
            autoComplete={field.autoComplete ?? 'off'}
          />
        )}
        {hasBody && <div className="zen-confirm-dialog-slot">{body}</div>}
        {checkbox && (
          <label className="zen-v2-row zen-v2-check-row zen-confirm-dialog-check">
            <span className="zen-v2-row-body">
              <input
                type="checkbox"
                className="zen-v2-checkbox"
                checked={checkbox.checked}
                onChange={(e) => checkbox.onChange(e.target.checked)}
              />
              <span className="zen-v2-row-text">
                <span className="zen-v2-label">{checkbox.label}</span>
              </span>
            </span>
          </label>
        )}
        <div className="zen-confirm-dialog-footer">
          <button type="button" className="zen-v2-button" data-action="cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="zen-v2-button"
            data-action="confirm"
            data-primary={destructive ? undefined : ''}
            data-danger={destructive ? '' : undefined}
            aria-busy={busy || undefined}
            aria-disabled={disabled || undefined}
            onClick={confirm}
          >
            {busy ? (
              <>
                <span className="zen-v2-button-label">{action}</span>
                <span className="zen-v2-spinner" aria-hidden />
              </>
            ) : (
              action
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
