import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { BookmarkTree } from '@shared/bookmarks'
import { recentFolders } from '@shared/bookmarks'
import { useArrowKeys, usePopover } from '@renderer/hooks/usePopover'
import { anchorOf, placeUnder, popOrigin, type Anchor } from '@renderer/lib/anchor'
import {
  ChromePortal,
  popoverStyle,
  useLightDismiss,
  type DismissReason,
  type PopoverBox
} from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
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
 * menulist popup: a `--v2-panel` under the trigger at radius 12 with 6 padding, 28 rows at
 * radius 6, the current option checked – lists the recently used folders and, under a hairline,
 * a "Choose another folder…" row that swaps the menulist for the whole folder tree as rows
 * (`FolderChooser`, §9.21) with "New folder". The popup renders through the chrome layer
 * (`ChromePortal`), hung by `placeUnder` at its own width (no less than the trigger's), so the
 * dialog's scrolling body cannot clip it; the keyboard is the chassis' (`usePopover`,
 * `useArrowKeys`: the current option takes focus, the arrows move it, Escape gives it back to
 * the menulist, §9.22); and the layer's light dismiss puts it away – a press anywhere else, the
 * trigger's own press, a scroll, a resize – with the focus back on the menulist. Inside the star
 * bubble it is the bubble's child popover (its trigger is in the bubble), so a press in the list
 * leaves the bubble open.
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
  const closeList = (focusTrigger: boolean): void => {
    setAnchor(null)
    if (focusTrigger) triggerRef.current?.focus()
  }

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
        onClick={() => (listOpen ? closeList(false) : openList())}
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
        <FolderList
          anchor={anchor}
          value={value}
          options={options}
          onPick={(folderId) => {
            closeList(true)
            if (folderId !== value) onChange(folderId)
          }}
          onChoose={() => {
            setAnchor(null)
            setChooser(true)
          }}
          onClose={closeList}
        />
      )}
    </>
  )
}

/** The menulist's popup: the recent folders as options, then "Choose another folder…". */
function FolderList({
  anchor,
  value,
  options,
  onPick,
  onChoose,
  onClose
}: {
  anchor: Anchor
  value: string
  options: ReadonlyArray<{ id: string; title: string }>
  onPick: (folderId: string) => void
  onChoose: () => void
  /** `focusTrigger`: the keyboard closed it (Escape), so the menulist takes the focus back. */
  onClose: (focusTrigger: boolean) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<PopoverBox | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // The list keeps its intrinsic width (no less than the control's) and is as tall as its
    // options, measured as layout size, not the client rect, which the pop animation's first
    // frame scales to .94.
    setBox(placeUnder(anchor, { measured: el.offsetWidth }, el.offsetHeight))
  }, [anchor, options.length])
  usePopover(ref, {
    onClose: () => onClose(true),
    active: box !== null,
    initial: (root) => root.querySelector<HTMLElement>('[aria-selected="true"]'),
    // The menulist takes the focus back itself, when it is still there to take it.
    returnTo: null
  })
  useArrowKeys(ref, '.zen-v2-menulist-option')
  // Another popover or a dialog opening has the focus now; any other dismiss hands it back.
  useLightDismiss(
    ref,
    (reason: DismissReason) => onClose(reason !== 'replaced' && reason !== 'all'),
    { anchor: () => anchor.element ?? null }
  )
  return (
    <ChromePortal>
      <div
        ref={ref}
        role="listbox"
        aria-label="Folder"
        data-bm-listbox
        className="zen-v2 zen-v2-panel zen-v2-menulist-popup zen-animate-pop fixed z-[90] select-none"
        style={{
          ...(box ? popoverStyle(box) : { left: anchor.x, top: anchor.y + anchor.height }),
          minWidth: anchor.width,
          visibility: box ? 'visible' : 'hidden',
          transformOrigin: box ? popOrigin(anchor, box) : undefined
        }}
      >
        {options.map((f) => {
          const selected = f.id === value
          return (
            <button
              key={f.id}
              type="button"
              role="option"
              aria-selected={selected}
              className="zen-v2-menulist-option"
              onClick={() => onPick(f.id)}
            >
              <span className="min-w-0 flex-1 truncate">{f.title}</span>
              {selected && <Check />}
            </button>
          )
        })}
        <div className="zen-v2-menu-separator" role="separator" />
        <button
          type="button"
          role="option"
          aria-selected={false}
          className="zen-v2-menulist-option"
          onClick={onChoose}
        >
          <span className="min-w-0 flex-1 truncate">Choose another folder…</span>
        </button>
      </div>
    </ChromePortal>
  )
}
