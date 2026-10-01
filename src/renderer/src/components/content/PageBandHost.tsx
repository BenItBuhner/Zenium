import type { JSX } from 'react'
import { useLayoutEffect, useMemo } from 'react'
import type { UIState } from '@shared/types'
import { isBandPageUrl, setBandFrame } from '@renderer/lib/band'
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
 * a band may stand on it at all (§3.2, §10: the frame is a tab's – not the empty frame, not a
 * page shown in another window, not a fullscreen; a STATE – the default browser, offline, a
 * crash to restore – stands wherever a tab is in the frame, the new tab page and the chrome
 * pages included, as the strip it retired stood on the new tab page); whether offers may (§3.2,
 * §10: on a page of the web alone – `isBandPageUrl`, the Design Lead's allow-list: `http:`,
 * `https:`, `file:`, `chrome-extension:` – and never on a private tab); and what covers the
 * page – a chrome overlay, a frame dialog, the URL bar, Web capture, the gesture stage – under
 * which a prompt arriving waits and one standing stays (the frame dialog host's scrim dims it
 * with the page's picture). It fills the band's seam for this host: the page's offset goes to
 * the core per frame, which moves the placed views' bounds (`layout.pageOffset`, a move, never a
 * resize), and – the same number, from the same store – to the layer a page the chrome draws
 * itself rides on (`PageBandLayer`); a travel's departure seats the band at the lesser of its
 * seat and the destination and its rest at the height, and the layout reporter lays the page
 * out under the seat – once per travel (`lib/pageBand.ts`). A drag announces no departure
 * (`BandSeam.depart`): its first frame below the seat unseats the band, so the page – laid out
 * full-frame once, translated from there – keeps covering the frame under it as the mouse
 * takes it up, as Android's host unseats its layer (`lib/band/androidHost.ts`; the Design
 * Lead's ruling on W8-M2b: the two hosts the same, never a bare strip under a dragged band).
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
  const ok = tab !== null && !foreign && !windowFullscreen && !pageFullscreen
  const covered =
    ui.overlay !== 'none' ||
    ui.frameDialogsOpen > 0 ||
    ui.urlbar.open ||
    ui.capture !== null ||
    ui.stageActive
  const offers = tab !== null && !isPrivateTab(tab) && isBandPageUrl(tab.url)
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
  const host = useMemo<BandHost>(() => {
    /** A `depart` was heard and no `rest` yet: the frames are a travel's, not a drag's. */
    let travelling = false
    return {
      translate: (x) => {
        // A frame below the seat with no travel announced is a drag's: the band is unseated
        // for it – the one relayout the drag costs, the page full-frame and moved by the offset
        // from here on – so the page keeps covering the frame under it instead of riding up
        // seated and baring a strip. A frame at or past the seat (a drag pulling the band down
        // to its rest) leaves the seat as it is; a travel's frames below it (a spring's
        // undershoot) were seated for by `depart`.
        if (!travelling && x < bandSeat()) seatBand(0)
        movePage(x)
      },
      rest: (height) => {
        travelling = false
        seatBand(height)
      },
      depart: (to) => {
        travelling = true
        seatBand(Math.min(bandSeat(), to))
      }
    }
  }, [])
  return <PageEdgeBand host={host} />
}
