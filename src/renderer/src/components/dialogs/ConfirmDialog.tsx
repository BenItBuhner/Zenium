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
   * beside Cancel. Otherwise the verb is the accent primary.
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
  /** The verb: its button, and Enter from the prompt's container or its check row. */
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
 * form dialog.
 *
 * The keyboard (§9.22): the CONTAINER holds the focus as the prompt opens – its root is
 * `tabIndex -1`, the container the keyboard is sent to and cannot reach by Tab, so the chassis
 * draws no ring on it (`[role='alertdialog'][tabindex='-1']:focus-visible` in main.css) and no
 * verb is preselected. Tab enters at Cancel, Shift+Tab at the verb, and between them the keys
 * wrap at the ends (lib/popover.ts `wrapTab`). Enter from the container, or from the check row,
 * activates the verb as the prompt's default button – as Firefox's and Chrome's dialogs answer
 * Enter from the dialog itself – in the destructive form too (the coordinator's open question:
 * §6 gives a destructive prompt no primary, and this primitive keeps one rule until the design
 * language says otherwise); Enter on a button is that button's own. Escape and a press on the
 * scrim are Cancel.
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
  const latest = useRef({ onConfirm, busy, returnFocus })
  useLayoutEffect(() => {
    latest.current = { onConfirm, busy, returnFocus }
  })
  useEscape(onCancel)
  useFrameDialog({ onScrimPress: onCancel })

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

  const confirm = (): void => {
    if (latest.current.busy) return
    latest.current.onConfirm()
  }
  return (
    <div
      {...data}
      ref={ref}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-confirm={name}
      data-destructive={destructive || undefined}
      data-surface="page"
      tabIndex={-1}
      className={cn('zen-v2-dialog zen-confirm-dialog zen-animate-pop', className)}
      style={{ width: POPOVER_WIDTH.list }}
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
