import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { BookmarkTree } from '@shared/bookmarks'
import { recentFolders } from '@shared/bookmarks'
import { anchorOf, type Anchor } from '@renderer/lib/anchor'
import { cn } from '@renderer/lib/utils'
import { MenulistPopover } from '../menus/MenulistPopover'
import { FolderChooser } from './FolderChooser'

interface Props {
  tree: BookmarkTree
  /** The chosen folder. */
  value: string
  onChange: (folderId: string) => void
  /** The control's id, for the form field's `<label for>` (§9.12). */
  id?: string
  /** Folders that cannot be chosen (a folder being moved, and everything below it). */
  disabled?: Set<string>
  /** Whether a nested level (the list or the tree) is showing; Escape closes it before the dialog. */
  onNestedChange?: (open: boolean) => void
  className?: string
}

/**
 * Chrome's folder control of the star bubble and the bookmark dialogs: the shared menulist
 * (`.zen-v2-menulist`, v2 draft §9.13) showing the folder's name, whose popup – the shared
 * `MenulistPopover` (components/menus): a `--v2-panel` under the trigger at radius 12 with 6
 * padding, 28 rows at radius 6, the current option checked – lists the recently used folders
 * and, under a hairline, a "Choose another folder…" row that swaps the menulist for the whole
 * folder tree as rows (`FolderChooser`, §9.21) with "New folder". The popup renders through the
 * chrome layer, hung under the trigger at its own width (no less than the trigger's), so the
 * dialog's scrolling body cannot clip it; the keyboard is the chassis' (the current option takes
 * focus, the arrows move it, letters type ahead, Escape gives it back to the menulist, §9.22);
 * and the layer's light dismiss puts it away – a press anywhere else, the trigger's own press, a
 * scroll, a resize. Inside the star bubble it is the bubble's child popover (its trigger is in
 * the bubble), so a press in the list leaves the bubble open.
 */
export function FolderField({
  tree,
  value,
  onChange,
  id,
  disabled,
  onNestedChange,
  className
}: Props): JSX.Element {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [chooser, setChooser] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // The tree closed (Escape, a pick): the menulist that takes its place gets the focus back.
  const refocus = useRef(false)
  const listOpen = anchor !== null
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
    if (triggerRef.current) setAnchor(anchorOf(triggerRef.current))
  }
  const closeList = (): void => setAnchor(null)

  if (chooser) {
    return (
      <FolderChooser
        tree={tree}
        selectedId={value}
        onSelect={onChange}
        disabled={disabled}
        allowCreate
        onEscape={() => {
          refocus.current = true
          setChooser(false)
        }}
        className={className}
      />
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={listOpen || undefined}
        className={cn('zen-v2-menulist', className)}
        onClick={() => (listOpen ? closeList() : openList())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!listOpen) openList()
          }
        }}
      >
        <span className="min-w-0 flex-1 truncate">{current?.title ?? ''}</span>
        <ChevronDown />
      </button>
      {anchor && (
        <MenulistPopover
          anchor={anchor}
          label="Folder"
          value={value}
          options={options.map((f) => ({ value: f.id, label: f.title }))}
          actions={[
            {
              label: 'Choose another folder…',
              onPick: () => {
                setAnchor(null)
                setChooser(true)
              }
            }
          ]}
          onPick={(folderId) => {
            closeList()
            if (folderId !== value) onChange(folderId)
          }}
          onClose={closeList}
        />
      )}
    </>
  )
}
