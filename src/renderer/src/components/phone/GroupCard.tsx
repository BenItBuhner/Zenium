import type { CSSProperties, JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Folder, Tab } from '@shared/types'
import { run } from '@renderer/lib/api'
import { groupColorChannels } from '@renderer/lib/groups'
import { layoutAnimations } from '@renderer/lib/motion/flip'
import { SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Favicon } from '../sidebar/Favicon'
import { liftStore } from './useCardLift'
import { useLongPress } from './useLongPress'

/** Height of a group card's header row – all a collapsed group shows. */
export const GROUP_HEADER = 44
/** Inset of the member cards inside the group card: its radius is the card radius plus this. */
export const GROUP_PAD = 4

interface Props {
  folder: Folder
  tabs: Tab[]
  card: (tab: Tab) => JSX.Element
  onMenu: (folder: Folder) => void
  /** The card's element, for the hero morph and the grid's glide. */
  ref: (el: HTMLDivElement | null) => void
}

/**
 * A tab group in the overview: a tinted card with the group's name and colour in a header row
 * and its tabs in a grid below. The header toggles it; collapsed, the card is clipped to the
 * header and shows the members' icons instead. The height runs on a spring that a second tap
 * retargets mid-flight.
 */
export function GroupCard({ folder, tabs, card, onMenu, ref }: Props): JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const collapsed = folder.collapsed
  const renaming = uiStore.use((s) => s.renamingFolderId === folder.id)
  const targeted = liftStore.use(
    (s) =>
      s.phase === 'dragging' &&
      s.tabId !== null &&
      !tabs.some((t) => t.id === s.tabId) &&
      (s.target === `group:${folder.id}` || tabs.some((t) => s.target === `card:${t.id}`))
  )

  const spring = useRef<SpringAnimation | null>(null)
  useLayoutEffect(() => {
    const anim = new SpringAnimation(
      SPRING_GENTLE,
      (h) => {
        if (shellRef.current) shellRef.current.style.height = `${Math.max(GROUP_HEADER, h)}px`
      },
      () => {
        const shell = shellRef.current
        if (shell) shell.style.height = shell.dataset.collapsed ? `${GROUP_HEADER}px` : ''
        layoutAnimations.end(folder.id)
      }
    )
    spring.current = anim
    return () => {
      anim.stop()
      spring.current = null
      layoutAnimations.end(folder.id)
    }
  }, [folder.id])

  // The height is the card's own business, never React's: collapsed it is clipped to its header,
  // expanded it is whatever the body needs, and between the two a spring runs from wherever the
  // card is right now.
  const mounted = useRef(false)
  useLayoutEffect(() => {
    const shell = shellRef.current
    const body = bodyRef.current
    const anim = spring.current
    if (!shell || !body || !anim) return
    if (!mounted.current) {
      mounted.current = true
      shell.style.height = collapsed ? `${GROUP_HEADER}px` : ''
      return
    }
    const from = shell.getBoundingClientRect().height
    const to = collapsed ? GROUP_HEADER : GROUP_HEADER + body.offsetHeight
    const velocity = anim.running ? anim.current.v : 0
    layoutAnimations.start(folder.id)
    shell.style.height = `${from}px`
    anim.start(from, velocity, to)
  }, [collapsed, folder.id])

  const press = useLongPress(() => onMenu(folder))
  const toggle = (): void => {
    if (press.swallowsClick()) return
    if (renaming) return
    run('folder.update', { folderId: folder.id, patch: { collapsed: !collapsed } })
  }

  const style = {
    '--zen-group-rgb': groupColorChannels(folder.color)
  } as CSSProperties
  return (
    <div
      ref={(el) => {
        shellRef.current = el
        ref(el)
      }}
      className="zen-group col-span-2 flex flex-col overflow-hidden"
      style={style}
      data-drop={`group:${folder.id}`}
      data-targeted={targeted || undefined}
      data-collapsed={collapsed || undefined}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={`Group ${folder.name}`}
        aria-expanded={!collapsed}
        className="zen-group-header flex shrink-0 items-center gap-2.5 pl-3 pr-2"
        style={{ height: GROUP_HEADER }}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') toggle()
        }}
        {...press.handlers}
      >
        <span className="zen-group-dot h-2.5 w-2.5 shrink-0 rounded-full" />
        {renaming ? (
          <GroupRename folder={folder} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{folder.name}</span>
        )}
        <span
          className={cn(
            'flex items-center gap-1 transition-opacity duration-150',
            collapsed ? 'opacity-100' : 'opacity-0'
          )}
          aria-hidden
        >
          {tabs.slice(0, 4).map((tab) => (
            <Favicon key={tab.id} tab={tab} size={14} />
          ))}
        </span>
        <span className="text-[12px] tabular-nums text-[var(--zen-muted)]">{tabs.length}</span>
        <ChevronDown
          className="h-4 w-4 shrink-0 opacity-60 transition-transform duration-200"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
        />
      </div>
      <div
        ref={bodyRef}
        className="grid grid-cols-2 gap-3"
        style={{ padding: GROUP_PAD, paddingTop: 0 }}
        aria-hidden={collapsed || undefined}
      >
        {tabs.map(card)}
      </div>
    </div>
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
      className="min-w-0 flex-1 rounded-[9px] bg-[var(--zen-element-bg)] px-2 py-1 text-[13px] font-semibold outline-none"
    />
  )
}
