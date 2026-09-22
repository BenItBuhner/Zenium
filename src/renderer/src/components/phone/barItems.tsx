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
  TextSearch
} from 'lucide-react'
import type { PhoneBarItemId, PhoneBarLayout, Tab, UIState } from '@shared/types'
import { phoneBarForHost, phoneBarItemEnabled, phoneBarOffered } from '@shared/phoneBar'
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
import { openFindBar, openOverlay, openUrlbar, prepareMenu } from '@renderer/lib/ui'
import { startVoiceSearch } from '@renderer/lib/voiceSearch'
import { ReloadStopGlyph, StarGlyph, TabCountBadge } from './BarGlyphs'

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
    // The homepage (Settings › Homepage, TB-15 / NTP-30): the user's page, or the new tab page
    // at rest – its field is the way to the address bar. The item is drawn only while a
    // homepage is set (`barLayout`); a hold on it opens the setting (PhoneShell).
    run: ({ tab }) => {
      if (tab) run('tab.home', { tabId: tab.id })
      else void openUrlbar('new-tab', null, { text: '', attached: true })
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
  // The star follows the app menu's (#236, the lead's ruling for both): a stateful glyph on
  // `bookmark.star`, not a toggle – outlined "Bookmark" on a page that is not bookmarked, filled
  // "Edit Bookmark" once it is, no `aria-pressed` (a press does not flip a state and back: it
  // saves and opens the edit flow, Chrome's and Firefox's toolbar stars; a toggle would remove
  // the bookmark on the second tap with nothing to undo, while the editor offers Remove). The
  // core saves at once and the state's flip fills the star on the menu star's spring, in parallel
  // with what the command opens: the saved toast with its Edit on a fresh bookmark, the editor on
  // a bookmarked page. The editor lists the item as "Bookmark this page", beside Bookmarks.
  bookmark: {
    id: 'bookmark',
    label: 'Bookmark this page',
    name: ({ tab }) => (tab?.bookmarked ? 'Edit Bookmark' : 'Bookmark'),
    glyph: ({ tab }) => <StarGlyph filled={Boolean(tab?.bookmarked)} />,
    run: ({ tab }) => tab && run('bookmark.star', { tabId: tab.id })
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
  // The name carries the count the badge draws. On Chromium 156's bridge a toggle button's
  // name from an attribute goes to the supplemental description, its child text to the text
  // (`ui::SupportsNamingWithChildContent` lists `kButton` and not `kToggleButton` or
  // `kPopUpButton`; `BrowserAccessibilityAndroid::ComputeAndroidNameTo`), so TalkBack there
  // says the badge's "6" and then "Tabs (6)". Upstream Chromium's, recorded with #237's audit:
  // no attribute here puts a toggle's name in the content description short of giving up
  // `aria-pressed` or naming the button by hidden text, and WebView 113 reads the name once.
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
    // The sheet comes up over the page's picture: taken as the finger lands, so the tap's
    // round trip through the core and the host's capture run together (`prepareMenu`).
    press: ({ tab }) => prepareMenu(tab?.id ?? null),
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

/**
 * `settings.phoneBar` as this host draws it: without items whose command it lacks, and without
 * Home while the homepage is off (TB-15: Chrome's Home button leaves the toolbar with the
 * homepage; the editor keeps listing it, and the layout keeps it for when the homepage is back).
 */
export function barLayout(state: UIState): PhoneBarLayout {
  const shown = barCatalogue(state).filter(
    (id) => id !== 'home' || state.settings.homepage.mode !== 'off'
  )
  return phoneBarForHost(state.settings.phoneBar, shown)
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
