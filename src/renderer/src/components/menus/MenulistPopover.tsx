import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { useArrowKeys, usePopover } from '@renderer/hooks/usePopover'
import { placeUnder, popOrigin, type Anchor } from '@renderer/lib/anchor'
import { useBackSurface } from '@renderer/lib/back'
import { openedFromKeyboard } from '@renderer/lib/popover'
import { ChromePortal, popoverStyle, useLightDismiss, type PopoverBox } from '@renderer/lib/portals'
import {
  typeaheadExtend,
  typeaheadKey,
  typeaheadMatch,
  type TypeaheadBuffer
} from '@renderer/lib/typeahead'
import { cn } from '@renderer/lib/utils'

/** One choice of a menulist. */
export interface MenulistOption<T extends string> {
  value: T
  label: string
  /**
   * One line under the label (§9.13: where a voice runs and its quality, a model's size): the
   * popover's row grows to 48 around the two and clamps it to one line; the phone sheet's row
   * is a §9.2 description.
   */
  description?: string
}

/** A row after the options that acts rather than picks ("Choose another folder…"). */
export interface MenulistAction {
  label: string
  onPick: () => void
}

export interface MenulistPopoverProps<T extends string> {
  /** The trigger (`anchorOf`): the list hangs flush under it, or under the bar it sits in (§9.20). */
  anchor: Anchor
  /** The accessible name of the list (the trigger's). */
  label: string
  /** The list's id, for the trigger's `aria-controls`. */
  id?: string
  /** The current option; null (nothing picked yet) checks nothing and the first row takes the cursor. */
  value: T | null
  options: readonly MenulistOption<T>[]
  /** Rows under a hairline after the options, acting rather than picking. */
  actions?: readonly MenulistAction[]
  /** An option was picked; the caller closes the list (and changes its value). */
  onPick: (value: T) => void
  /** The list is done – Escape, the chrome layer's light dismiss – and unmounts. */
  onClose: () => void
  /**
   * The list may overhang the live page's view, which draws over the chrome: it holds the page
   * behind its capture while it is up (`useFloatingChrome`) and paints once the capture is in
   * place. Off for a menulist inside a dialog or an overlay that already holds the page.
   */
  overPage?: boolean
  /** The back-registry name while the list is open (a tablet's back gesture closes it). */
  surface?: string
  /** A modifier on the panel: a surface family's root class, a drawing scope. */
  className?: string
  /** The list's surface for the family of its rows (`data-surface`, lib/portals.tsx). */
  dataSurface?: 'window' | 'page'
}

/**
 * The menulist's popup on a mouse (v2 draft §9.13, §9.20, §9.22), one implementation for every
 * menulist – the Settings tab's and the extensions page's (`V2Menulist`), the translate
 * surfaces', the passwords' and autofill's, the bookmark dialogs' folder field: a `--v2-panel`
 * popover through the chrome layer flush under the trigger (or the bar it sits in) at radius 12
 * with 6 padding, 28 rows at radius 6 (48 around a label and its description) and a trailing 16
 * check on the current option; as wide as the trigger at least and growing to its longest row
 * within §5's 332 (`.zen-v2-menulist-popup`, main.css; the trigger's width rides in
 * `--zen-anchor-width`), as tall as its rows up to the chrome layer's cap, flipped above the
 * trigger when it would cross the bottom margin (`placeUnder`). The current option takes the
 * focus as the list comes up and is scrolled into view; arrows, Home and End move the cursor,
 * letters type ahead (lib/typeahead.ts: a second's buffer, a repeated letter cycling), Enter or
 * Space picks, Tab wraps inside, Escape hands the focus back to the trigger (`usePopover`); the
 * chrome layer's light dismiss closes it otherwise (§9.20 amended) – the trigger's own press
 * included, which does not reopen it. The list is measured as layout size, not the client rect,
 * which the pop animation's first frame scales to .94.
 */
export function MenulistPopover<T extends string>(
  props: MenulistPopoverProps<T>
): JSX.Element | null {
  return props.overPage ? <FloatingList {...props} /> : <List {...props} ready />
}

function FloatingList<T extends string>(props: MenulistPopoverProps<T>): JSX.Element | null {
  // Opened from the keyboard the page did not have focus and does not get it back (§9.22).
  const [fromKeyboard] = useState(openedFromKeyboard)
  const ready = useFloatingChrome({ pageHadFocus: !fromKeyboard })
  return <List {...props} ready={ready} />
}

function List<T extends string>({
  anchor,
  label,
  id,
  value,
  options,
  actions = [],
  onPick,
  onClose,
  surface,
  className,
  dataSurface,
  ready
}: MenulistPopoverProps<T> & { ready: boolean }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<PopoverBox | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !ready) return
    setBox(placeUnder(anchor, { measured: el.offsetWidth }, el.offsetHeight))
  }, [anchor, options.length, actions.length, ready])
  usePopover(ref, {
    onClose,
    active: ready && box !== null,
    initial: (root) => root.querySelector<HTMLElement>('[aria-selected="true"]'),
    returnTo: anchor.element instanceof HTMLElement ? anchor.element : undefined
  })
  useArrowKeys(ref, '.zen-v2-menulist-option')
  useLightDismiss(ref, onClose, { anchor: () => anchor.element ?? null })
  useBackSurface(surface ? { name: surface, onCommit: onClose } : null)
  // The current option is in view when the list comes up.
  useEffect(() => {
    if (box)
      ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [box])

  const typed = useRef<TypeaheadBuffer | null>(null)
  const typeAhead = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const key = typeaheadKey(e)
    const root = ref.current
    if (key === null || !root) return
    const rows = [...root.querySelectorAll<HTMLElement>('.zen-v2-menulist-option')]
    const labels = [...options.map((o) => o.label), ...actions.map((a) => a.label)]
    const current = rows.indexOf(document.activeElement as HTMLElement)
    typed.current = typeaheadExtend(typed.current, key, performance.now())
    const next = typeaheadMatch(labels, typed.current.text, current)
    e.preventDefault()
    if (next !== null) rows[next]?.focus()
  }

  if (!ready) return null
  return (
    <ChromePortal>
      <div
        ref={ref}
        id={id}
        role="listbox"
        aria-label={label}
        className={cn(
          'zen-v2-panel zen-v2-menulist-popup zen-animate-pop fixed select-none',
          className
        )}
        data-surface={dataSurface}
        style={
          {
            ...(box ? popoverStyle(box) : { left: anchor.x, top: anchor.y + anchor.height }),
            '--zen-anchor-width': `${anchor.width}px`,
            visibility: box ? 'visible' : 'hidden',
            transformOrigin: box ? popOrigin(anchor, box) : undefined
          } as CSSProperties
        }
        onKeyDown={typeAhead}
      >
        {options.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected}
              className="zen-v2-menulist-option"
              onClick={() => onPick(option.value)}
            >
              {option.description ? (
                <span className="zen-v2-menulist-option-text">
                  <span className="truncate">{option.label}</span>
                  <span className="zen-v2-menulist-option-description">{option.description}</span>
                </span>
              ) : (
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              )}
              {selected && <Check aria-hidden />}
            </button>
          )
        })}
        {actions.length > 0 && <div className="zen-v2-menu-separator" role="separator" />}
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            role="option"
            aria-selected={false}
            className="zen-v2-menulist-option"
            onClick={action.onPick}
          >
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
          </button>
        ))}
      </div>
    </ChromePortal>
  )
}
