import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import { inputToUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useBookmarkTree } from './tree'

/** Chrome's "Edit bookmark" / "Add bookmark" dialog: name and URL. */
export function EditBookmarkDialog({
  state,
  id,
  parentId
}: {
  state: UIState
  id: string | null
  parentId: string
}): JSX.Element | null {
  const tree = useBookmarkTree(state)
  const node = id ? tree.get(id) : null
  const phone = useViewport().formFactor === 'phone'
  const [name, setName] = useState(node?.title ?? '')
  const [url, setUrl] = useState(node?.url ?? '')
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  useEffect(() => {
    if (id && !node) uiStore.set({ bookmarkEdit: null })
  }, [id, node])
  if (id && !node) return null

  const close = (): void => uiStore.set({ bookmarkEdit: null })
  const target = inputToUrl(url.trim())
  const save = (): void => {
    if (!target) return
    const title = name.trim() || target
    if (node) run('bookmark.update', { id: node.id, title, url: target })
    else run('bookmark.create', { parentId, title, url: target, type: 'url' })
    close()
  }

  return (
    <div
      className={cn(
        'absolute inset-0 z-50 flex bg-black/25',
        phone ? 'items-end' : 'items-center justify-center'
      )}
      onMouseDown={close}
    >
      <form
        role="dialog"
        aria-label={node ? 'Edit bookmark' : 'Add bookmark'}
        className={cn(
          'zen-panel zen-animate-pop flex flex-col gap-3 p-4',
          phone
            ? 'mx-2 mb-[calc(8px+var(--zen-inset-bottom,0px))] w-auto flex-1'
            : 'w-[420px] max-w-[calc(100%-32px)]'
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <h2 className="text-[14px] font-semibold">{node ? 'Edit bookmark' : 'Add bookmark'}</h2>
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
        <label className="flex flex-col gap-1.5 text-[12px] text-[var(--zen-muted)]">
          URL
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            inputMode="url"
            placeholder="https://"
            className="text-[var(--zen-fg)]"
          />
        </label>
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!target}>
            Save
          </Button>
        </div>
      </form>
    </div>
  )
}
