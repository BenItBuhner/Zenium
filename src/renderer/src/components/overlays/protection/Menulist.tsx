import type { JSX } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import {
  ChromePortal,
  placePopover,
  POPOVER_WIDTH,
  popoverStyle,
  toRect,
  useLightDismiss,
  viewportSize
} from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'

export interface MenulistOption<V extends string> {
  value: V
  label: string
}

/**
 * The desktop menulist (design-language-v2-draft §6, §9.13): a 32 px rectangular control at
 * radius 4 with a hairline and a chevron, opening a `--v2-panel` popover flush under itself at
 * radius 12 with 6 px padding and 28 px rows at radius 6, the current option marked with a
 * trailing check. The popover is §9.20's list width, placed by `placePopover` through the chrome
 * layer (`ChromePortal`), end-aligned when the control sits in the trailing half of its row, and
 * flipped above the control when the rows do not fit below. Arrow keys move, Enter picks, Escape
 * closes and hands focus back; the layer's light dismiss (`useLightDismiss`) closes it on a
 * press outside, a scroll, a resize or another popover opening, the press consumed (§9.20,
 * §9.22). Never a native `<select>`; on a phone the caller shows radios instead.
 */
export function Menulist<V extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false
}: {
  value: V
  options: ReadonlyArray<MenulistOption<V>>
  onChange: (value: V) => void
  /** Accessible name of the control (the row's label). */
  label: string
  disabled?: boolean
}): JSX.Element {
  // The open popover's anchor: the control itself, taken from the press that opened it.
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value) ?? options[0]
  const close = (byKey: boolean): void => {
    setAnchor(null)
    if (byKey) trigger.current?.focus()
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="zen-v2-menulist"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={anchor !== null}
        disabled={disabled}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <span>{current?.label}</span>
        <ChevronDown aria-hidden />
      </button>
      {anchor && (
        <MenulistPopup
          anchor={anchor}
          value={value}
          options={options}
          label={label}
          onPick={(v) => {
            close(true)
            if (v !== value) onChange(v)
          }}
          onClose={close}
        />
      )}
    </>
  )
}

const ROW = 28
const PADDING = 6

function MenulistPopup<V extends string>({
  anchor,
  value,
  options,
  label,
  onPick,
  onClose
}: {
  anchor: HTMLElement
  value: V
  options: ReadonlyArray<MenulistOption<V>>
  label: string
  onPick: (value: V) => void
  onClose: (byKey: boolean) => void
}): JSX.Element {
  // Flush under the control, aligned with it, 8 px inside the window (§9.13, §9.20); the row the
  // control sits in is its bar, so a control on the row's trailing side end-aligns the list, and
  // the list's own height (the rows, the padding, the hairline) decides whether it flips above.
  const rect = toRect(anchor.getBoundingClientRect())
  const bar = toRect((anchor.closest('.zen-privacy-row') ?? anchor).getBoundingClientRect())
  const box = placePopover(
    rect,
    { ...bar, y: rect.y, height: rect.height },
    viewportSize(),
    POPOVER_WIDTH.list,
    options.length * ROW + PADDING * 2 + 2
  )
  const list = useRef<HTMLUListElement>(null)
  const idBase = useId()
  const [active, setActive] = useState(
    Math.max(
      0,
      options.findIndex((o) => o.value === value)
    )
  )
  useEffect(() => {
    list.current?.focus()
  }, [])
  // The layer's light dismiss closes it, the control taking the focus back – unless another
  // popover or a dialog opening closed it, which has the focus now.
  useLightDismiss(list, (reason) => onClose(reason !== 'replaced' && reason !== 'all'), {
    anchor: () => anchor
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose(true)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => {
          const n = options.length
          return (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
        })
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        setActive(e.key === 'Home' ? 0 : options.length - 1)
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        const option = options[active]
        if (option) onPick(option.value)
      } else if (e.key === 'Tab') {
        onClose(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, options, onPick, onClose])

  return (
    <ChromePortal>
      <ul
        ref={list}
        role="listbox"
        aria-label={label}
        aria-activedescendant={`${idBase}-${active}`}
        tabIndex={-1}
        className="zen-protection-menulist-popup zen-animate-pop"
        style={popoverStyle(box)}
      >
        {options.map((option, i) => (
          <li
            key={option.value}
            id={`${idBase}-${i}`}
            role="option"
            aria-selected={option.value === value}
            className={cn('zen-protection-menulist-option', i === active && 'is-active')}
            onPointerMove={() => i !== active && setActive(i)}
            onClick={() => onPick(option.value)}
          >
            <span>{option.label}</span>
            {option.value === value && <Check aria-hidden />}
          </li>
        ))}
      </ul>
    </ChromePortal>
  )
}
