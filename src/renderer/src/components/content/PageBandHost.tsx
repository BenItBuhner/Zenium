import type { JSX } from 'react'
import { useLayoutEffect, useMemo } from 'react'
import type { UIState } from '@shared/types'
import { isEmptyTabUrl, isInternalUrl } from '@shared/url'
import { setBandFrame } from '@renderer/lib/band'
import { bandSeat, movePage, seatBand } from '@renderer/lib/pageBand'
import { isPrivateTab } from '@renderer/lib/privateTabs'
import { activeTab, isForeignTab } from '@renderer/lib/selectors'
import type { UiState } from '@renderer/lib/ui'
import { PageEdgeBand, type BandHost } from '../band/PageEdgeBand'
import { useBandTabs } from '../band/useBandTabs'
import { useCrashRestoreBand } from './useCrashRestoreBand'
import { useDefaultBrowserBand } from './useDefaultBrowserBand'

interface Props {
  state: UIState
  ui: UiState
}

/**
 * The desktop's host for the page-edge band (motion spec §3.4): the band is a chrome element at
 * the frame's top, in both bar positions (root's §8 ruling), and the page under it follows the
 * rect the chrome reports. The host tells the model what the frame shows (`setBandFrame`): the
 * tab in front and the scene that is (the tab, a page's fullscreen, the window's, a page shown
 * in another window – a standing that changes with any of these is a cut, not a travel); whether
 * a band may stand on it (§3.2's never-on list as the Design Lead ruled it on item 8: not on the
 * empty frame, not on a chrome page – for the band every internal address is one, `zen://version`
 * and `zen://game` included whatever the chrome draws there, the new tab page and the blank page
 * excepted – not on a page shown in another window, not in a fullscreen); whether offers may (a
 * state alone stands on the new tab page and the blank page – `isEmptyTabUrl`, with the slash a
 * load adds – and no offer on a private tab); and what covers the page – a chrome overlay, a
 * frame dialog, the URL bar, Web capture, the gesture stage – under which a prompt arriving waits
 * and one standing stays (the frame dialog host's scrim dims it with the page's picture). It
 * fills the band's seam for this host: the page's offset goes to the core per frame, which moves
 * the placed views' bounds (`layout.pageOffset`, a move, never a resize); a travel's departure
 * seats the band at the lesser of its seat and the destination and its rest at the height, and
 * the layout reporter lays the page out under the seat – once per travel (`lib/pageBand.ts`).
 * Tabs closing and documents changing take their bands with them (`useBandTabs`).
 *
 * Its tenants: the default-browser state (`useDefaultBrowserBand`) and the crash-restore state
 * (`useCrashRestoreBand`). The strips across the frame's top that asked before them
 * (`DefaultBrowserBanner.tsx` in W8-M2, `CrashRestoreBanner.tsx` in W8-M3) retired here.
 */
export function PageBandHost({ state, ui }: Props): JSX.Element {
  useDefaultBrowserBand(state)
  useCrashRestoreBand(state)
  useBandTabs(state)
  const tab = activeTab(state)
  const front = tab?.id ?? null
  const foreign = tab !== null && isForeignTab(state, tab.id)
  const pageFullscreen = state.window.htmlFullscreenTabId !== null
  const windowFullscreen = state.window.fullscreen
  // The new tab page and the blank page welcome a state; every other internal address is a
  // chrome page for the band, whether the chrome draws it or a document does (`isPageTab` keeps
  // its own, narrower word for the frame).
  const empty = tab !== null && isEmptyTabUrl(tab.url)
  const chrome = tab !== null && !empty && isInternalUrl(tab.url)
  const ok = tab !== null && !chrome && !foreign && !windowFullscreen && !pageFullscreen
  const covered =
    ui.overlay !== 'none' ||
    ui.frameDialogsOpen > 0 ||
    ui.urlbar.open ||
    ui.capture !== null ||
    ui.stageActive
  const offers = tab !== null && !empty && !isPrivateTab(tab)
  const scene = [
    front ?? '',
    pageFullscreen ? 'page-fullscreen' : '',
    windowFullscreen ? 'fullscreen' : '',
    foreign ? 'foreign' : ''
  ].join(':')
  // Before the paint, so a cut lands in the frame the page changed in.
  useLayoutEffect(() => {
    setBandFrame({ front, scene, ok, offers, covered })
  }, [front, scene, ok, offers, covered])
  const host = useMemo<BandHost>(
    () => ({
      translate: movePage,
      rest: seatBand,
      depart: (to) => seatBand(Math.min(bandSeat(), to))
    }),
    []
  )
  return <PageEdgeBand host={host} />
}
