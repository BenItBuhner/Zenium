import type { RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { wrapTab } from '@renderer/lib/popover'

/*
 * The confirmation prompt's keyboard (§9.22 as amended by the design lead on #392), beside the
 * primitive it was written for (`ConfirmDialog.tsx`) rather than in it: one implementation of
 * the contract for the primitive's own root and for any other held container – a popover's
 * level (`siteControls/SiteInfoPopover.tsx`), the phone's confirmation sheet – in a file of its
 * own so the primitive's exports stay its components (react-refresh's rule for a component
 * file) and a host takes the hook without the dialog.
 */

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
 * `enabled` and `tab` re-place it. The one implementation: the primitive holds its root with it
 * (`ConfirmDialog.tsx`), and the phone's `ConfirmSheet` takes it in place of its own copy of the rule.
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
