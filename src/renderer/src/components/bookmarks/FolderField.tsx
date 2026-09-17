import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Folder } from 'lucide-react'
import type { BookmarkTree } from '@shared/bookmarks'
import { recentFolders } from '@shared/bookmarks'
import { cn } from '@renderer/lib/utils'
import { FolderChooser } from './FolderChooser'
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

/**
 * Chrome's folder control of the star bubble and the bookmark dialogs: a select showing the
 * folder's name that lists the recently used folders, and a "Choose another folder…" row
 * that swaps the select for the whole folder tree (with "New folder").
 */
export function FolderField({
  tree,
  value,
  onChange,
  disabled,
  onNestedChange,
  className
}: Props): JSX.Element {
  const [listOpen, setListOpen] = useState(false)
  const [chooser, setChooser] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const current = tree.get(value)
  const options = useMemo(() => {
    const recent = recentFolders(tree, 5).filter((f) => !disabled?.has(f.id))
    return current && !recent.some((f) => f.id === current.id) ? [current, ...recent] : recent
  }, [current, disabled, tree])

  useEffect(() => {
    onNestedChange?.(listOpen || chooser)
  }, [chooser, listOpen, onNestedChange])

  // The list takes the keyboard while open; a click anywhere else puts it away.
  useEffect(() => {
    if (!listOpen) return
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
    const onDown = (e: PointerEvent): void => {
      if (!listRef.current?.parentElement?.contains(e.target as Node | null)) setListOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [listOpen])

  const pick = (id: string): void => {
    setListOpen(false)
    if (id !== value) onChange(id)
  }

  useEscapeTrap(listOpen, () => setListOpen(false))
  useEscapeTrap(chooser, () => setChooser(false))

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
      case 'Escape':
        setListOpen(false)
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
        type="button"
        aria-haspopup="listbox"
        aria-expanded={listOpen}
        className="zen-select"
        onClick={() => setListOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setListOpen(true)
          }
        }}
      >
        <Folder className="h-4 w-4 shrink-0 opacity-60" />
        <span className="min-w-0 flex-1 truncate text-left">{current?.title ?? ''}</span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
      </button>
      {listOpen && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Folder"
          className="zen-panel zen-bm-menu zen-animate-pop absolute inset-x-0 top-[calc(100%+4px)] z-10 w-auto"
          onKeyDown={onListKeyDown}
        >
          {options.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                role="option"
                aria-selected={f.id === value}
                className="zen-bm-menu-row"
                onClick={() => pick(f.id)}
              >
                <Folder className="h-4 w-4 shrink-0 opacity-60" />
                <span className="min-w-0 flex-1 truncate">{f.title}</span>
                {f.id === value && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            </li>
          ))}
          <li className="mt-1">
            <button
              type="button"
              role="option"
              aria-selected={false}
              className="zen-bm-menu-row"
              onClick={() => {
                setListOpen(false)
                setChooser(true)
              }}
            >
              <span className="h-4 w-4 shrink-0" />
              Choose another folder…
            </button>
          </li>
        </ul>
      )}
    </div>
  )
}
