/* eslint-disable react-refresh/only-export-components -- the prompt primitive ships with its keyboard (`useConfirmKeyboard`, `OWN_ENTER`): one implementation of §9.22's contract, for the primitive's own root and for any other held container – a popover's level, the phone's confirmation sheet */
import type { JSX, ReactNode, RefObject } from 'react'
import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { useEscape } from '@renderer/hooks/useEscape'
import { returnFocusTo, wrapTab } from '@renderer/lib/popover'
import { FrameDialogPortal, POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
import { V2TitleBlock } from '../extensions/v2'

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
 * form dialog (the one-field prompt is `PromptDialog` below, on the same panel). The width is
 * §9.20's, by content and by place: the 320 notice for a title block
 * and its two buttons; 400 when the prompt carries the check row ("takes 400 only when it
 * carries a row or a field (a credential row, a checkbox)" – at 320 the quit prompt's two
 * sentences ran to three lines and its checkbox label wrapped, measured); and the notice again,
 * row or not, when it opens over another dialog in the slot ("a 400 prompt over a 400 dialog is
 * the unreadable stack of §9"; §9.5: "never the 400 of the dialog it covers"). The place is read
 * once, as the prompt mounts, before its first paint.
 *
 * The keyboard (§9.22 as amended by the design lead on #392; `useConfirmKeyboard` below, the
 * one implementation of it, exported for any held container): the CONTAINER holds the focus as
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

/** A prompt's one field (§9.12): its name, its value, and whether the value is selected on open. */
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

/**
 * The control an Enter belongs to rather than to the prompt: a button answers its own Enter. A
 * text input is not one – a field's Enter is the prompt's default, as a form's Enter submits it.
 */
export const OWN_ENTER = 'button, a[href], [role="button"], select, textarea'

/** What `useConfirmKeyboard` holds a container to. */
export interface ConfirmKeyboard {
  /**
   * A destructive prompt has no default (§9.22 as amended on #392): Enter from the container is
   * consumed – nothing beneath answers it – and confirms nothing.
   */
  destructive: boolean
  /** The verb: what Enter from the container activates on a prompt that is not `destructive`. */
  confirm: () => void
  /**
   * Listening at all; `false` leaves every key alone – a container that stands under another
   * surface (a sheet under a sheet), or one that has no default action. Default `true`.
   */
  enabled?: boolean
  /**
   * Wrap Tab at the container's ends (lib/popover.ts `wrapTab`); `false` where a chassis wraps
   * it already (a popover's window-level wrap, the phone's `BottomSheet`). Default `true`.
   */
  tab?: boolean
  /**
   * The held container, when `ref` is not it: found up from the ref's element as the listener
   * is placed (a sheet's body to the chassis's dialog root: `(body) => body.closest('[role="dialog"]')`).
   * Default: the ref's element itself.
   */
  container?: (el: HTMLElement) => HTMLElement | null
}

/**
 * The confirmation prompt's keyboard (§9.22 as amended by the design lead on #392) on any held
 * container – the primitive's own, a level of a popover, a phone sheet's dialog root – with no
 * assumption about what the container is: a native `keydown` listener on the element the ref
 * (or `container`) names, so a focus held on the container itself, above where a body's markup
 * begins, is heard too. Tab wraps at the container's ends (`wrapTab`), unless the chassis does.
 * An Enter with no modifier, not a held key's repeat and not one composing text, from anything
 * but a control that answers its own Enter (`OWN_ENTER`) is the prompt's: consumed – prevented
 * and stopped, so nothing beneath answers it – and, on a prompt whose verb is the primary, the
 * verb (`confirm`). A DESTRUCTIVE prompt has no default: §6 draws it with no primary because
 * the app recommends neither answer, and a default key is a recommendation as much as a fill,
 * so the key is swallowed and confirms nothing; a focused button still answers its own Enter
 * and Space as any button does. Escape is not here: it is the surface's (`useEscape`, one hop).
 *
 * `destructive`, `confirm` and `container` are read at the key, never re-binding the listener;
 * `enabled` and `tab` re-place it. The one implementation: the primitive below holds its root
 * with it, and the phone's `ConfirmSheet` takes it in place of its own copy of the rule.
 */
export function useConfirmKeyboard(
  ref: RefObject<HTMLElement | null>,
  keyboard: ConfirmKeyboard
): void {
  const latest = useRef(keyboard)
  useLayoutEffect(() => {
    latest.current = keyboard
  })
  const { enabled = true, tab = true } = keyboard
  useEffect(() => {
    if (!enabled) return
    const el = ref.current
    const root = el && (latest.current.container ? latest.current.container(el) : el)
    if (!root) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Tab') {
        if (tab) wrapTab(root, e)
        return
      }
      if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.repeat || e.isComposing) return
      if (e.target instanceof Element && e.target.closest(OWN_ENTER)) return
      e.preventDefault()
      e.stopPropagation()
      const { destructive, confirm } = latest.current
      if (destructive) return
      confirm()
    }
    root.addEventListener('keydown', onKey)
    return () => root.removeEventListener('keydown', onKey)
  }, [ref, enabled, tab])
}

function ConfirmPanel({
  name,
  title,
  glyph,
  description,
  action,
  destructive = false,
  busy = false,
  checkbox,
  field,
  onCancel,
  onConfirm,
  returnFocus,
  data,
  className
}: ConfirmDialogProps & { field?: PromptField }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const titleId = `${id}title`
  const descriptionId = `${id}description`
  const latest = useRef({ onConfirm, busy, returnFocus, autoSelect: field?.autoSelect })
  useLayoutEffect(() => {
    latest.current = { onConfirm, busy, returnFocus, autoSelect: field?.autoSelect }
  })
  useEscape(onCancel)
  useFrameDialog({ onScrimPress: onCancel })

  // The width (§9.20), before the first paint: 400 for a prompt carrying the check row or the
  // field, the 320 notice otherwise – and the notice whatever it carries when it covers another
  // dialog in the slot (a panel on its way out is not one). Read as the prompt mounts; the row's
  // presence is the one prop that can move it.
  const hasRow = checkbox !== undefined || field !== undefined
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
    // The container holds the focus (§9.22) – unless the prompt carries a field: a form
    // focuses its first field, selected when asked, so typing replaces the value.
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

  const confirm = (): void => {
    if (latest.current.busy) return
    latest.current.onConfirm()
  }
  // The keyboard (§9.22 as amended): Tab wrapping at the ends; Enter from the held container or
  // its check row as the verb – or, on a destructive prompt, swallowed and answering nothing.
  useConfirmKeyboard(ref, { destructive, confirm })
  return (
    <div
      {...data}
      ref={ref}
      // A confirmation is an alertdialog; a prompt asking for a value is a dialog with a form.
      role={field ? 'dialog' : 'alertdialog'}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-confirm={name}
      data-destructive={destructive || undefined}
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
            className="zen-v2-field"
            aria-label={field.label}
            value={field.value}
            onChange={(e) => field.onChange(e.target.value)}
            maxLength={field.maxLength}
            spellCheck={false}
            autoComplete="off"
          />
        )}
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
