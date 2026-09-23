import type { JSX, ReactNode } from 'react'
import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { useEscape } from '@renderer/hooks/useEscape'
import { returnFocusTo, wrapTab } from '@renderer/lib/popover'
import { FrameDialogPortal, POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
import { V2TitleBlock } from '../extensions/v2'

/**
 * Where the keyboard goes as a prompt leaves (§9.5, §9.22): the control that had it as the
 * prompt opened (the default, `undefined`), an element or a function read at the leave (a
 * consumer that decides by the answer – a keyboard's Cancel to the row it came from, a Delete
 * whose row goes with it to nothing), or `false` for no return of the prompt's own (a consumer
 * that hands the keyboard to the page itself).
 */
export type ConfirmReturnFocus = HTMLElement | (() => HTMLElement | null | undefined) | false

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
  /**
   * The root's role: `alertdialog` for a question (the default), `dialog` for a picker or a form
   * on the same chassis – the device chooser's list (§9.13), the pairing prompt's PIN field –
   * which asks for a choice rather than announcing one.
   */
  role?: 'alertdialog' | 'dialog'
  /**
   * The body's content between the title block and the footer where the prompt carries more
   * than the check row: a picker's list, a form's field (§9.13, §9.12). A prompt with a body
   * takes §9.20's 400 as one with the check row does – and the 320 notice, body or not, when it
   * stands over another dialog in the slot.
   */
  body?: ReactNode
  /**
   * The verb is not yet available (§9.30's .4): a picker with no pick, a PIN field short of its
   * digits. The button is `disabled`, and Enter from the container or a field confirms nothing.
   */
  confirmDisabled?: boolean
  /**
   * Another dialog stands over this one in the slot (§9.24, depth two): the prompt is `inert` –
   * receded, no target for the pointer or the keyboard – until the upper one leaves. Its owner
   * sets this while it renders the upper dialog after it in the same portal.
   */
  under?: boolean
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
 * form dialog. The width is §9.20's, by content and by place: the 320 notice for a title block
 * and its two buttons; 400 when the prompt carries the check row ("takes 400 only when it
 * carries a row or a field (a credential row, a checkbox)" – at 320 the quit prompt's two
 * sentences ran to three lines and its checkbox label wrapped, measured); and the notice again,
 * row or not, when it opens over another dialog in the slot ("a 400 prompt over a 400 dialog is
 * the unreadable stack of §9"; §9.5: "never the 400 of the dialog it covers"). The place is read
 * once, as the prompt mounts, before its first paint.
 *
 * The keyboard (§9.22 as amended by the design lead on #392): the CONTAINER holds the focus as
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
 *
 * The same chassis carries the pickers and one-field forms that are not questions (`role:
 * 'dialog'`, a `body`): the device chooser's list and the Bluetooth pairing prompt's PIN field
 * (`components/devices`). They keep every rule above – the container focus, Tab's wrap, Enter as
 * the verb where the verb is the primary, Escape and the scrim as Cancel, the width by content
 * and by place – and add only what a choice needs: a verb that waits (`confirmDisabled`) until
 * there is one, and an `under` state for the lower of two (§9.24).
 */
export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
  return (
    <FrameDialogPortal>
      <ConfirmPanel {...props} />
    </FrameDialogPortal>
  )
}

/** The control an Enter belongs to rather than to the prompt: a button answers its own Enter. */
const OWN_ENTER = 'button, a[href], [role="button"], select, textarea'

function ConfirmPanel({
  name,
  title,
  glyph,
  description,
  action,
  destructive = false,
  busy = false,
  checkbox,
  role = 'alertdialog',
  body,
  confirmDisabled = false,
  under = false,
  onCancel,
  onConfirm,
  returnFocus,
  data,
  className
}: ConfirmDialogProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  const titleId = `${id}title`
  const descriptionId = `${id}description`
  const latest = useRef({ onConfirm, busy, confirmDisabled, returnFocus })
  useLayoutEffect(() => {
    latest.current = { onConfirm, busy, confirmDisabled, returnFocus }
  })
  // A prompt under another (§9.24) is not the one Escape or the scrim answer: the upper dialog
  // registered after it and the host's stack asks the top entry; its own key handler is off
  // with the rest of it through `inert`.
  useEscape(onCancel)
  useFrameDialog({ onScrimPress: onCancel })

  // The width (§9.20), before the first paint: 400 for a prompt carrying the check row or a
  // body, the 320 notice otherwise – and the notice whatever it carries when it covers another
  // dialog in the slot (a panel on its way out is not one). Read as the prompt mounts; the
  // row's or body's presence is the one prop that can move it.
  const hasRow = checkbox !== undefined || body !== undefined
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
    root.focus({ preventScroll: true })
    return () => {
      const wanted = latest.current.returnFocus
      const target =
        wanted === false
          ? null
          : wanted === undefined
            ? opener
            : typeof wanted === 'function'
              ? wanted()
              : wanted
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

  // The lower of two (§9.24) as the upper leaves: the upper's one-hop return lands on the control
  // of this prompt it came from once the `inert` lifts (`returnFocusTo`); where the focus fell
  // to `body` instead (a control blurred as its subtree went inert), the container takes the
  // keyboard back, as it held it at the open.
  const wasUnder = useRef(under)
  useEffect(() => {
    const before = wasUnder.current
    wasUnder.current = under
    if (!before || under) return
    const root = ref.current
    if (!root) return
    const now = document.activeElement
    if (!now || now === document.body) root.focus({ preventScroll: true })
  }, [under])

  const confirm = (): void => {
    if (latest.current.busy || latest.current.confirmDisabled) return
    latest.current.onConfirm()
  }
  return (
    <div
      {...data}
      ref={ref}
      role={role}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-confirm={name}
      data-destructive={destructive || undefined}
      data-surface="page"
      tabIndex={-1}
      inert={under || undefined}
      className={cn('zen-v2-dialog zen-confirm-dialog zen-animate-pop', className)}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const root = ref.current
        if (!root) return
        if (e.key === 'Tab') {
          wrapTab(root, e.nativeEvent)
          return
        }
        if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
        if (e.repeat || e.nativeEvent.isComposing) return
        if (e.target instanceof Element && e.target.closest(OWN_ENTER)) return
        e.preventDefault()
        e.stopPropagation()
        // No default on a destructive prompt (§9.22 as amended): the key is the prompt's to
        // swallow – it reaches nothing beneath – and confirms nothing.
        if (destructive) return
        confirm()
      }}
    >
      <V2TitleBlock
        id={titleId}
        title={title}
        glyph={glyph}
        description={description}
        descriptionId={descriptionId}
      />
      <div className="zen-confirm-dialog-body">
        {body}
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
            disabled={confirmDisabled || undefined}
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
