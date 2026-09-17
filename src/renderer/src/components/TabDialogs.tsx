import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import { SPACE_ICONS } from '@shared/defaults'
import { inputToUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { activeTab, tabTitle } from '@renderer/lib/selectors'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { BookmarkAllTabsDialog } from './bookmarks/BookmarkAllTabsDialog'
import { EditBookmarkDialog } from './bookmarks/EditBookmarkDialog'
import { StarDialog } from './bookmarks/StarDialog'

const TAB_ICONS = [
  ...SPACE_ICONS,
  '📧',
  '📅',
  '📊',
  '🗂️',
  '🎬',
  '🛠️',
  '🧠',
  '🌐',
  '📌',
  '🔔',
  '🎧',
  '🏷️'
]

/**
 * Small dialogs over the window: the star bubble, "Bookmark all tabs", a bookmark or folder
 * edit requested outside the manager (the manager hosts its own), the pinned-URL editor and
 * the icon picker.
 */
export function TabDialogs({ state }: { state: UIState }): JSX.Element | null {
  const pinnedTabId = uiStore.use((s) => s.editingPinnedUrlTabId)
  const iconTabId = uiStore.use((s) => s.iconPickerTabId)
  const star = uiStore.use((s) => s.starDialog)
  const allTabs = uiStore.use((s) => s.bookmarkAllTabs)
  const edit = uiStore.use((s) => s.bookmarkEdit)
  const managerOpen = uiStore.use((s) => s.overlay === 'bookmarks')
  const pinnedTab = pinnedTabId ? state.tabs[pinnedTabId] : undefined
  const iconTab = iconTabId ? state.tabs[iconTabId] : undefined
  if (star) return <StarDialog key={star.nodeId} state={state} star={star} />
  if (allTabs) return <BookmarkAllTabsDialog state={state} request={allTabs} />
  if (edit && !managerOpen) {
    // "Add page…" on the bar starts from the page on screen, like Chrome.
    const tab = edit.id === null && edit.type === 'url' ? activeTab(state) : null
    const prefill =
      tab && tab.url && !tab.url.startsWith('zen://')
        ? { title: tabTitle(tab), url: tab.url }
        : null
    return (
      <EditBookmarkDialog
        key={edit.id ?? `new-${edit.type}`}
        state={state}
        edit={edit}
        prefill={prefill}
      />
    )
  }
  if (pinnedTab) return <PinnedUrlDialog tab={pinnedTab} />
  if (iconTab) return <IconPickerDialog tab={iconTab} />
  return null
}

function Backdrop({
  onClose,
  children
}: {
  onClose: () => void
  children: React.ReactNode
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/25"
      onMouseDown={onClose}
    >
      <div
        className="zen-panel zen-animate-pop w-[420px] max-w-[calc(100%-32px)] p-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

/** Zen 1.21.4 "Edit pinned tab": set the URL a pinned tab resets to. */
function PinnedUrlDialog({ tab }: { tab: UIState['tabs'][string] }): JSX.Element {
  const [value, setValue] = useState(tab.pinnedUrl ?? tab.url)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const close = (): void => uiStore.set({ editingPinnedUrlTabId: null })
  const url = inputToUrl(value)
  const save = (): void => {
    if (!url) return
    run('tab.editPinnedUrl', { tabId: tab.id, url })
    close()
  }
  return (
    <Backdrop onClose={close}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div>
          <h2 className="text-[14px] font-semibold">Edit pinned tab</h2>
          <p className="text-[12px] text-[var(--zen-muted)]">
            The URL this tab returns to when it is reset or closed.
          </p>
        </div>
        <Input
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
        />
        <div className="flex justify-end gap-2">
          {tab.url !== tab.pinnedUrl && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mr-auto"
              onClick={() => setValue(tab.url)}
            >
              Use current URL
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!url}>
            Save
          </Button>
        </div>
      </form>
    </Backdrop>
  )
}

/** Zen's icon picker for tabs: pick an emoji or return to the favicon. */
function IconPickerDialog({ tab }: { tab: UIState['tabs'][string] }): JSX.Element {
  const [custom, setCustom] = useState('')
  const close = (): void => uiStore.set({ iconPickerTabId: null })
  const pick = (icon: string | null): void => {
    run('tab.setIcon', { tabId: tab.id, icon })
    close()
  }
  return (
    <Backdrop onClose={close}>
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-[14px] font-semibold">Change icon</h2>
          <p className="truncate text-[12px] text-[var(--zen-muted)]">
            {tab.customTitle ?? tab.title}
          </p>
        </div>
        <div className="grid grid-cols-9 gap-1">
          <button
            type="button"
            className={cn(
              'zen-squircle flex h-9 items-center justify-center rounded-lg text-[11px] hover:bg-[var(--zen-element-bg)]',
              !tab.customIcon && 'bg-[var(--zen-element-bg-active)]'
            )}
            title="Use the site's favicon"
            onClick={() => pick(null)}
          >
            Auto
          </button>
          {TAB_ICONS.map((e) => (
            <button
              key={e}
              type="button"
              className={cn(
                'zen-squircle flex h-9 items-center justify-center rounded-lg text-lg hover:bg-[var(--zen-element-bg)]',
                tab.customIcon === e && 'bg-[var(--zen-element-bg-active)]'
              )}
              onClick={() => pick(e)}
            >
              {e}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={custom}
            placeholder="Or type any emoji"
            maxLength={4}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && custom.trim() && pick(custom.trim())}
          />
          <Button size="sm" disabled={!custom.trim()} onClick={() => pick(custom.trim())}>
            Use
          </Button>
        </div>
      </div>
    </Backdrop>
  )
}
