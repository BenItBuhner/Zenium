import type { JSX } from 'react'
import { useEffect } from 'react'
import { Bot, Palette, Pause, Play, Plus, Volume2, VolumeX } from 'lucide-react'
import type { MediaState, Space, UIState } from '@shared/types'
import { resolveTheme, rgbToHex } from '@shared/theme'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { run } from '@renderer/lib/api'
import { contextMenuAnchor } from '@renderer/lib/menuKeys'
import { dropStore } from '@renderer/lib/drag'
import { openSettings } from '@renderer/lib/pages'
import { activeTab, isLocalWindow, tabTitle } from '@renderer/lib/selectors'
import { hint } from '@renderer/lib/shortcuts'
import { claimMessageCards, openOverlay, pickToastAction, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { ToastCard } from '../messages/ToastCard'
import { SpaceGlyph } from '../SpaceGlyph'
import { TOOLBAR_STROKE, V2_TRAILING_GLYPH } from '../v2/controls'
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
  const local = isLocalWindow(state)
  // Zen 1.21.11: every playing tab gets its own media control.
  const media = state.media.filter((m) => state.tabs[m.tabId]).slice(0, 3)

  const agents = state.agents.filter((a) => !a.pending)
  // The space row scrolls sideways when expanded and downwards when the sidebar is compact.
  const fadeSpaces = useFadeEdges<HTMLDivElement>({ axis: 'auto', size: 20 })

  // Android's wide layouts show toasts on the message card (`components/messages`); the desktop
  // sidebar keeps its plain toasts until the desktop program adopts the card.
  const cards = state.platform === 'android'
  useEffect(() => (cards ? claimMessageCards() : undefined), [cards])

  return (
    <div className="flex flex-col gap-1 px-2 pb-2 pt-1">
      {agents.length > 0 && <AgentPill agents={agents} compact={compact} />}
      {media.map((m) => (
        <MediaPlayer key={m.tabId} state={state} media={m} compact={compact} />
      ))}
      {toasts.length > 0 && cards && (
        // The well clips the card's slide in from below (and out again) to its own row.
        <div className="zen-message-well">
          {toasts.map((t) => (
            <ToastCard key={t.id} toast={t} compact />
          ))}
        </div>
      )}
      {toasts.length > 0 && !cards && (
        <div className="flex flex-col gap-1">
          {toasts.map((t) => (
            <div
              key={t.id}
              // A polite live region, as the message card is (`ToastCard`): a toast arriving is
              // read without the keyboard moving to it (a11y-02).
              role="status"
              className={cn(
                'zen-toast zen-panel flex items-center gap-2 px-2.5 py-1.5 text-[12px]',
                t.kind === 'error' && 'text-[var(--zen-danger)]'
              )}
            >
              <span className="min-w-0 flex-1">{t.message}</span>
              {t.action && (
                // A v2 secondary button (§6) inside the shipped toast until the toast is redone.
                <button
                  type="button"
                  className="zen-v2 zen-v2-button -my-0.5 shrink-0"
                  onClick={() => pickToastAction(t.id)}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {status && !compact && (
        <div
          className="truncate px-1 text-[11px] text-[var(--v2-control-text-deemphasized)]"
          title={status}
        >
          {status}
        </div>
      )}
      {!local && (
        <div className={cn('flex items-center gap-1', compact && 'flex-col')}>
          <div
            ref={fadeSpaces}
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
              className="zen-toolbar-button h-7 w-7 opacity-50 hover:opacity-100 focus-visible:opacity-100"
              title={hint('New Space', state, 'space.new')}
              onClick={() => void openOverlay('space-editor', current?.id ?? null, null)}
            >
              {/* A 16 toolbar glyph at §9.3's stroke, as the palette beside it. */}
              <Plus className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
            </button>
          </div>
          <button
            type="button"
            className="zen-toolbar-button h-7 w-7"
            title="Change theme"
            onClick={() => void openOverlay('theme', current?.id ?? null, state.activeSpaceId)}
          >
            {/* A 16 toolbar glyph at §9.3's stroke, as the row above draws its own. */}
            <Palette className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
          </button>
        </div>
      )}
    </div>
  )
}

/** A live count of the AI agents driving the browser; opens Settings → AI Agents. */
function AgentPill({
  agents,
  compact
}: {
  agents: UIState['agents']
  compact: boolean
}): JSX.Element {
  const label = `${agents.length} AI agent${agents.length === 1 ? '' : 's'} active`
  return (
    <button
      type="button"
      className={cn(
        'zen-panel flex items-center gap-2 px-2 py-1.5 text-[12px]',
        compact && 'justify-center px-0'
      )}
      title={`${label}: ${agents.map((a) => `${a.name} (${a.mode})`).join(', ')}. Click to manage.`}
      onClick={() => openSettings('agents')}
    >
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        <Bot className="h-4 w-4 text-[var(--zen-accent)]" />
        <span className="absolute -right-1 -top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--zen-accent)]" />
      </span>
      {!compact && (
        <>
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <span className="flex -space-x-1">
            {agents.slice(0, 4).map((a) => (
              <span
                key={a.id}
                className="h-2.5 w-2.5 rounded-full ring-1 ring-[var(--zen-bg)]"
                style={{ background: a.color }}
              />
            ))}
          </span>
        </>
      )}
    </button>
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
        'zen-squircle relative flex h-8 min-w-8 items-center justify-center rounded-lg px-1 text-[17px] leading-none transition-all',
        // The other spaces stand back, but no further than 3:1 on the window (a11y-30): at 45 %
        // a glyph's thin strokes fell to 1.9:1 on a light gradient. The fills are the window
        // family's (§9.29): the current space on `--v2-window-fill`, hover on `-hover`.
        active
          ? 'bg-[var(--v2-window-fill)] opacity-100'
          : 'opacity-70 hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--v2-window-fill-hover)]',
        isDrop && 'opacity-100'
      )}
      data-drop-into={isDrop || undefined}
      data-space-target={space.id}
      aria-current={active ? 'true' : undefined}
      title={space.name}
      onClick={() => run('space.activate', { spaceId: space.id })}
      onContextMenu={(e) => {
        e.preventDefault()
        run('space.contextMenu', { spaceId: space.id, ...contextMenuAnchor(e) })
      }}
    >
      {dragging && <span data-drop={`space:${space.id}`} className="absolute inset-0 z-10" />}
      <SpaceGlyph icon={space.icon} size={17} dotColor={swatch ?? undefined} />

      {active && (
        <span
          className="absolute bottom-0 left-1/2 h-0.5 w-3 -translate-x-1/2 rounded-full"
          style={{ background: swatch ?? 'var(--zen-accent)' }}
        />
      )}
    </button>
  )
}

function MediaPlayer({
  state,
  media,
  compact
}: {
  state: UIState
  media: MediaState
  compact: boolean
}): JSX.Element | null {
  const tab = state.tabs[media.tabId]
  if (!tab) return null
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
        {media.playing ? (
          <Pause className={V2_TRAILING_GLYPH} />
        ) : (
          <Play className={V2_TRAILING_GLYPH} />
        )}
      </button>
      <button
        type="button"
        className="zen-toolbar-button h-6 w-6"
        title={tab.muted ? 'Unmute' : 'Mute'}
        onClick={() => run('tab.toggleMute', { tabId: tab.id })}
      >
        {tab.muted ? (
          <VolumeX className={V2_TRAILING_GLYPH} />
        ) : (
          <Volume2 className={V2_TRAILING_GLYPH} />
        )}
      </button>
    </div>
  )
}
