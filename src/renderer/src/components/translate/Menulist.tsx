import type { JSX, KeyboardEvent, RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import {
  menulistClosed,
  menulistOpened,
  placePopover,
  prepareMenulist,
  type LanguageOption
} from '@renderer/lib/translate'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { activeTab } from '@renderer/lib/selectors'
import { browserStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/** The popover's fixed width (§9.20: 320 for a list without trailing controls). */
const WIDTH = 320
/** The popover shows at least this many rows before it flips above the trigger's bar. */
const MIN_ROWS = 5
const ROW = 28
const PAD = 6

/**
 * A menulist on the v2 draft (§9.13): a bordered trigger with a chevron that opens its options
 * as a `--v2-panel` popover under itself on the desktop – 28 px rows, the current one marked with
 * a trailing check – and as a bottom sheet of 44 px rows on phones, the current one carrying a
 * radio glyph; picking an option closes either. Never the platform's own `<select>` popup.
 *
 * The popover is a desktop popover of §9.20: 320 wide whatever its rows hold, its top border on
 * the bottom edge of the bar or row the trigger sits in, start-aligned with the trigger (end-
 * aligned when the trigger is in the trailing half of its bar), 8 px inside the window, at most
 * 60% of the window tall. It takes the keyboard while it is up (§9.22): arrows, Home, End and
 * type-ahead move, Enter picks, Tab stays inside, Escape closes and hands focus back to the
 * trigger.
 *
 * Either list overhangs the content area, where the host draws the page above the chrome, so
 * while it is up the page gives way to its snapshot (as under the sheets), through the ui store.
 */
export function Menulist({
  value,
  options,
  onChange,
  label,
  placeholder,
  disabled,
  className
}: {
  /** The picked value; null shows `placeholder`. */
  value: string | null
  options: LanguageOption[]
  onChange: (value: string) => void
  /** Accessible name, and the title of the phone's sheet (the visible text is the value). */
  label: string
  placeholder?: string
  disabled?: boolean
  className?: string
}): JSX.Element {
  const phone = useViewport().formFactor === 'phone'
  const [open, setOpen] = useState(false)
  const opening = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value) ?? null

  // The page's snapshot stands in for it while the list is up (and comes down with it, also when
  // the menulist unmounts with its list open).
  useEffect(() => {
    if (!open) return
    menulistOpened()
    return () => menulistClosed()
  }, [open])

  const openList = (): void => {
    if (open || opening.current) return
    opening.current = true
    const state = browserStore.get().state
    void prepareMenulist(state ? (activeTab(state)?.id ?? null) : null).then(() => {
      opening.current = false
      setOpen(true)
    })
  }
  const close = (): void => {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }
  const pick = (next: string): void => {
    close()
    if (next !== value) onChange(next)
  }

  return (
    <span className={cn('zen-translate-menulist', className)}>
      <button
        ref={trigger}
        type="button"
        className="zen-v2-menulist"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        data-placeholder={current ? undefined : true}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            openList()
          }
        }}
      >
        <span className="truncate">{current?.label ?? placeholder ?? ''}</span>
        <ChevronDown aria-hidden />
      </button>
      {open &&
        (phone ? (
          <Sheet title={label} value={value} options={options} onPick={pick} onClose={close} />
        ) : (
          <Popover
            anchor={trigger}
            label={label}
            value={value}
            options={options}
            onPick={pick}
            onClose={close}
          />
        ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Desktop and tablet: a popover under the trigger
// ---------------------------------------------------------------------------

/**
 * The bar the trigger sits in, whose bottom edge the popover's top border sits on (§9.20: gap 0
 * to the bar, which is 4 px under a 32 px control in a 40 px bar or row): the translate bar, a
 * settings or panel row, else whatever holds the trigger.
 */
function anchorBar(trigger: HTMLElement): Element {
  return (
    trigger.closest('.zen-translate-bar, .zen-translate-row') ?? trigger.parentElement ?? trigger
  )
}

function Popover({
  anchor,
  label,
  value,
  options,
  onPick,
  onClose
}: {
  anchor: RefObject<HTMLButtonElement | null>
  label: string
  value: string | null
  options: LanguageOption[]
  onPick: (value: string) => void
  onClose: () => void
}): JSX.Element {
  const list = useRef<HTMLUListElement>(null)
  const latest = useRef(onClose)
  useEffect(() => {
    latest.current = onClose
  })
  const [active, setActive] = useState(() => {
    const index = options.findIndex((o) => o.value === value)
    return index >= 0 ? index : 0
  })

  // On the bottom edge of the trigger's bar, aligned with the trigger, inside the window.
  useLayoutEffect(() => {
    const el = anchor.current
    const popup = list.current
    if (!el || !popup) return
    const { left, top, maxHeight } = placePopover(
      el.getBoundingClientRect(),
      anchorBar(el).getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
      {
        width: WIDTH,
        wanted: options.length * ROW + 2 * PAD + 2,
        minHeight: MIN_ROWS * ROW + 2 * PAD
      }
    )
    popup.style.left = `${left}px`
    popup.style.top = `${top}px`
    popup.style.maxHeight = `${maxHeight}px`
    popup.style.visibility = 'visible'
  }, [anchor, options.length])

  // The list takes the keyboard while it is open and shows the current option straight away.
  useEffect(() => {
    list.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  // The window moved under the popover, or the user left it: the popover is stale.
  useEffect(() => {
    const away = (): void => latest.current()
    window.addEventListener('resize', away)
    window.addEventListener('blur', away)
    return () => {
      window.removeEventListener('resize', away)
      window.removeEventListener('blur', away)
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
        setActive((i) => Math.min(options.length - 1, i + 1))
        break
      case 'ArrowUp':
        setActive((i) => Math.max(0, i - 1))
        break
      case 'Home':
        setActive(0)
        break
      case 'End':
        setActive(options.length - 1)
        break
      case 'Enter':
      case ' ': {
        const option = options[active]
        if (option) onPick(option.value)
        break
      }
      case 'Escape':
        onClose()
        break
      case 'Tab':
        // The list is the popover's only stop: Tab wraps onto it (§9.22), Escape leaves.
        break
      default: {
        // Type-ahead on the first letter, from the row after the active one.
        if (e.key.length !== 1 || e.altKey || e.ctrlKey || e.metaKey) return
        const letter = e.key.toLowerCase()
        const from = active + 1
        const next = options.findIndex(
          (o, i) => i >= from && o.label.toLowerCase().startsWith(letter)
        )
        const wrapped =
          next >= 0 ? next : options.findIndex((o) => o.label.toLowerCase().startsWith(letter))
        if (wrapped >= 0) setActive(wrapped)
        else return
      }
    }
    e.preventDefault()
    e.stopPropagation()
  }

  return createPortal(
    <div
      className="zen-translate-menulist-layer"
      onMouseDown={(e) => {
        e.stopPropagation()
        onClose()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <ul
        ref={list}
        role="listbox"
        aria-label={label}
        tabIndex={-1}
        className="zen-translate-menulist-popup zen-animate-pop"
        style={{ visibility: 'hidden' }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {options.map((option, index) => {
          const selected = option.value === value
          return (
            <li
              key={option.value}
              role="option"
              aria-selected={selected}
              data-active={index === active || undefined}
              onPointerMove={() => {
                if (index !== active) setActive(index)
              }}
              onClick={() => onPick(option.value)}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {selected && <Check aria-hidden />}
            </li>
          )
        })}
      </ul>
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------------------
// Phone: a sheet
// ---------------------------------------------------------------------------

function Sheet({
  title,
  value,
  options,
  onPick,
  onClose
}: {
  title: string
  value: string | null
  options: LanguageOption[]
  onPick: (value: string) => void
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const picked = useRef<string | null>(null)

  useBackSurface({
    name: 'menulist',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      sheet.current?.dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  // The current option is in view when the sheet comes up (once the sheet has laid itself out).
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('.zen-translate-menulist-sheet [aria-selected="true"]')
        ?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  return createPortal(
    <BottomSheet
      ref={sheet}
      className="zen-translate-sheet zen-translate-menulist-sheet"
      handleLabel="Resize list"
      onDismissed={() => {
        const next = picked.current
        if (next !== null) onPick(next)
        else onClose()
      }}
      header={
        <div className="zen-translate-sheet-header">
          <span className="truncate">{title}</span>
        </div>
      }
    >
      <ul role="listbox" aria-label={title} className="zen-translate-menulist-rows">
        {options.map((option) => {
          const selected = option.value === value
          return (
            <li key={option.value} role="option" aria-selected={selected}>
              <button
                type="button"
                className="zen-sheet-item"
                onClick={() => {
                  picked.current = option.value
                  sheet.current?.dismiss()
                }}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selected && <span className="zen-translate-radio" aria-hidden />}
              </button>
            </li>
          )
        })}
      </ul>
    </BottomSheet>,
    document.body
  )
}
