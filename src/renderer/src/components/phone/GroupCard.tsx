import type { CSSProperties, JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Folder, Tab } from '@shared/types'
import { run } from '@renderer/lib/api'
import { groupColorChannels } from '@renderer/lib/groups'
import { CELL_ATTR, layoutAnimations } from '@renderer/lib/motion/flip'
import { SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Favicon } from '../sidebar/Favicon'
import { departStore } from './departureStore'
import { liftStore } from './useCardLift'
import { useLongPress } from './useLongPress'

/** Height of a group card's title row – all a collapsed group shows. */
export const GROUP_HEADER = 32
/** The icon folders get by default; a group made on the phone shows its colour instead. */
export const DEFAULT_FOLDER_ICON = '📁'
/** Inset of the member cards inside the group card: its radius is the card radius plus this. */
export const GROUP_PAD = 6

interface Props {
  folder: Folder
  tabs: Tab[]
  card: (tab: Tab) => JSX.Element
  onMenu: (folder: Folder) => void
  /** Columns of the overview grid: a group of two or more spans them all and lays out in as many. */
  columns: number
  /**
   * The group has just been made while the grid was on screen (v2 §11.4): it grows on its
   * spring out of the bare row of cards it was made from, and its header and tint stay off until
   * the tracker releases the cells below at the end of the glide (`onRelease`).
   */
  forming?: boolean
  /**
   * The group has lost its last card while on screen (v2 §11.4): it shrinks to nothing on its
   * spring while the card glides out, the cells below waiting, and calls `onDissolved` once it
   * has – the owner takes it off the grid then, header and tint going with it. `held` is how
   * many cards it had: the span and the count it keeps while it shrinks, so the row stands still
   * around it.
   */
  dissolving?: boolean
  held?: number
  onDissolved?: (folder: Folder) => void
  /** Subscribe to the FLIP tracker's release (see `FlipTracker.onRelease`). */
  onRelease?: (listener: () => void) => () => void
}

/**
 * A tab group in the overview: a tinted card with the group's name and colour in a header row
 * and its tabs in a grid below. The header toggles it; collapsed, the card is clipped to the
 * header and shows the members' icons instead. The height runs on a spring – on a fold, and
 * whenever what the card holds changes height (a card entering or leaving, a row coming or
 * going) – that a change mid-flight retargets; the cells below wait for it through the FLIP
 * tracker (`layoutAnimations`, v2 §11.4). The card is the grid's cell `group:<id>` for the glide
 * and the morph.
 */
