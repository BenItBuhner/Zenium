import type { JSX } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Clock,
  Download,
  House,
  Mic,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Plus,
  Share2,
  Star,
  TextSearch
} from 'lucide-react'
import type { PhoneBarItemId, PhoneBarLayout, Tab, UIState } from '@shared/types'
import { phoneBarForHost, phoneBarItemEnabled, phoneBarOffered } from '@shared/phoneBar'
import { BLANK_URL } from '@shared/url'
import { run } from '@renderer/lib/api'
import { openSpacesDrawer } from '@renderer/lib/gestures/drawer'
import { toggleOverview } from '@renderer/lib/gestures/stage'
import { prepareNewTabGrow } from '@renderer/lib/newtab'
import {
  activeTabIsPrivate,
  isPrivateTab,
  privateTabsOf,
  tabsOnPane
} from '@renderer/lib/privateTabs'
import { activeSpace, activeTab, essentialsFor, tabsOf } from '@renderer/lib/selectors'
import { openFindBar, openOverlay, openUrlbar } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { startVoiceSearch } from '@renderer/lib/voiceSearch'
import { ReloadStopGlyph, TabCountBadge } from './BarGlyphs'

/**
 * The catalogue behind `settings.phoneBar`: what each control of the phone's bar is called,
 * what it draws and what it does. Every action is one of the browser core's existing commands
 * (or the chrome's own openers), so a bar item and its desktop counterpart cannot drift apart.
 * The address pill is not in here – it is always in the bar, between the two sides.
 */

/** What an item is drawn and run against. */
export interface BarItemContext {
  state: UIState
  tab: Tab | null
  /** The tab overview is open (the Tabs button is pressed). */
  overviewOpen: boolean
}

export interface BarItem {
  id: PhoneBarItemId
  /** Name in the editor and for assistive tech. */
  label: string
  /** The 20 px glyph (or badge) as drawn in the bar right now. */
  glyph: (ctx: BarItemContext) => JSX.Element
  /** Accessible name in the bar, when it says more than the label (Tabs carries its count). */
  name?: (ctx: BarItemContext) => string
  /** Toggle buttons report their state. */
  pressed?: (ctx: BarItemContext) => boolean
  /** Runs as the finger lands, before `run`: work the tap must find done (a capture). */
  press?: (ctx: BarItemContext) => void
  /** The tap; `target` is the button in the bar, for an item whose surface grows out of it. */
  run: (ctx: BarItemContext, target?: HTMLElement) => void
}

const glyph = 'h-5 w-5'

