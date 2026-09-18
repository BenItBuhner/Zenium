import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Folder } from 'lucide-react'
import type { BookmarkTree } from '@shared/bookmarks'
import { recentFolders } from '@shared/bookmarks'
import { cn } from '@renderer/lib/utils'
import { FolderChooser } from './FolderChooser'
import { POPOVER_MARGIN } from './popover'
import { useEscapeTrap } from './escape'

interface Props {
  tree: BookmarkTree
  /** The chosen folder. */
  value: string
  onChange: (folderId: string) => void
  /** Folders that cannot be chosen (a folder being moved, and everything below it). */
  disabled?: Set<string>
  /** Whether a nested level (the list or the tree) is showing; Escape closes it before the dialog. */
  onNestedChange?: (open: boolean) => void
  className?: string
}

/** The popup's height before it is on screen: 6px padding, 28px rows, the separator's 9. */
const OPTION_HEIGHT = 28
const POPUP_PADDING = 6
const SEPARATOR_HEIGHT = 9

interface PopupBox {
  left: number
  width: number
  top?: number
  bottom?: number
}

/**
 * Chrome's folder control of the star bubble and the bookmark dialogs: a menulist showing the
 * folder's name whose popup (v2 draft §9.13: a panel under the trigger, 28px rows, the current
 * option checked) lists the recently used folders and a "Choose another folder…" row that swaps
 * the menulist for the whole folder tree (with "New folder"). The popup is portalled so the
 * dialog's scrolling body cannot clip it.
 */
export function FolderField({
  tree,
  value,
  onChange,
  disabled,
  onNestedChange,
  className
}: Props): JSX.Element {
  const [popup, setPopup] = useState<PopupBox | null>(null)
  const [chooser, setChooser] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // The tree closed (Escape, a pick): the menulist that takes its place gets the focus back.
  const refocus = useRef(false)
  const listOpen = popup !== null
  const current = tree.get(value)
  const options = useMemo(() => {
    const recent = recentFolders(tree, 5).filter((f) => !disabled?.has(f.id))
    return current && !recent.some((f) => f.id === current.id) ? [current, ...recent] : recent
  }, [current, disabled, tree])

  useEffect(() => {
    onNestedChange?.(listOpen || chooser)
  }, [chooser, listOpen, onNestedChange])

  useEffect(() => {
    if (chooser || !refocus.current) return
    refocus.current = false
    triggerRef.current?.focus()
  }, [chooser])

  const openList = (): void => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    const height = POPUP_PADDING * 2 + (options.length + 1) * OPTION_HEIGHT + SEPARATOR_HEIGHT
    const below = r.bottom + height <= window.innerHeight - POPOVER_MARGIN
    setPopup(
      below
        ? { left: r.left, top: r.bottom, width: r.width }
        : { left: r.left, bottom: window.innerHeight - r.top, width: r.width }
    )
  }
  const closeList = (focusTrigger: boolean): void => {
    setPopup(null)
    if (focusTrigger) triggerRef.current?.focus()
  }

  // The list takes the keyboard while open; a click anywhere else puts it away.
  useEffect(() => {
    if (!listOpen) return
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null
      if (!listRef.current?.contains(t) && !triggerRef.current?.contains(t)) setPopup(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [listOpen])

  const pick = (id: string): void => {
    closeList(true)
    if (id !== value) onChange(id)
  }

  useEscapeTrap(listOpen, () => closeList(true))
  useEscapeTrap(chooser, () => {
    refocus.current = true
    setChooser(false)
  })

  const onListKeyDown = (e: React.KeyboardEvent): void => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    const at = rows.indexOf(document.activeElement as HTMLElement)
    switch (e.key) {
      case 'ArrowDown':
        rows[(at + 1) % rows.length]?.focus()
        break
      case 'ArrowUp':
        rows[(at - 1 + rows.length) % rows.length]?.focus()
        break
      case 'Home':
        rows[0]?.focus()
        break
      case 'End':
        rows[rows.length - 1]?.focus()
        break
      case 'Tab':
      case 'Escape':
        closeList(true)
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  if (chooser) {
    return (
      <FolderChooser
        tree={tree}
        selectedId={value}
        onSelect={onChange}
        disabled={disabled}
        allowCreate
        className={cn('-mx-1 max-h-[260px]', className)}
      />
    )
  }

  return (
    <div className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={listOpen}
        className="zen-select"
        onClick={() => (listOpen ? closeList(false) : openList())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!listOpen) openList()
          }
        }}
      >
        <Folder className="h-4 w-4 shrink-0 opacity-60" />
        <span className="min-w-0 flex-1 truncate text-left">{current?.title ?? ''}</span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
      </button>
      {popup &&
        createPortal(
          <ul
            ref={listRef}
            role="listbox"
            aria-label="Folder"
            data-bm-listbox
            className="zen-bm-listbox zen-animate-pop fixed z-[90]"
            style={popup}
            onKeyDown={onListKeyDown}
          >
            {options.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={f.id === value}
                  className="zen-bm-option"
                  onClick={() => pick(f.id)}
                >
                  <Folder className="h-4 w-4 shrink-0 opacity-60" />
                  <span className="min-w-0 flex-1 truncate">{f.title}</span>
                  {f.id === value && <Check className="h-4 w-4 shrink-0" />}
                </button>
              </li>
            ))}
            <li>
              <div className="zen-bm-menu-sep" />
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="zen-bm-option"
                onClick={() => {
                  setPopup(null)
                  setChooser(true)
                }}
              >
                <span className="h-4 w-4 shrink-0" />
                Choose another folder…
              </button>
            </li>
          </ul>,
          document.body
        )}
    </div>
  )
}
