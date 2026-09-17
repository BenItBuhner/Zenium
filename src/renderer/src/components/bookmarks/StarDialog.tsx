import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Folder, Star } from 'lucide-react'
import type { UIState } from '@shared/types'
import { recentFolders } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { FolderChooser } from './FolderChooser'
import { useBookmarkTree } from './tree'

export interface StarTarget {
  tabId: string
  nodeId: string
  created: boolean
}

/**
 * Chrome's star bubble: the page was bookmarked the moment the star was pressed; this names and
 * files it. "Remove" takes the bookmark back, "Done" (or Escape, or a click outside) keeps it.
 */
export function StarDialog({
  state,
  star
}: {
  state: UIState
  star: StarTarget
}): JSX.Element | null {
  const tree = useBookmarkTree(state)
  const node = tree.get(star.nodeId)
  const phone = useViewport().formFactor === 'phone'
  const [name, setName] = useState(node?.title ?? '')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [chooser, setChooser] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const recent = useMemo(() => recentFolders(tree, 5), [tree])

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  // Removed elsewhere (another window, sync) while open: nothing left to edit.
  useEffect(() => {
    if (!node) uiStore.set({ starDialog: null })
  }, [node])
  if (!node) return null

  const close = (): void => {
    const title = name.trim()
    if (title && title !== node.title) run('bookmark.update', { id: node.id, title })
    uiStore.set({ starDialog: null })
  }
  const remove = (): void => {
    run('bookmark.remove', { ids: [node.id] })
    uiStore.set({ starDialog: null })
  }
  const moveTo = (folderId: string): void => {
    if (folderId !== node.parentId) run('bookmark.move', { ids: [node.id], parentId: folderId })
    setPickerOpen(false)
  }

  const parent = node.parentId ? tree.get(node.parentId) : null
  const folderOptions =
    parent && !recent.some((f) => f.id === parent.id) ? [parent, ...recent] : recent

  return (
    <div
      className={cn(
        'absolute inset-0 z-50 flex bg-black/25',
        phone ? 'items-end' : 'items-start justify-end'
      )}
      onMouseDown={close}
    >
      <div
        role="dialog"
        aria-label={star.created ? 'Bookmark added' : 'Edit bookmark'}
        className={cn(
          'zen-panel zen-animate-pop flex max-h-[calc(100%-24px)] flex-col p-4',
          phone
            ? 'mx-2 mb-[calc(8px+var(--zen-inset-bottom,0px))] w-auto flex-1'
            : 'mr-4 mt-14 w-[360px] max-w-[calc(100%-32px)]'
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            if (chooser || pickerOpen) {
              setChooser(false)
              setPickerOpen(false)
            } else close()
          }
        }}
      >
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--zen-accent)]/15 text-[var(--zen-accent)]">
            <Star className="h-4 w-4" fill="currentColor" />
          </span>
          <h2 className="text-[14px] font-semibold">
            {star.created ? 'Bookmark added' : 'Edit bookmark'}
          </h2>
        </div>

        <form
          className="mt-4 flex min-h-0 flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            close()
          }}
        >
          <label className="flex flex-col gap-1.5 text-[12px] text-[var(--zen-muted)]">
            Name
            <Input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              className="text-[var(--zen-fg)]"
            />
          </label>

          <div className="flex flex-col gap-1.5 text-[12px] text-[var(--zen-muted)]">
            Folder
            {chooser ? (
              <FolderChooser
                tree={tree}
                selectedId={node.parentId ?? ''}
                onSelect={moveTo}
                allowCreate
                className="max-h-[260px] rounded-xl bg-[var(--zen-element-bg)] p-1 text-[var(--zen-fg)]"
              />
            ) : (
              <div className="relative">
                <button
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={pickerOpen}
                  className="flex h-8 w-full items-center gap-2 rounded-lg border border-[var(--zen-border)] bg-[var(--zen-element-bg)] px-2.5 text-[13px] text-[var(--zen-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--zen-accent)]/30"
                  onClick={() => setPickerOpen((v) => !v)}
                >
                  <Folder className="h-4 w-4 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate text-left">{parent?.title ?? ''}</span>
                  <ChevronDown className="h-4 w-4 opacity-60" />
                </button>
                {pickerOpen && (
                  <ul
                    role="listbox"
                    className="zen-panel zen-animate-pop absolute inset-x-0 top-[calc(100%+4px)] z-10 p-1 text-[13px] text-[var(--zen-fg)]"
                  >
                    {folderOptions.map((f) => (
                      <li key={f.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={f.id === node.parentId}
                          className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-[var(--zen-element-bg-hover)]"
                          onClick={() => moveTo(f.id)}
                        >
                          <Folder className="h-4 w-4 shrink-0 opacity-70" />
                          <span className="min-w-0 flex-1 truncate">{f.title}</span>
                          {f.id === node.parentId && <Check className="h-3.5 w-3.5" />}
                        </button>
                      </li>
                    ))}
                    <li className="mt-1 pt-1">
                      <button
                        type="button"
                        className="flex h-8 w-full items-center rounded-lg px-2 text-left hover:bg-[var(--zen-element-bg-hover)]"
                        onClick={() => {
                          setPickerOpen(false)
                          setChooser(true)
                        }}
                      >
                        Choose another folder…
                      </button>
                    </li>
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="mt-1 flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" className="mr-auto" onClick={remove}>
              Remove
            </Button>
            <Button type="submit" size="sm">
              Done
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