export function GroupCard({
  folder,
  tabs,
  card,
  onMenu,
  columns,
  forming,
  dissolving = false,
  held,
  onDissolved,
  onRelease
}: Props): JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const collapsed = folder.collapsed
  const key = `group:${folder.id}`
  const renaming = uiStore.use((s) => s.renamingFolderId === folder.id)
  const targeted = liftStore.use(
    (s) =>
      s.phase === 'dragging' &&
      s.tabId !== null &&
      !tabs.some((t) => t.id === s.tabId) &&
      (s.target === key || tabs.some((t) => s.target === `card:${t.id}`))
  )

  // A group being made shows no header and no tint until the end of the glide – radius, header
  // and tint are not animated properties (v2 §11.4). Subscribed before the height effect below
  // runs the spring: under reduced motion it settles, and the tracker releases, within that
  // very effect.
  const [chromeOff, setChromeOff] = useState(Boolean(forming))
  useLayoutEffect(() => {
    if (!chromeOff || !onRelease) return
    return onRelease(() => setChromeOff(false))
  }, [chromeOff, onRelease])

  const latest = useRef({ folder, dissolving, onDissolved })
  useLayoutEffect(() => {
    latest.current = { folder, dissolving, onDissolved }
  })
  const spring = useRef<SpringAnimation | null>(null)
  useLayoutEffect(() => {
    const anim = new SpringAnimation(
      SPRING_GENTLE,
      (h) => {
        const height = Math.max(latest.current.dissolving ? 0 : GROUP_HEADER, h)
        if (shellRef.current) shellRef.current.style.height = `${height}px`
        layoutAnimations.frame(key, height)
      },
      () => {
        const shell = shellRef.current
        const { dissolving, onDissolved, folder } = latest.current
        if (shell) {
          if (dissolving) {
            // Gone: no longer a cell for the tracker's release to measure; the owner takes the
            // card off the grid on the next render.
            shell.style.height = '0px'
            shell.style.display = 'none'
            shell.removeAttribute(CELL_ATTR)
          } else {
            shell.style.height = shell.dataset.collapsed ? `${GROUP_HEADER}px` : ''
            delete shell.dataset.clip
          }
        }
        layoutAnimations.end(key)
        if (dissolving) onDissolved?.(folder)
      }
    )
    spring.current = anim
    return () => {
      anim.stop()
      spring.current = null
      layoutAnimations.end(key)
    }
  }, [key])

  // The height is the card's own business, never React's: collapsed it is clipped to its header,
  // expanded it is whatever the body needs, dissolving it is nothing, and between any two heights
  // a spring runs from wherever the card is right now. `settled` is the height the grid was last
  // laid out at – what the tracker's positions assume – so a change in the body is caught on the
  // commit it lands.
  const mounted = useRef(false)
  const settled = useRef<number | null>(null)
  const wasCollapsed = useRef(collapsed)
  useLayoutEffect(() => {
    const shell = shellRef.current
    const body = bodyRef.current
    const anim = spring.current
    if (!shell || !body || !anim) return
    const to = dissolving ? 0 : collapsed ? GROUP_HEADER : GROUP_HEADER + body.offsetHeight
    const run = (from: number, velocity: number): void => {
      layoutAnimations.start(key, from, to, !dissolving)
      shell.style.display = ''
      shell.style.height = `${from}px`
      settled.current = to
      anim.start(from, velocity, to)
    }
    if (!mounted.current) {
      mounted.current = true
      if (forming && !collapsed) {
        // Out of the row of cards it was made from: header and tint come at the end.
        run(Math.max(GROUP_HEADER, body.offsetHeight - GROUP_PAD), 0)
      } else {
        shell.style.height = collapsed ? `${GROUP_HEADER}px` : ''
        settled.current = to
      }
      return
    }
    // Folding or unfolding, and shrinking to nothing, the card is clipped to the shell until it
    // has come to rest.
    if (collapsed !== wasCollapsed.current || dissolving) shell.dataset.clip = ''
    wasCollapsed.current = collapsed
    if (dissolving && shell.style.position !== 'absolute') {
      // Out of the grid's flow, where it stood: the card its last member became takes its cell
      // and glides there once, the cells below wait for the height as they would for any group,
      // and the card shrinks away under the loose card (which is positioned, and paints over it).
      const { offsetLeft, offsetTop, offsetWidth } = shell
      shell.style.position = 'absolute'
      shell.style.left = `${offsetLeft}px`
      shell.style.top = `${offsetTop}px`
      shell.style.width = `${offsetWidth}px`
    }
    if (anim.running) {
      if (Math.abs(to - anim.destination) >= 0.5) {
        settled.current = to
        layoutAnimations.retarget(key, to)
        anim.retarget(to)
      }
      return
    }
    const from = settled.current ?? to
    if (Math.abs(to - from) < 0.5) {
      settled.current = to
      return
    }
    run(from, 0)
  })

  const press = useLongPress(() => onMenu(folder))
  const toggle = (): void => {
    if (press.swallowsClick()) return
    if (renaming) return
    run('folder.update', { folderId: folder.id, patch: { collapsed: !collapsed } })
  }

  // Closing: the exit drawn over the card takes its place until the browser removes the tabs.
  const departing = departStore.use((s) => s.items.some((i) => i.key === `group:${folder.id}`))
  const style = {
    '--zen-group-rgb': groupColorChannels(folder.color),
    opacity: departing ? 0 : undefined
  } as CSSProperties
  // A group of one takes a single column, like the card it holds; two or more span the row,
  // however many columns the window gives it, and lay their cards out in the same columns. A
  // group shrinking to nothing keeps the span and the count it had.
  const count = dissolving ? (held ?? 0) : tabs.length
  const single = count <= 1
  return (
    <div
      ref={shellRef}
      className={cn('zen-group flex flex-col', single ? 'col-span-1' : 'col-span-full')}
      style={style}
      data-cell={key}
      data-targeted={targeted || undefined}
      data-collapsed={collapsed || undefined}
      data-chrome={chromeOff ? 'off' : undefined}
      data-dissolving={dissolving || undefined}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={`Group ${folder.name}`}
        aria-expanded={!collapsed}
        className="zen-group-header flex shrink-0 items-center gap-2 pl-3 pr-2"
        style={{ height: GROUP_HEADER }}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') toggle()
        }}
        {...press.handlers}
      >
        <GroupBadge folder={folder} />
        {renaming ? (
          <GroupRename folder={folder} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{folder.name}</span>
        )}
        <span
          className={cn(
            'flex items-center gap-1 transition-opacity duration-150',
            collapsed ? 'opacity-100' : 'opacity-0'
          )}
          aria-hidden
        >
          {tabs.slice(0, single ? 1 : 4).map((tab) => (
            <Favicon key={tab.id} tab={tab} size={14} />
          ))}
        </span>
        <span className="text-[12px] tabular-nums text-[var(--zen-muted)]">{count}</span>
        <ChevronDown
          className="h-4 w-4 shrink-0 opacity-60 transition-transform duration-200 motion-reduce:transition-none"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
        />
      </div>
      <div
        ref={bodyRef}
        className="grid gap-3"
        style={{
          padding: GROUP_PAD,
          paddingTop: 0,
          gridTemplateColumns: `repeat(${single ? 1 : columns}, minmax(0, 1fr))`
        }}
        aria-hidden={collapsed || undefined}
      >
        {tabs.map(card)}
      </div>
    </div>
  )
}

/** What stands for the group in its header: its own icon, or a dot of its colour. */
export function GroupBadge({ folder }: { folder: Folder }): JSX.Element {
  return folder.icon && folder.icon !== DEFAULT_FOLDER_ICON ? (
    // A folder given its own icon on the desktop keeps it; the colour still tints the card.
    <span className="w-4 shrink-0 text-center text-[14px] leading-none" aria-hidden>
      {folder.icon}
    </span>
  ) : (
    <span className="zen-group-dot h-2.5 w-2.5 shrink-0 rounded-full" aria-hidden />
  )
}

function GroupRename({ folder }: { folder: Folder }): JSX.Element {
  const [value, setValue] = useState(folder.name)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = (save: boolean): void => {
    if (uiStore.get().renamingFolderId === folder.id) uiStore.set({ renamingFolderId: null })
    if (save && value.trim() && value.trim() !== folder.name)
      run('folder.update', { folderId: folder.id, patch: { name: value.trim() } })
  }
  return (
    <input
      ref={ref}
      value={value}
      aria-label="Group name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => commit(true)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(true)
        if (e.key === 'Escape') commit(false)
        e.stopPropagation()
      }}
      className="min-w-0 flex-1 rounded-[8px] bg-[var(--zen-element-bg)] px-2 py-0.5 text-[13px] font-medium outline-none"
    />
  )
}
