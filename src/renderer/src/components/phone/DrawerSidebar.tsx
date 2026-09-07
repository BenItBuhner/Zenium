import type { JSX } from 'react'
import { X } from 'lucide-react'
import type { UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { activeSpace, essentialsFor, tabsOf } from '@renderer/lib/selectors'
import { closeDrawer } from '@renderer/lib/ui'
import { Essentials } from '../sidebar/Essentials'
import { SidebarBottom } from '../sidebar/SidebarBottom'
import { SpacePanel } from '../sidebar/SpacePanel'

interface Props {
  state: UIState
  isDark: boolean
}

/**
 * The sidebar as a phone drawer: the same Essentials, pinned tabs, folders, spaces and theme
 * controls as the desktop `Sidebar`, minus navigation (that lives in the bottom bar) and always
 * expanded – there is room for titles, and no hover to collapse to icons.
 */
export function DrawerSidebar({ state, isDark }: Props): JSX.Element {
  const space = activeSpace(state)
  const essentials = essentialsFor(state, space)
  const count = tabsOf(state, space).length + essentials.length
  const activeIndex = Math.max(
    0,
    state.spaces.findIndex((s) => s.id === state.activeSpaceId)
  )

  return (
    <aside className="zen-panel zen-animate-in relative flex h-full w-full flex-col">
      <div className="flex h-12 items-center gap-2 px-3 pt-1">
        <span className="text-base leading-none">{space.icon || '◦'}</span>
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold"
          onClick={() => run('space.contextMenu', { spaceId: space.id })}
          onContextMenu={(e) => {
            e.preventDefault()
            run('space.contextMenu', { spaceId: space.id })
          }}
        >
          {space.name}
        </button>
        <span className="text-[12px] text-[var(--zen-muted)]">
          {count} tab{count === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          className="zen-toolbar-button h-8 w-8"
          aria-label="Close"
          onClick={() => closeDrawer()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <Essentials essentials={essentials} activeTabId={space.activeTabId} compact={false} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className="zen-space-strip h-full"
          style={{
            transform: `translateX(-${activeIndex * 100}%)`,
            width: `${state.spaces.length * 100}%`
          }}
        >
          {state.spaces.map((s) => (
            <div key={s.id} className="h-full" style={{ width: `${100 / state.spaces.length}%` }}>
              <SpacePanel
                state={state}
                space={s}
                isActive={s.id === state.activeSpaceId}
                compact={false}
              />
            </div>
          ))}
        </div>
      </div>
      <SidebarBottom state={state} compact={false} isDark={isDark} />
    </aside>
  )
}