export const BAR_ITEMS: Record<PhoneBarItemId, BarItem> = {
  back: {
    id: 'back',
    label: 'Back',
    glyph: () => <ArrowLeft className={glyph} />,
    run: ({ tab }) => tab && run('tab.back', { tabId: tab.id })
  },
  forward: {
    id: 'forward',
    label: 'Forward',
    glyph: () => <ArrowRight className={glyph} />,
    run: ({ tab }) => tab && run('tab.forward', { tabId: tab.id })
  },
  reload: {
    id: 'reload',
    label: 'Reload',
    name: ({ tab }) => (tab?.loading ? 'Stop' : 'Reload'),
    glyph: ({ tab }) => <ReloadStopGlyph loading={Boolean(tab?.loading)} />,
    run: ({ tab }) => {
      if (!tab) return
      if (tab.loading) run('tab.stop', { tabId: tab.id })
      else run('tab.reload', { tabId: tab.id })
    }
  },
  home: {
    id: 'home',
    label: 'Home',
    glyph: () => <House className={glyph} />,
    // Zen has no home page: home is the new-tab state – a blank page with the address bar up.
    run: ({ tab }) => {
      if (tab && tab.url !== BLANK_URL) run('tab.navigate', { tabId: tab.id, input: BLANK_URL })
      void openUrlbar(tab ? 'edit' : 'new-tab', tab?.id ?? null, { text: '', attached: true })
    }
  },
  share: {
    id: 'share',
    label: 'Share',
    glyph: () => <Share2 className={glyph} />,
    // What the menu's Share… sends: the page's title and address, the favicon for the preview.
    run: ({ tab }) =>
      tab &&
      run('app.share', {
        title: tab.customTitle ?? tab.title,
        url: tab.url,
        tabId: tab.id,
        favicon: tab.favicon ?? undefined
      })
  },
  bookmark: {
    id: 'bookmark',
    label: 'Bookmark this page',
    name: ({ tab }) => (tab?.bookmarked ? 'Remove bookmark' : 'Bookmark this page'),
    pressed: ({ tab }) => Boolean(tab?.bookmarked),
    glyph: ({ tab }) => (
      <Star
        className={cn(glyph, 'transition-[fill] duration-[120ms]')}
        fill={tab?.bookmarked ? 'currentColor' : 'none'}
      />
    ),
    run: ({ tab }) => tab && run('bookmark.toggle', { tabId: tab.id })
  },
  bookmarks: {
    id: 'bookmarks',
    label: 'Bookmarks',
    glyph: () => <Bookmark className={glyph} />,
    run: ({ tab }) => void openOverlay('bookmarks', tab?.id ?? null)
  },
  history: {
    id: 'history',
    label: 'History',
    glyph: () => <Clock className={glyph} />,
    run: ({ tab }) => void openOverlay('history', tab?.id ?? null)
  },
  downloads: {
    id: 'downloads',
    label: 'Downloads',
    glyph: () => <Download className={glyph} />,
    run: ({ tab }) => void openOverlay('downloads', tab?.id ?? null)
  },
  tabs: {
    id: 'tabs',
    label: 'Tabs',
    name: ({ state }) => `Tabs (${tabCount(state)})`,
    pressed: ({ overviewOpen }) => overviewOpen,
    glyph: ({ state, overviewOpen }) => (
      <TabCountBadge count={tabCount(state)} active={overviewOpen} />
    ),
    run: ({ state }) => toggleOverview(state)
  },
  'new-tab': {
    id: 'new-tab',
    label: 'New tab',
    glyph: () => <Plus className={glyph} />,
    // The new tab page grows out of this button (MOT-03): the page behind is captured as the
    // finger lands, and the button's bounds travel with the event as the surface's origin. The
    // new tab keeps the mode: from a private tab it is a private tab (the grow lands on the
    // private new tab page), as the desktop private window's and Chrome's incognito strip's "+"
    // keep theirs; the mode is left through the overview's Tabs pane or Close Private Tabs.
    press: prepareNewTabGrow,
    run: ({ tab }, target) => {
      const r = target?.getBoundingClientRect()
      const origin = r ? { x: r.left, y: r.top, width: r.width, height: r.height } : undefined
      const containerId = tab && isPrivateTab(tab) ? tab.containerId : undefined
      window.dispatchEvent(new CustomEvent('zen-new-tab', { detail: { origin, containerId } }))
    }
  },
  menu: {
    id: 'menu',
    label: 'Menu',
    glyph: () => <MoreHorizontal className={glyph} />,
    run: () => run('app.menu', {})
  },
  spaces: {
    id: 'spaces',
    label: 'Spaces',
    glyph: ({ state }) =>
      state.settings.sidebarSide === 'right' ? (
        <PanelRight className={glyph} />
      ) : (
        <PanelLeft className={glyph} />
      ),
    run: ({ tab }) => void openSpacesDrawer(tab?.id ?? null)
  },
  find: {
    id: 'find',
    label: 'Find in page',
    glyph: () => <TextSearch className={glyph} />,
    run: ({ tab }) => {
      if (!tab) return
      run('focus.chrome', undefined)
      openFindBar(tab.id)
    }
  },
  // OMN-19, offered where the host has a recogniser (`phoneBarOffered`): the listening sheet,
  // its result loading in this tab as a submit from the bar's pill would.
  voice: {
    id: 'voice',
    label: 'Voice search',
    glyph: () => <Mic className={glyph} />,
    run: ({ tab }) => void startVoiceSearch({ tabId: tab?.id ?? null })
  }
}

export function barItem(id: PhoneBarItemId): BarItem {
  return BAR_ITEMS[id]
}

/** The items this host offers, in catalogue order. */
export function barCatalogue(state: UIState): PhoneBarItemId[] {
  return phoneBarOffered(state.capabilities)
}

/** `settings.phoneBar` as this host draws it: without items whose command it lacks. */
export function barLayout(state: UIState): PhoneBarLayout {
  return phoneBarForHost(state.settings.phoneBar, barCatalogue(state))
}

/** Whether the item does anything right now. */
export function barItemEnabled(id: PhoneBarItemId, ctx: BarItemContext): boolean {
  return phoneBarItemEnabled(id, { tab: ctx.tab })
}

export function barContext(state: UIState, overviewOpen: boolean): BarItemContext {
  return { state, tab: activeTab(state), overviewOpen }
}

/**
 * What the overview shows for the active tab: the private tabs while a private one is active
 * (its Private pane), else the tabs in the current space plus the Essentials, the private ones
 * aside (its Tabs pane) – as Chrome's switcher counts the mode it is in.
 */
export function tabCount(state: UIState): number {
  if (activeTabIsPrivate(state)) return privateTabsOf(state).length
  const space = activeSpace(state)
  return tabsOnPane(tabsOf(state, space), 'tabs').length + essentialsFor(state, space).length
}
