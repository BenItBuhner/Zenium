import type { JSX } from 'react'
import { Palette, Pause, Play, Plus, Volume2, VolumeX } from 'lucide-react'
import type { Space, UIState } from '@shared/types'
import { resolveTheme, rgbToHex } from '@shared/theme'
import { run } from '@renderer/lib/api'
import { dropStore } from '@renderer/lib/drag'
import { activeTab, tabTitle } from '@renderer/lib/selectors'
import { openOverlay, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Favicon } from './Favicon'

interface Props {
  state: UIState
  compact: boolean
  isDark: boolean
}

export function SidebarBottom({ state, compact, isDark }: Props): JSX.Element {
  const drag = uiStore.use((s) => s.drag)
  const dropKey = dropStore.use((s) => s.key)
  const status = uiStore.use((s) => s.statusText)
  const toasts = uiStore.use((s) => s.toasts)
  const current = activeTab(state)

  return (
    <div className="flex flex-col gap-1 px-2 pb-2 pt-1">
      {state.media.length > 0 && <MediaPlayer state={state} compact={compact} />}
      {toasts.length > 0 && (
        <div className="flex flex-col gap-1">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cn(
                'zen-toast zen-panel px-2.5 py-1.5 text-[12px]',
                t.kind === 'error' && 'text-red-500'
              )}
            >
              {t.message}
            </div>
          ))}
        </div>
      )}
      {status && !compact && (
        <div className="truncate px-1 text-[11px] text-[var(--zen-muted)]" title={status}>
          {status}
        </div>
      )}
      <div className={cn('flex items-center gap-1', compact && 'flex-col')}>
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden py-0.5 [scrollbar-width:none]',
            compact && 'flex-col'
          )}
        >
          {state.spaces.map((space) => (
            <SpaceIcon
              key={space.id}
              space={space}
              active={space.id === state.activeSpaceId}
              isDark={isDark}
              dropKey={dropKey}
              dragging={Boolean(drag)}
            />
          ))}
          <button
            type="button"
            className="zen-toolbar-button h-7 w-7 opacity-50 hover:opacity-100"
            title="New Space"
            onClick={() => void openOverlay('space-editor', current?.id ?? null, null)}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          type="button"
          className="zen-toolbar-button h-7 w-7"
          title="Change theme"
          onClick={() => void openOverlay('theme', current?.id ?? null, state.activeSpaceId)}
        >
          <Palette className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

function SpaceIcon({
  space,
  active,
  isDark,
  dropKey,
  dragging
}: {
  space: Space
  active: boolean
  isDark: boolean
  dropKey: string | null
  dragging: boolean
}): JSX.Element {
  const swatch = space.theme ? rgbToHex(resolveTheme(space.theme, isDark).accent) : null
  const isDrop = dropKey === `space:${space.id}`
  return (
    <button
      type="button"
      className={cn(
        'relative flex h-7 min-w-7 items-center justify-center rounded-lg px-1 text-[15px] leading-none transition-all',
        active
          ? 'bg-[var(--zen-element-bg-active)] opacity-100'
          : 'opacity-45 hover:opacity-90 hover:bg-[var(--zen-element-bg)]',
        isDrop && 'ring-2 ring-[var(--zen-accent)] opacity-100'
      )}
      title={space.name}
      onClick={() => run('space.activate', { spaceId: space.id })}
      onContextMenu={(e) => {
        e.preventDefault()
        run('space.contextMenu', { spaceId: space.id })
      }}
    >
      {dragging && <span data-drop={`space:${space.id}`} className="absolute inset-0 z-10" />}
      {space.icon ? (
        <span>{space.icon}</span>
      ) : (
        <span
          className="h-3 w-3 rounded-full border-2"
          style={{ borderColor: swatch ?? 'var(--zen-fg)' }}
        />
      )}
      {active && (
        <span
          className="absolute bottom-0 left-1/2 h-0.5 w-3 -translate-x-1/2 rounded-full"
          style={{ background: swatch ?? 'var(--zen-accent)' }}
        />
      )}
    </button>
  )
}

function MediaPlayer({ state, compact }: { state: UIState; compact: boolean }): JSX.Element | null {
  const media = state.media[0]
  const tab = media ? state.tabs[media.tabId] : undefined
  if (!media || !tab) return null
  return (
    <div className={cn('zen-panel flex items-center gap-2 px-2 py-1.5', compact && 'flex-col')}>
      <Favicon tab={tab} />
      {!compact && (
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-[12px]"
          title={tabTitle(tab)}
          onClick={() => run('tab.activate', { tabId: tab.id })}
        >
          {tabTitle(tab)}
        </button>
      )}
      <button
        type="button"
        className="zen-toolbar-button h-6 w-6"
        title={media.playing ? 'Pause' : 'Play'}
        onClick={() => run('media.toggle', { tabId: tab.id })}
      >
        {media.playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        className="zen-toolbar-button h-6 w-6"
        title={tab.muted ? 'Unmute' : 'Mute'}
        onClick={() => run('tab.toggleMute', { tabId: tab.id })}
      >
        {tab.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}
