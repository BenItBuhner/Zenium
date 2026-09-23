import type { ContentCover, Rect, ThumbnailPicture } from '@shared/types'
import type { NativeBridge, NativeCall, NativeCommand } from './bridge'
import type { BootInfo } from './platform'
import type { Platform } from '@shared/types'
import type { VoiceEvent, VoiceStartOutcome } from '@shared/voice'
import type { QrEvent, QrStartOutcome } from '@shared/qrScan'
import { PDF_VIEWER_ASSETS, pdfViewerAssetUrl, pdfViewerDocumentUrl } from '@shared/pdfPage'
import { pdfReportOf, pdfReportTokenOf } from '@shared/pdfViewerProtocol'
import {
  blocksFromHtml,
  type ReadAloudExtractRequest,
  type ReadAloudExtraction,
  type ReadAloudVoice
} from '@shared/readAloud'
import type { RawArticle } from '@core/reader'
import { extensionPageOf } from '@shared/url'
import { previewRangeAnswer } from './previewRange'
import { createPreviewDownloads } from './previewDownloads'
import { createPreviewScreenshots } from './previewScreenshots'
import { previewPdfVariantOf } from './previewPdf'
import {
  PREVIEW_SITE_DATA_EVENT,
  previewCookies,
  previewOrigins,
  type PreviewSiteDataOrigins
} from './previewSiteData'
import { emulateTextZoom } from './previewTextZoom'
import { CHUNK_CHARS } from './storeIo'
import { isProbablyUrl } from '@shared/url'

interface HostGlobal {
  resolve(id: number, json: string | null): void
  reject(id: number, message: string): void
  viewEvent(tabId: string, name: string, json: string): void
  hostEvent(name: string, json: string): void
}

const STORAGE_PREFIX = 'zen-preview:'
/** How long a reload takes to begin in this stand-in host (see `view.reload`). */
const RELOAD_DELAY_MS = 3000
/** Where the dev server keeps the documents `view.loadHtml` shows (see `vite.android.config.ts`). */
const PAGE_ROUTE = '/__zen/page/'
/** Where the dev server serves the PDF viewer's files and its sample documents (`vite.android.config.ts`). */
const PDF_ROUTE = '/__zen/pdf/'
/** The viewer document's script, as the dev server serves it (a module under the Vite root, `src/android`). */
const PDF_VIEWER_SCRIPT = '/pdfViewer.ts'
/**
 * Whether the preview "holds the browser role" (outside the file store: it is not profile data);
 * `sheet=promo` (previewStates.ts) puts the role up for grabs before it raises the campaign.
 */
export const DEFAULT_BROWSER_KEY = 'zen-preview-default-browser'
/** Where the stand-in downloader says files go (`BootInfo.downloadsDir`). */
const DOWNLOADS_DIR = '/Downloads'
/** Where the stand-in keeps the tab cards' pictures (Kotlin: `cacheDir/zen-thumbs/<tabId>.jpg`). */
const THUMB_PREFIX = 'zen-thumb:'
/** Kotlin's `Thumbnails.FRESH_MS`: a picture younger than this stands, no second one is taken. */
const CARD_FRESH_MS = 2000

const hostGlobal = (): HostGlobal => (window as unknown as { __zenHost: HostGlobal }).__zenHost

/** Demo images the dev server serves straight from the source tree (never part of a build). */
const previewAsset = (name: string): string => `${location.origin}/preview-assets/webapp/${name}`
/** The dev server's relay for `net.fetch` (`previewFetch` in vite.android.config.ts). */
const PREVIEW_FETCH_ROUTE = '/__zen/fetch'

/**
 * Raised on `window` by a `urlbar=` preview state's `clip=<text>`: the stand-in clipboard takes
 * the detail (a string; empty clears it), so the omnibox's clipboard row can be captured without
 * a copy first.
 */
export const PREVIEW_CLIP_EVENT = 'zen-preview-clip'

/**
 * A `CustomEvent` on `window` whose detail is a tab id: that tab's next load is deliberately
 * unhurried, as `view.reload` always is – the page it is leaving stays on screen for
 * `RELOAD_DELAY_MS` before the new one arrives, like a load over a connection that has only just
 * come back. The `network=reloading` preview state sends it so a still can catch the offline
 * error page in its own Reloading state (ERR-06) instead of the page that replaces it at once.
 */
export const PREVIEW_SLOW_LOAD_EVENT = 'zen-preview-slow-load'

/**
 * A `CustomEvent` on `window`: every load this host is still holding back (PREVIEW_SLOW_LOAD_EVENT)
 * lands now. The preview states send it as they reset, so the next state starts on the page and
 * not on the one a held load was leaving.
 */
export const PREVIEW_SETTLE_LOADS_EVENT = 'zen-preview-settle-loads'

/**
 * The web app the preview's pages can "declare": a cross-origin iframe cannot post its own
 * manifest, so the preview states post this one for the active tab the way a page script would
 * (`postPreviewManifest`). Written against `https://example.com/`, the tab the default profile
 * opens on, with a vector icon for the chrome and a raster maskable one for the launcher.
 */
export const PREVIEW_WEB_APP = {
  manifestUrl: 'https://example.com/app/manifest.webmanifest',
  manifest: {
    id: '/app/',
    name: 'Sketch Studio',
    short_name: 'Sketch',
    description:
      'Draw, ink and colour on an endless canvas. Sketches sync between your devices and open offline.',
    start_url: '/app/',
    scope: '/',
    display: 'standalone',
    theme_color: '#2f6f8f',
    background_color: '#e8f1f5',
    icons: [
      { src: previewAsset('icon.svg'), sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      {
        src: previewAsset('icon-192.png'),
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable'
      }
    ],
    screenshots: [
      {
        src: previewAsset('shot-canvas.svg'),
        sizes: '540x1080',
        type: 'image/svg+xml',
        form_factor: 'narrow',
        label: 'An ink sketch on the canvas'
      },
      {
        src: previewAsset('shot-colours.svg'),
        sizes: '540x1080',
        type: 'image/svg+xml',
        form_factor: 'narrow',
        label: 'The colour palette'
      },
      {
        src: previewAsset('shot-gallery.svg'),
        sizes: '540x1080',
        type: 'image/svg+xml',
        form_factor: 'narrow',
        label: 'The sketch gallery'
      }
    ]
  }
}

/**
 * Post a manifest for `tabId` as its page script would: the demo app's, or none (an empty
 * manifest describes no app) so the tab is a plain page again.
 */
export function postPreviewManifest(tabId: string, app: boolean): void {
  hostGlobal().viewEvent(
    tabId,
    'pageMessage',
    JSON.stringify({
      type: 'webapp',
      webapp: 'manifest',
      manifestUrl: PREVIEW_WEB_APP.manifestUrl,
      manifest: app ? PREVIEW_WEB_APP.manifest : {}
    })
  )
}

/**
 * A stand-in for the Kotlin host so the Android chrome can run in an ordinary desktop browser
 * (`npm run dev:android`): tab views are `<iframe>`s stacked above the chrome, persistence goes
 * to `localStorage`, dialogs use `window.confirm`, downloads are played back by
 * `previewDownloads.ts`. Handy for developing the mobile layout with DevTools' device emulation;
 * not a browser you would want to use.
 */
export function createPreviewBridge(): NativeBridge {
  const host = hostGlobal
  const views = new Map<string, HTMLIFrameElement>()
  const density = 1
  /**
   * What clips each page's frame: how far a pull has moved it down, the covered strips, and the
   * strip the hiding bar has not yet left (`bar`, from the frame's bottom, see `chrome.setBarHide`).
   */
  interface Clip {
    pull: number
    cover: ContentCover
    bar: number
  }
  const clips = new Map<string, Clip>()
  const clipOf = (tabId: string): Clip => {
    let clip = clips.get(tabId)
    if (!clip) clips.set(tabId, (clip = { pull: 0, cover: { top: 0, bottom: 0 }, bar: 0 }))
    return clip
  }
  // Like Kotlin's outline: the page shows between the strips, and no lower than the frame's
  // bottom edge while a pull holds it down.
  const applyClip = (frame: HTMLIFrameElement, clip: Clip): void => {
    const radius = frame.style.borderRadius || '0px'
    const bottom = Math.max(clip.cover.bottom, clip.pull, clip.bar)
    frame.style.clipPath =
      clip.cover.top > 0 || bottom > 0
        ? `inset(${clip.cover.top}px 0 ${bottom}px 0 round ${radius})`
        : `inset(0 round ${radius})`
  }
  /** The frame each page was last laid out at (CSS px), what `chrome.setBarHide` works from. */
  const reported = new Map<string, Rect>()
  /** Where the bar that hides on scroll is, for every page (null: it may not hide). */
  let barHide: {
    edge: 'top' | 'bottom'
    offset: number
    travel: number
    shownEdge: number
    tall: boolean
  } | null = null
  /**
   * Like `TabHost.place`: the page's edge on the bar's side follows the bar. The chrome's content
   * column is laid out short (the bar's band free, `S`) or, once the bar is hidden and at rest,
   * tall into the band (`H`), and its report can trail the bar by a frame either way, so which
   * one it is in is read off the frame's `shownEdge`. At either rest the layout is the chrome's
   * own; while the frame says `tall` – from the hide's first frame to the shown rest, not the
   * frame the bar arrives home (§11.5) – the page is laid out tall and clipped to what the bar
   * has left: docked at the bottom it grows into the band under the clip, docked at the top it
   * is slid up with the bar (its content moves with the bar, the page holds still under the
   * finger) and clipped at the frame's bottom edge.
   */
  const applyFrame = (tabId: string): void => {
    const frame = views.get(tabId)
    const r = reported.get(tabId)
    if (!frame || !r) return
    const clip = clipOf(tabId)
    let top = r.y
    let bottom = r.y + r.height
    let shift = 0
    clip.bar = 0
    if (barHide) {
      const { edge, offset: o, travel: t, shownEdge, tall } = barHide
      if (edge === 'top') {
        const shownTop = Math.abs(r.y - shownEdge) <= Math.abs(r.y + t - shownEdge) ? r.y : r.y + t
        if (!tall) top = shownTop
        else if (o < t) {
          top = shownTop
          bottom = r.y + r.height + t
          shift = -o
          clip.bar = t - o
        } else top = shownTop - t
      } else {
        const rb = r.y + r.height
        const shownBottom = Math.abs(rb - shownEdge) <= Math.abs(rb - t - shownEdge) ? rb : rb - t
        bottom = tall ? shownBottom + t : shownBottom
        if (tall && o < t) clip.bar = t - o
      }
    }
    frame.style.left = `${r.x / density}px`
    frame.style.top = `${top / density}px`
    frame.style.width = `${r.width / density}px`
    frame.style.height = `${(bottom - top) / density}px`
    const y = clip.pull + shift
    frame.style.transform = y !== 0 ? `translate3d(0, ${y}px, 0)` : ''
    applyClip(frame, clip)
  }

  const files: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(STORAGE_PREFIX))
      files[key.slice(STORAGE_PREFIX.length)] = localStorage.getItem(key) ?? ''
  }

  const viewEvent = (tabId: string, name: string, payload: unknown): void =>
    host().viewEvent(tabId, name, JSON.stringify(payload ?? null))

  /**
   * Each page's back/forward list, the WebView's stood in for: a load commits an entry (the
   * entries ahead of it go, as a WebView's do), `view.back` / `view.forward` step along it and
   * show that entry's document again, and the chrome's Back and Forward read their state off
   * it. A frame is cross-origin, so its own history is not readable; `src` is what the frame
   * was pointed at for the entry (a `zen://` page's served copy), set once it is known.
   */
  interface NavEntry {
    url: string
    src: string | null
  }
  const navLists = new Map<string, { entries: NavEntry[]; index: number }>()
  const navOf = (tabId: string): { entries: NavEntry[]; index: number } => {
    let nav = navLists.get(tabId)
    if (!nav) navLists.set(tabId, (nav = { entries: [], index: -1 }))
    return nav
  }
  /** A load of `url` begins: it is the list's newest entry unless the page is already on it. */
  const commitEntry = (tabId: string, url: string): NavEntry => {
    const nav = navOf(tabId)
    const current = nav.entries[nav.index]
    if (current && current.url === url) return current
    nav.entries.splice(nav.index + 1)
    const entry: NavEntry = { url, src: null }
    nav.entries.push(entry)
    nav.index = nav.entries.length - 1
    return entry
  }
  const currentEntry = (tabId: string): NavEntry | undefined => {
    const nav = navLists.get(tabId)
    return nav?.entries[nav.index]
  }
  /** The pending slow reload of each page (`view.reload`), for `view.stop` to call off. */
  const reloads = new Map<string, number>()

  const navState = (frame: HTMLIFrameElement): Record<string, unknown> => {
    const nav = navLists.get(frame.dataset.tabId ?? '')
    return {
      url: frame.dataset.url ?? '',
      title: frame.dataset.title ?? '',
      canGoBack: nav !== undefined && nav.index > 0,
      canGoForward: nav !== undefined && nav.index < nav.entries.length - 1
    }
  }

  /** Back (`delta` -1) or Forward (+1) along the page's list: that entry's document shows again. */
  const travel = (tabId: string, delta: -1 | 1): void => {
    const frame = views.get(tabId)
    const nav = navLists.get(tabId)
    if (!frame || !nav) return
    const entry = nav.entries[nav.index + delta]
    if (!entry) return
    nav.index += delta
    frame.dataset.url = entry.url
    frame.dataset.title = ''
    frame.dataset.load = ''
    cardTakenAt.delete(tabId)
    const pendingReload = reloads.get(tabId)
    if (pendingReload !== undefined) window.clearTimeout(pendingReload)
    reloads.delete(tabId)
    viewEvent(tabId, 'startLoading', null)
    viewEvent(tabId, 'navigated', { ...navState(frame), inPage: false })
    // A document that never landed has nothing to show again: the entry is reported as loaded.
    if (entry.src) frame.src = entry.src
    else viewEvent(tabId, 'stopLoading', navState(frame))
  }

  let pageSerial = 0
  /**
   * Shows `html` in the frame as a document of its own, served by the dev server, the way the
   * WebView's `loadDataWithBaseURL` shows it. As `srcdoc` the document would inherit the chrome's
   * Content Security Policy (`script-src 'self'`), which blocks the inline script and handlers a
   * zen:// page runs (the error page's theme and Reload among them). A load that began after this
   * one owns the frame.
   */
  const showDocument = async (
    frame: HTMLIFrameElement,
    html: string,
    entry: NavEntry | null = null
  ): Promise<void> => {
    const id = String(++pageSerial)
    frame.dataset.load = id
    const stored = await fetch(PAGE_ROUTE + id, { method: 'PUT', body: html })
    if (!stored.ok || frame.dataset.load !== id) return
    frame.src = PAGE_ROUTE + id
    if (entry) entry.src = frame.src
  }

  /**
   * The PDF viewer page (`zen://pdf`, `shared/pdfPage.ts`) as this host can show it: Kotlin loads
   * the shell on the viewer's origin and answers its requests itself; here the shell's URLs are
   * pointed at the dev server instead – the viewer's script as the module Vite serves, pdf.js's
   * worker and data from the package, and the sample document behind the download's file name
   * (`previewPdf.ts`) – and a relay is written into it that hands the viewer's reports (posted on
   * its own window, which the page script would relay on a device) up to this host, which
   * forwards them as the `pdf` page message the core listens for.
   */
  const pdfDocumentHtml = (html: string, path: string): string => {
    const origin = location.origin
    const variant = previewPdfVariantOf(path) ?? 'sample'
    const relay = `<script>window.addEventListener('message',function(e){if(e.source===window&&e.data&&typeof e.data==='object'&&'zeniumPdf' in e.data)parent.postMessage(e.data,${JSON.stringify(origin)})})</script>`
    return html
      .split(pdfViewerAssetUrl(PDF_VIEWER_ASSETS.script))
      .join(PDF_VIEWER_SCRIPT)
      .split(pdfViewerAssetUrl(PDF_VIEWER_ASSETS.worker))
      .join(`${origin}${PDF_ROUTE}viewer/${PDF_VIEWER_ASSETS.worker}`)
      .split(pdfViewerDocumentUrl())
      .join(`${origin}${PDF_ROUTE}document/${variant}`)
      .replace('</head>', `${relay}</head>`)
  }

  // A viewer document's report, relayed by the script above with the document's token: the tab
  // is the frame it came from.
  window.addEventListener('message', (e: MessageEvent<unknown>) => {
    if (e.origin !== location.origin) return
    const report = pdfReportOf(e.data)
    if (!report) return
    const pdfToken = pdfReportTokenOf(e.data) ?? undefined
    for (const [tabId, frame] of views) {
      if (frame.contentWindow === e.source) {
        viewEvent(tabId, 'pageMessage', { type: 'pdf', pdf: report, pdfToken })
        return
      }
    }
  })

  const params = new URLSearchParams(location.search)
  // `?sdk=32` stands in for an older release (below 33 the chrome confirms copies itself).
  const sdkInt = Number(params.get('sdk')) || 34
  // `?fontScale=1.3` stands in for the system font size (`Configuration.fontScale`): the
  // chrome's text is drawn at that zoom the way the Kotlin host's `textZoom` draws it
  // (`previewTextZoom.ts` multiplies the stylesheets' font sizes, a desktop browser having no
  // text zoom of its own) and the environment reports the factor, so the line boxes follow.
  // `?textZoom=1.8` names a factor other than the setting (Android 14 scales 15 sp by 1.8 at the
  // 2.0 setting); `?boldText=1` is the bold-text setting (a weight adjustment of 300).
  const fontScale = Number(params.get('fontScale')) || 1
  const textZoom = Number(params.get('textZoom')) || fontScale
  const fontWeightAdjustment = params.get('boldText') === '1' ? 300 : 0
  emulateTextZoom(textZoom)
  // `?platform=linux|win32|darwin` makes the chrome report a desktop OS, so a capture taken at
  // the desktop form factor shows the desktop's platform-bound rows (the Default Browser
  // section, file URLs, the engine's name) rather than Android's. Capabilities stay the
  // preview's own; a real desktop capture comes from the Electron build.
  const platformParam = params.get('platform')
  const os: Platform =
    platformParam === 'linux' || platformParam === 'win32' || platformParam === 'darwin'
      ? platformParam
      : 'android'
  // `?vault=none` stands in for a device without a screen lock: no Keystore key and no
  // BiometricPrompt, so the password manager takes its passphrase route (setup gate, prompt
  // sheet). `?vault=locked` is a device whose credential sheet the user keeps dismissing (the
  // key never unwraps). Otherwise a stand-in keystore wraps the vault key and every
  // verification passes.
  const vaultMode = params.get('vault') ?? 'os'
  const PREVIEW_BLOB = 'preview-keystore:'
  // `?voice=<script>` picks what the stand-in recogniser does (`previewVoiceScript`): the mic
  // buttons show, and a start plays the script's events back to the chrome's listening sheet.
  // A preview state (`voice=<script>`, previewStates.ts) changes the script at run time.
  let voiceScript = params.get('voice') ?? 'heard'
  window.addEventListener(PREVIEW_VOICE_EVENT, (e) => {
    voiceScript = (e as CustomEvent<string>).detail
  })
  // `sitedata=` (previewStates.ts) names the sample the site-data stand-ins answer from; the
  // origins a state's Clear took out stay out until the next sample is named.
  let siteDataSample: PreviewSiteDataOrigins = 'none'
  const clearedOrigins = new Set<string>()
  window.addEventListener(PREVIEW_SITE_DATA_EVENT, (e) => {
    siteDataSample = (e as CustomEvent<PreviewSiteDataOrigins>).detail
    clearedOrigins.clear()
  })
  let voiceRun = 0
  const voice = {
    start: (): VoiceStartOutcome => {
      const script = previewVoiceScript(voiceScript)
      if (script.outcome !== 'listening') return script.outcome
      const run = ++voiceRun
      let at = 0
      for (const [delay, event] of script.events) {
        at += delay
        window.setTimeout(() => {
          if (voiceRun === run) hostGlobal().hostEvent('voice.event', JSON.stringify(event))
        }, at)
      }
      return 'listening'
    },
    cancel: (): void => {
      voiceRun++
    }
  }
  // The stand-in text-to-speech engine behind the core's `SpeechHost` (`speech.*`): the voices
  // are PREVIEW_VOICES, and an utterance "plays" as timed events – `start`, one `word` per word
  // at the rate's pace, `end` – so the read-aloud player's controls work here as they do on a
  // device (the pause is a stop; play speaks the sentence again). `stop` silences the run. The
  // script (`?readAloud=<status>`, or a preview state's PREVIEW_READ_ALOUD_EVENT) bends the
  // engine towards a state a still needs: `loading` never lists its voices (the core waits on
  // them, the player's busy state), `error` lists none (the core's `no-voice` once its grace for
  // a late list has run out), `ended` ends every utterance at once (the core walks to the text's
  // end). A script change is a voices change to the core (`speech.voicesChanged`), so the list
  // it cached from the last state is dropped and the next start asks the engine again.
  let readAloudScript = params.get('readAloud') ?? 'playing'
  const voicesChanged = (): void => hostGlobal().hostEvent('speech.voicesChanged', 'null')
  window.addEventListener(PREVIEW_READ_ALOUD_EVENT, (e) => {
    readAloudScript = (e as CustomEvent<string>).detail
    voicesChanged()
  })
  let speechRun = 0
  const speech = {
    voices: (): Promise<ReadAloudVoice[]> => {
      if (readAloudScript === 'loading') return new Promise<ReadAloudVoice[]>(() => undefined)
      // `error`: an engine with no voice at all. The core waits its grace for a late list (a
      // real engine still binding) and lands on `no-voice`; the stand-in says nothing more – a
      // `voicesChanged` after the failure would restart the session on its own (the core's
      // late-voices retry), and an empty one inside the grace only makes the core ask again.
      if (readAloudScript === 'error') return Promise.resolve([])
      return Promise.resolve(PREVIEW_VOICES)
    },
    speak: (utteranceId: string, text: string, rate: number, queue: 'flush' | 'add'): void => {
      // No queue in the stand-in: the next utterance goes when it is asked for.
      if (queue === 'add') return
      const run = ++speechRun
      const emit = (event: Record<string, unknown>): void => {
        if (speechRun === run)
          hostGlobal().hostEvent('speech.event', JSON.stringify({ utteranceId, ...event }))
      }
      let at = 80
      window.setTimeout(() => emit({ type: 'start' }), at)
      if (readAloudScript === 'ended') {
        window.setTimeout(() => emit({ type: 'end' }), at + 40)
        return
      }
      const pace = 280 / Math.max(0.5, Math.min(4, rate || 1))
      for (const match of text.matchAll(/\S+/g)) {
        at += pace
        const charIndex = match.index ?? 0
        const length = match[0].length
        window.setTimeout(() => emit({ type: 'word', charIndex, length }), at)
      }
      window.setTimeout(() => emit({ type: 'end' }), at + pace)
    },
    stop: (): void => {
      speechRun++
    }
  }
  // The stand-in page's answer to the core's `readAloud.extract` (the real page script's, on a
  // device): the stand-in article as blocks, a frame later, each placed at a path the stand-in
  // never resolves (the highlight is the page script's paint; the chrome shows none here).
  const answerReadAloudExtract = (tabId: string, message: unknown): boolean => {
    const request = message as Partial<ReadAloudExtractRequest> | null
    if (!request || request.type !== 'readAloud' || request.action !== 'extract') return false
    const requestId = request.requestId
    if (typeof requestId !== 'string') return false
    window.setTimeout(() => {
      const lang = PREVIEW_ARTICLE.lang ?? 'en'
      const extraction: ReadAloudExtraction = {
        requestId,
        title: PREVIEW_ARTICLE.title ?? '',
        lang,
        blocks: blocksFromHtml(PREVIEW_ARTICLE.content ?? '', lang).map((block, index) => ({
          ...block,
          at: { path: [1, index], run: 0, offset: 0 }
        }))
      }
      viewEvent(tabId, 'pageMessage', { type: 'readAloud', readAloud: extraction })
    }, 40)
    return true
  }
  // `?qr=<script>` picks what the stand-in camera does (`previewQrScript`): the camera buttons
  // show, and a start plays the script's events back to the chrome's scan sheet – a drawn still
  // stands in for the live preview, which only a device can lay over the sheet. A preview state
  // (`qr=<script>`, previewStates.ts) changes the script at run time.
  let qrScript = params.get('qr') ?? 'url'
  window.addEventListener(PREVIEW_QR_EVENT, (e) => {
    qrScript = (e as CustomEvent<string>).detail
  })
  let qrRun = 0
  let qrTorch = false
  const qr = {
    start: (): QrStartOutcome => {
      const script = previewQrScript(qrScript)
      if (script.outcome !== 'scanning') return script.outcome
      const run = ++qrRun
      qrTorch = false
      let at = 0
      for (const [delay, event] of script.events) {
        at += delay
        window.setTimeout(() => {
          if (qrRun === run) hostGlobal().hostEvent('qr.event', JSON.stringify(event))
        }, at)
      }
      return 'scanning'
    },
    cancel: (): void => {
      qrRun++
    },
    setTorch: (on: boolean): void => {
      qrTorch = on
      const run = qrRun
      window.setTimeout(() => {
        if (qrRun === run)
          hostGlobal().hostEvent('qr.event', JSON.stringify({ kind: 'torch', on: qrTorch }))
      }, 80)
    }
  }

  // An extension's page a preview state opens as a tab (`extension-page=<id>/<path>`): the
  // runtime that would serve it from the emulated origin is not here, so the host shows a
  // stand-in options page for it, titled as the state announced (`PREVIEW_EXTENSION_PAGE_EVENT`).
  const extensionPages = new Map<string, PreviewExtensionPage>()
  window.addEventListener(PREVIEW_EXTENSION_PAGE_EVENT, (e) => {
    const page = (e as CustomEvent<PreviewExtensionPage>).detail
    extensionPages.set(page.url, page)
  })

  let pieceSeq = 0
  const pieceWrites = new Map<number, { name: string; parts: string[] }>()
  const pieceReads = new Map<number, { text: string; at: number }>()
  // The stand-in clipboard behind the URL bar's clipboard row: what the chrome copied, or
  // `?clip=<text>` seeded for the stills (a `urlbar=` preview state's `clip=` re-seeds it through
  // PREVIEW_CLIP_EVENT). The peek tells a link from text as the core would.
  let previewClip = params.get('clip') ?? ''
  /** The clip the user opened through the row (`clipboard.markUsed`): not offered again. */
  let previewClipUsed = ''
  window.addEventListener(PREVIEW_CLIP_EVENT, (e) => {
    previewClip = String((e as CustomEvent<unknown>).detail ?? '')
  })
  /** Tabs whose next load takes `RELOAD_DELAY_MS` to arrive (PREVIEW_SLOW_LOAD_EVENT). */
  const slowLoads = new Set<string>()
  window.addEventListener(PREVIEW_SLOW_LOAD_EVENT, (e) => {
    slowLoads.add(String((e as CustomEvent<unknown>).detail ?? ''))
  })
  /** The loads held back and still on their way, by tab id: how each lands (PREVIEW_SETTLE_LOADS_EVENT). */
  const heldLoads = new Map<string, () => void>()
  window.addEventListener(PREVIEW_SETTLE_LOADS_EVENT, () => {
    for (const land of [...heldLoads.values()]) land()
  })

  const handlers: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> = {
    boot: (): BootInfo => ({
      version: 'preview',
      os,
      sdkInt,
      signer: null,
      packageName: null,
      profiles: true,
      pinShortcuts: true,
      voiceSearch: true,
      qrScan: true,
      readAloud: true,
      files,
      downloadsDir: DOWNLOADS_DIR,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      fullscreen: false,
      // A screen lock as the vault has one: `vault=none` is a device without (the lock switch
      // disabled, SET-17); a spec's `screenlock=` overrides it (previewStates.ts).
      screenLock: vaultMode !== 'none',
      environment: {
        largeScreen: false,
        pointerAndKeyboard: false,
        fontScale,
        textZoom,
        fontWeightAdjustment
      }
    }),
    'storage.write': ({ name, text }) =>
      localStorage.setItem(STORAGE_PREFIX + String(name), String(text)),
    'storage.writeSync': ({ name, text }) => {
      localStorage.setItem(STORAGE_PREFIX + String(name), String(text))
      // Landed (the Kotlin host answers the same; the store's mirror follows only then).
      return true
    },
    // The text whole up to the piece size, a bigger document as { token } for storage.readChunk.
    'storage.read': ({ name }) => {
      const text = localStorage.getItem(STORAGE_PREFIX + String(name))
      if (text === null || text.length <= CHUNK_CHARS) return text
      const token = ++pieceSeq
      pieceReads.set(token, { text, at: 0 })
      return { token }
    },
    'storage.exists': ({ name }) => localStorage.getItem(STORAGE_PREFIX + String(name)) !== null,
    'storage.remove': ({ name }) => localStorage.removeItem(STORAGE_PREFIX + String(name)),
    // Documents in pieces (`AndroidStoreIO`): the same protocol as Kotlin's Storage, over localStorage.
    'storage.writeBegin': ({ name }) => {
      const token = ++pieceSeq
      pieceWrites.set(token, { name: String(name), parts: [] })
      return token
    },
    'storage.writeChunk': ({ token, text }) => {
      const write = pieceWrites.get(Number(token))
      if (!write) throw new Error(`no write ${String(token)}`)
      write.parts.push(String(text))
      return true
    },
    'storage.writeEnd': ({ token }) => {
      const write = pieceWrites.get(Number(token))
      if (!write) throw new Error(`no write ${String(token)}`)
      pieceWrites.delete(Number(token))
      localStorage.setItem(STORAGE_PREFIX + write.name, write.parts.join(''))
      return true
    },
    'storage.writeAbort': ({ token }) => {
      pieceWrites.delete(Number(token))
      return null
    },
    'storage.readChunk': ({ token, maxChars }) => {
      const read = pieceReads.get(Number(token))
      if (!read || read.at >= read.text.length) {
        pieceReads.delete(Number(token))
        return null
      }
      const chunk = read.text.slice(read.at, read.at + Math.max(1, Number(maxChars) || 1))
      read.at += chunk.length
      return chunk
    },
    'storage.readEnd': ({ token }) => {
      pieceReads.delete(Number(token))
      return null
    },
    // The preview has no request engine and ships no filter-list snapshot.
    'blocking.bundled': () => [],
    'blocking.install': () => null,
    // Nor a privacy host: the policy has nowhere to go and there is no Safe Browsing snapshot.
    'privacy.apply': () => null,
    'privacy.bundledFeed': () => null,
    'view.create': ({ tabId }) => {
      const frame = document.createElement('iframe')
      frame.className = 'zen-preview-view'
      frame.style.cssText =
        'position:fixed;left:0;top:0;width:0;height:0;border:0;background:#fff;visibility:hidden;z-index:50;'
      frame.dataset.tabId = String(tabId)
      frame.addEventListener('load', () => {
        let title = ''
        try {
          title = frame.contentDocument?.title ?? ''
        } catch {
          /* cross-origin */
        }
        frame.dataset.title = title
        // The document on screen is this URL's now (what a card picture may be taken of).
        frame.dataset.painted = frame.dataset.url ?? ''
        // The frame's document is complete: its DOM is ready, then it has finished loading.
        viewEvent(String(tabId), 'domReady', null)
        viewEvent(String(tabId), 'stopLoading', { ...navState(frame), title })
        if (title) viewEvent(String(tabId), 'title', { title })
      })
      document.body.appendChild(frame)
      views.set(String(tabId), frame)
    },
    'view.destroy': ({ tabId }) => {
      views.get(String(tabId))?.remove()
      views.delete(String(tabId))
      reported.delete(String(tabId))
      clips.delete(String(tabId))
      navLists.delete(String(tabId))
      const pendingReload = reloads.get(String(tabId))
      if (pendingReload !== undefined) window.clearTimeout(pendingReload)
      reloads.delete(String(tabId))
      heldLoads.delete(String(tabId))
      viewEvent(String(tabId), 'destroyed', null)
    },
    'view.load': ({ tabId, url }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      frame.dataset.url = String(url)
      frame.dataset.title = ''
      frame.dataset.load = ''
      // Whatever card picture there was is of the page before: the next hide takes a new one,
      // however fresh the last (Kotlin's `Thumbnails.stale`, BH-14).
      cardTakenAt.delete(String(tabId))
      viewEvent(String(tabId), 'startLoading', null)
      const entry = commitEntry(String(tabId), String(url))
      const show = (): void => {
        const extensionPage = extensionPageOf(String(url))
        if (extensionPage) {
          // What the runtime would serve; the frame reports the page loaded like any other.
          const page = extensionPages.get(extensionPage.url) ?? {
            url: extensionPage.url,
            name: extensionPage.id,
            title: ''
          }
          void showDocument(frame, extensionPageDocument(page), entry)
        } else if (String(url).startsWith(PREVIEW_SAMPLE_ORIGIN)) {
          // A page this host can picture (same-origin): the frame reports it loaded like any other.
          void showDocument(frame, samplePageDocument(), entry)
        } else {
          frame.src = String(url)
          entry.src = String(url)
        }
      }
      const pendingReload = reloads.get(String(tabId))
      if (pendingReload !== undefined) window.clearTimeout(pendingReload)
      reloads.delete(String(tabId))
      heldLoads.delete(String(tabId))
      if (slowLoads.delete(String(tabId))) {
        // Unhurried, as a reload is: the page on screen stays until the new one arrives – on
        // its own after the delay, or at once when the states settle the loads held back.
        const land = (): void => {
          const timer = reloads.get(String(tabId))
          if (timer !== undefined) window.clearTimeout(timer)
          reloads.delete(String(tabId))
          heldLoads.delete(String(tabId))
          show()
        }
        heldLoads.set(String(tabId), land)
        reloads.set(String(tabId), window.setTimeout(land, RELOAD_DELAY_MS))
      } else show()
      viewEvent(String(tabId), 'navigated', { ...navState(frame), inPage: false })
    },
    // Back and Forward step the stand-in list (`view.back` / `view.forward` on the host) and
    // show that entry's document again; the chrome hears the load begin and the new state.
    'view.back': ({ tabId }) => travel(String(tabId), -1),
    'view.forward': ({ tabId }) => travel(String(tabId), 1),
    // Stop calls off a slow reload still on its way and reports the page as loaded as it stands;
    // a frame's own load in flight cannot be halted from outside and finishes on its own.
    'view.stop': ({ tabId }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      const pendingReload = reloads.get(String(tabId))
      if (pendingReload !== undefined) window.clearTimeout(pendingReload)
      reloads.delete(String(tabId))
      heldLoads.delete(String(tabId))
      viewEvent(String(tabId), 'stopLoading', navState(frame))
    },
    'view.postMessage': ({ tabId, message }) => {
      answerReadAloudExtract(String(tabId), message)
    },
    // The launcher's dialog stands in for itself: a pin is accepted a moment later.
    'shortcut.pin': ({ id }) => {
      setTimeout(() => host().hostEvent('shortcut.pinned', JSON.stringify({ id })), 700)
      return true
    },
    'view.reload': ({ tabId }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      viewEvent(String(tabId), 'startLoading', null)
      // Deliberately unhurried, like a reload over a slow connection: what the chrome shows while
      // a page is loading (the pull-to-refresh disc spinning) stays up long enough to be looked at.
      const src = currentEntry(String(tabId))?.src ?? frame.dataset.url
      const pendingReload = reloads.get(String(tabId))
      if (pendingReload !== undefined) window.clearTimeout(pendingReload)
      heldLoads.delete(String(tabId))
      if (src)
        reloads.set(
          String(tabId),
          window.setTimeout(() => {
            reloads.delete(String(tabId))
            frame.src = src
          }, RELOAD_DELAY_MS)
        )
    },
    'view.loadHtml': ({ tabId, url, html, document }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      frame.dataset.url = String(url)
      cardTakenAt.delete(String(tabId))
      // A slow load or reload still on its way is superseded by this document.
      const pendingReload = reloads.get(String(tabId))
      if (pendingReload !== undefined) window.clearTimeout(pendingReload)
      reloads.delete(String(tabId))
      heldLoads.delete(String(tabId))
      // A PDF viewer page names the download's file (`views.ts` sends the document along for
      // Kotlin to serve); here that picks the sample document the dev server answers with.
      const pdf = document as { path?: unknown } | undefined
      const shown =
        pdf && typeof pdf.path === 'string' ? pdfDocumentHtml(String(html), pdf.path) : String(html)
      void showDocument(frame, shown, commitEntry(String(tabId), String(url)))
      viewEvent(String(tabId), 'navigated', { ...navState(frame), inPage: false })
    },
    'view.setBounds': ({ tabId, rect }) => {
      reported.set(String(tabId), rect as Rect)
      applyFrame(String(tabId))
    },
    // The bar that hides on scroll (`lib/barHide.ts`) says where it is: every page's edge on the
    // bar's side follows (Kotlin: `Host.setBarHide`).
    'chrome.setBarHide': (args) => {
      barHide =
        args.enabled === false
          ? null
          : {
              edge: args.edge === 'top' ? 'top' : 'bottom',
              offset: Number(args.offset) || 0,
              travel: Number(args.travel) || 0,
              shownEdge: Number(args.shownEdge) || 0,
              tall: args.tall === undefined ? (Number(args.offset) || 0) > 0 : args.tall === true
            }
      for (const tabId of views.keys()) applyFrame(tabId)
    },
    'view.setRadius': ({ tabId, radius }) => {
      const frame = views.get(String(tabId))
      if (frame) frame.style.borderRadius = `${Number(radius)}px`
    },
    // The page comes down off the frame's top edge by the pull's offset; like Kotlin, the bottom
    // is clipped so the page never overlaps the chrome below the frame.
    'view.setPullOffset': ({ tabId, offset }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      const y = Math.max(0, Number(offset))
      const clip = clipOf(String(tabId))
      clip.pull = y
      // The pull follows the finger per frame; nothing eases it.
      frame.style.transition = ''
      applyFrame(String(tabId))
    },
    'chrome.setPullToRefresh': () => undefined,
    // Chrome messages along the frame's edges: the page is clipped out of their strips, eased
    // the way Kotlin springs its clip; a clip-path keeps pointer events out of them too, so the
    // cards underneath can be tapped.
    'view.setCover': ({ tabId, cover }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      const clip = clipOf(String(tabId))
      clip.cover = cover as ContentCover
      frame.style.transition = clip.pull > 0 ? '' : 'clip-path 320ms cubic-bezier(0.2, 0, 0, 1)'
      applyClip(frame, clip)
    },
    // The Kotlin host reports the frame that carries the change as drawn (`view.drawn`, which
    // `lib/pageView.ts` times the swap between the live page and its picture by); here the flip
    // is on screen at the next frame, and the chrome hears so then rather than waiting out its
    // ack timeout with every sheet held a second.
    'view.setVisible': ({ tabId, visible }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      // Like Kotlin, a page on its way off the screen has its card picture taken first.
      if (!visible && frameShown(frame)) void captureCard(String(tabId), frame)
      // Hidden, not `display: none`: a GONE WebView keeps the size it was laid out at, and so
      // does the document in it – a command that lands while the chrome covers the page (the PDF
      // viewer's "go to page" as its sheet leaves) measures the pages, not a zero viewport.
      frame.style.visibility = visible ? 'visible' : 'hidden'
      requestAnimationFrame(() =>
        host().hostEvent('view.drawn', JSON.stringify({ tabId: String(tabId), visible }))
      )
    },
    'view.bringToFront': ({ tabId }) => {
      const frame = views.get(String(tabId))
      if (frame) document.body.appendChild(frame)
    },
    'view.setBackground': ({ tabId, color }) => {
      const frame = views.get(String(tabId))
      if (frame) frame.style.background = String(color)
    },
    'view.snapshot': ({ tabId }) => {
      const frame = views.get(String(tabId))
      if (!frame || !frameShown(frame)) return null
      // The cover's capture is the card's picture too (Kotlin derives it from the same copy).
      const capture = snapshotFrame(frame)
      void captureCard(String(tabId), frame, capture)
      return capture
    },
    // Tab card thumbnails (Kotlin's `Thumbnails.kt`): one picture per tab in `localStorage`,
    // read when the chrome shows the card, never with the boot payload.
    'thumbnail.configure': ({ width }) => {
      cardWidth = Number(width) || 0
    },
    // A picture is kept with the document it shows and read for that document alone (Kotlin
    // stamps the file): a tab that left the page gets nothing, whatever is under its id.
    'thumbnail.load': ({ tabId, url }) => {
      const stored = localStorage.getItem(THUMB_PREFIX + String(tabId))
      if (!stored) return null
      const record = JSON.parse(stored) as ThumbnailPicture & { url?: string }
      if (record.url !== String(url)) return null
      return { data: record.data, width: record.width, height: record.height }
    },
    // A drop names the document the tab left: a picture of another one (the next page's, captured
    // before the drop arrived) stays. A drop without one is a tab gone for good.
    'thumbnail.drop': ({ tabId, url }) => {
      const key = THUMB_PREFIX + String(tabId)
      if (url !== undefined) {
        const stored = localStorage.getItem(key)
        const of = stored ? (JSON.parse(stored) as { url?: string }).url : undefined
        if (of !== undefined && of !== String(url)) return
      }
      localStorage.removeItem(key)
    },
    'thumbnail.sweep': ({ keep }) => {
      const kept = new Set((keep as string[]).map(String))
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i)
        if (key?.startsWith(THUMB_PREFIX) && !kept.has(key.slice(THUMB_PREFIX.length)))
          localStorage.removeItem(key)
      }
    },
    // A document this host served itself (a zen:// page, the PDF viewer) is same-origin and runs
    // the code the way the WebView would; a live site's frame cannot be reached.
    'view.eval': ({ tabId, code }) => {
      const frame = views.get(String(tabId))
      let target: (Window & { eval(code: string): unknown }) | null = null
      try {
        const win = frame?.contentWindow ?? null
        // Reading the document of a cross-origin frame throws; a same-origin one answers.
        if (win && win.document) target = win as Window & { eval(code: string): unknown }
      } catch {
        target = null
      }
      if (!target) throw new Error('not available in the preview host')
      return target.eval(String(code))
    },
    // Page controls act inside the page WebViews; a cross-origin iframe offers no way in.
    'view.setZoom': () => undefined,
    'view.setDesktopMode': () => undefined,
    'view.setDarkening': () => undefined,
    'view.setPageRules': () => undefined,
    // Find in page: a same-origin frame is searched for real; a cross-origin one (any live site)
    // cannot be read, so it gets a stand-in count derived from the text (0 to 9 matches, so both
    // the found and the not-found states can be reached), enough for the find bar to lay out.
    'view.find': ({ tabId, text, forward, newSession }) => {
      const frame = views.get(String(tabId))
      if (!frame) return
      const result = findInFrame(frame, String(text), Boolean(forward), Boolean(newSession))
      viewEvent(String(tabId), 'found', { ...result, finalUpdate: true })
    },
    'view.stopFind': ({ tabId }) => {
      const frame = views.get(String(tabId))
      if (frame) finds.delete(frame)
    },
    'view.savePage': () => null,
    'view.screenshot': () => null,
    // The preview's frames are the browser's own: no page geometry or capture to read, no
    // Downloads collection to write (the capture UI's engine says so with null).
    'view.viewport': () => null,
    'download.saveFile': () => null,
    'view.certificate': () => null,
    // The preview has no cookie jar of its own to look into: without a `sitedata=` state the
    // sheet shows the connection only; with one, the sample it names (previewSiteData.ts) stands
    // for the profile – the viewer's origins and the active site's cookies – and a clear takes
    // the origin out of the sample, so a Clear in a still leaves the row gone.
    // A site whose cookies a state's Clear (or the never list's sweep) took out answers none,
    // as the engine's jar would.
    'site.cookies': ({ url }) => {
      let origin = ''
      try {
        origin = new URL(String(url)).origin
      } catch {
        // Not an origin: the sample answers as it stands.
      }
      return clearedOrigins.has(origin) ? [] : previewCookies(siteDataSample, String(url))
    },
    'site.storage': () => ({ usageBytes: null, quotaBytes: null, origins: [] }),
    'site.listOrigins': ({ containerId }) =>
      previewOrigins(siteDataSample, String(containerId)).filter(
        (row) => !clearedOrigins.has(row.origin)
      ),
    'site.clearCookies': ({ url }) => {
      const removed = previewCookies(siteDataSample, String(url)).length
      try {
        clearedOrigins.add(new URL(String(url)).origin)
      } catch {
        // Not an origin: nothing to take out of the sample.
      }
      return { removed, remaining: 0 }
    },
    'site.clearStorage': ({ origins }) => {
      for (const origin of Array.isArray(origins) ? origins : []) clearedOrigins.add(String(origin))
      return { ok: true, scope: 'origins' }
    },
    'dialog.confirm': ({ message, detail }) => window.confirm(`${message}\n\n${detail ?? ''}`),
    'dialog.openText': ({ extensions }) =>
      new Promise<Array<{ name: string; text: string }>>((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        const exts = Array.isArray(extensions) ? extensions.map((e) => `.${String(e)}`) : []
        if (exts.length) input.accept = exts.join(',')
        input.onchange = async () => {
          const files = [...(input.files ?? [])]
          resolve(
            await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })))
          )
        }
        input.oncancel = () => resolve([])
        input.click()
      }),
    'dialog.saveText': ({ defaultName, mimeType, text }) => {
      const blob = new Blob([String(text)], { type: String(mimeType) })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = String(defaultName)
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      return true
    },
    // The OS media controls and the pages' notifications (MediaSessions.kt, WebNotifications.kt,
    // PrivateSession.kt) have no stand-in on the desktop: the session is taken, nothing shows.
    'media.update': () => undefined,
    'media.pip': () => false,
    'notification.show': () => true,
    'notification.close': () => undefined,
    'notification.forgetOrigin': () => undefined,
    'notification.ensureAllowed': () => true,
    'private.setOpenTabs': () => undefined,
    // The private tabs' lock (PrivateLock.kt) is the host's; the preview keeps none of its own –
    // a spec's `lock=on` puts the cover up through the chrome's store (previewStates.ts) – so the
    // switch's word is taken, and the cover's Unlock passes after the time the system's sheet
    // takes to notice, as `reauth.verify` does.
    'private.setLockOnLeave': () => undefined,
    'private.unlock': () =>
      new Promise((resolve) => setTimeout(() => resolve({ locked: false }), 400)),
    // Passwords: the Android Keystore and BiometricPrompt stand-ins (see `vaultMode`). Refusals
    // answer `{ failure, message }` the way VaultKeystore.kt does.
    'vault.available': () => vaultMode !== 'none',
    'vault.wrap': ({ key }) => PREVIEW_BLOB + String(key),
    'vault.unwrap': ({ blob }) => {
      if (vaultMode === 'locked')
        return { failure: 'cancelled', message: 'Authentication was cancelled' }
      const text = String(blob)
      if (!text.startsWith(PREVIEW_BLOB))
        return { failure: 'invalidated', message: 'The vault key was not protected on this device' }
      return text.slice(PREVIEW_BLOB.length)
    },
    'reauth.available': () => vaultMode !== 'none',
    // The system sheet would rise here; the preview approves after the time it takes to notice.
    'reauth.verify': () => new Promise((resolve) => setTimeout(() => resolve(true), 400)),
    'clipboard.writeText': ({ text }) => {
      previewClip = String(text)
      void navigator.clipboard?.writeText(previewClip)
    },
    'clipboard.peek': () =>
      !previewClip || previewClip === previewClipUsed
        ? 'none'
        : isProbablyUrl(previewClip) && !/\s/.test(previewClip)
          ? 'url'
          : 'text',
    'clipboard.read': () => previewClip,
    // The clip the user opened through the row is not offered again until the clipboard changes.
    'clipboard.markUsed': () => {
      previewClipUsed = previewClip
    },
    // Like Kotlin: only a clipboard still holding the copied secret is emptied.
    'clipboard.clearText': async ({ expected }) => {
      const current = await navigator.clipboard?.readText().catch(() => null)
      if (current === String(expected)) await navigator.clipboard?.writeText('')
    },
    'clipboard.writeImage': () => false,
    // `?autofill=system` stands in for a device whose user has set an autofill service.
    'autofill.status': () =>
      new URLSearchParams(location.search).get('autofill') === 'system'
        ? { enabled: true, service: 'com.example.preview/.AutofillService' }
        : { enabled: false, service: null },
    'autofill.setProvider': ({ provider }) =>
      console.info('[zen preview] autofill provider', provider),
    // The pages are cross-origin iframes here: no forms script to talk to.
    'view.forms': () => undefined,
    'app.openExternal': ({ url }) => void window.open(String(url), '_blank'),
    // The browser's own share sheet where there is one; otherwise the share is just logged.
    'app.share': async ({ title, text, url, imageUrl }) => {
      const data = {
        title: title ? String(title) : undefined,
        text: text ? String(text) : undefined,
        url: url ? String(url) : imageUrl ? String(imageUrl) : undefined
      }
      if (typeof navigator.share === 'function') await navigator.share(data).catch(() => undefined)
      else console.info('[zen preview] share', data)
    },
    'app.openAppLinkSettings': () => console.info('[zen preview] open-by-default settings'),
    'voice.start': () => voice.start(),
    'voice.cancel': () => voice.cancel(),
    'voice.openSettings': () => console.info('[zen preview] app settings (microphone)'),
    'speech.voices': () => speech.voices(),
    'speech.speak': ({ utteranceId, text, rate, queue }) =>
      speech.speak(
        String(utteranceId),
        String(text ?? ''),
        Number(rate) || 1,
        queue === 'add' ? 'add' : 'flush'
      ),
    'speech.stop': () => speech.stop(),
    'app.openPrivateDnsSettings': () => console.info('[zen preview] private DNS settings'),
    'qr.start': () => qr.start(),
    'qr.cancel': () => qr.cancel(),
    'qr.layout': () => undefined,
    'qr.setTorch': ({ on }) => qr.setTorch(on === true),
    'qr.openSettings': () => console.info('[zen preview] app settings (camera)'),
    'app.openKeyboardSettings': () => console.info('[zen preview] keyboard settings'),
    'externalProtocol.respond': ({ requestId, allow }) =>
      console.info('[zen preview] external protocol', requestId, allow ? 'allowed' : 'refused'),
    // The browser role, remembered per preview profile; the "role dialog" is a confirm().
    'app.isDefaultBrowser': () => localStorage.getItem(DEFAULT_BROWSER_KEY) === 'true',
    'app.requestDefaultBrowser': () => {
      const granted = window.confirm('Preview host: make Zenium the default browser?')
      localStorage.setItem(DEFAULT_BROWSER_KEY, granted ? 'true' : 'false')
      return granted
    },
    // Out through the dev server (`previewFetch` in vite.android.config.ts), as the Kotlin host
    // reaches a site for the chrome: the suggest endpoints and OpenSearch descriptions the core
    // asks for send no CORS headers, so the chrome's own fetch to them would be refused.
    'net.fetch': async ({ url, headers }) => {
      // The Pwned Passwords range API is answered here (`previewRange.ts`): the leak warning
      // and the checkup are staged against a stand-in, never the real service.
      const staged = await previewRangeAnswer(String(url))
      if (staged) return staged
      try {
        const accept = (headers as Record<string, string> | undefined)?.accept
        const res = await fetch(`${PREVIEW_FETCH_ROUTE}?url=${encodeURIComponent(String(url))}`, {
          headers: accept ? { accept } : {}
        })
        return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' }
      } catch {
        return { ok: false, text: '' }
      }
    },
    ...createPreviewDownloads(host, DOWNLOADS_DIR),
    // Take Screenshot's gallery flow (SH-07, SH-08): the flash, the card's picture, the long capture.
    ...createPreviewScreenshots((tabId) => views.get(tabId), snapshotFrame),
    'profile.clear': () => undefined,
    'profile.clearBrowsingData': () => undefined,
    // No jar or cache to measure in the preview, as on a device (the WebView cannot list cookies).
    'profile.browsingDataCounts': () => ({ cookieSites: null, cacheBytes: null }),
    'keys.setShortcuts': () => undefined,
    'window.setFullscreen': ({ fullscreen }) => {
      if (fullscreen) void document.documentElement.requestFullscreen?.()
      else void document.exitFullscreen?.()
      host().hostEvent('fullscreen', JSON.stringify({ fullscreen }))
    }
  }

  const run = (call: NativeCall): unknown => {
    const handler = handlers[call.method]
    if (!handler) return undefined
    return handler((call.args ?? {}) as Record<string, unknown>)
  }

  const finds = new WeakMap<HTMLIFrameElement, { text: string; matches: number; active: number }>()

  /** Match count and active ordinal for `text`, stepping through the matches on repeated calls. */
  function findInFrame(
    frame: HTMLIFrameElement,
    text: string,
    forward: boolean,
    newSession: boolean
  ): { activeMatchOrdinal: number; matches: number } {
    const needle = text.toLowerCase()
    if (!needle) {
      finds.delete(frame)
      return { activeMatchOrdinal: 0, matches: 0 }
    }
    const previous = finds.get(frame)
    const continuing = previous !== undefined && previous.text === needle && !newSession
    const matches = continuing ? previous.matches : countMatches(frame, needle)
    let active = 0
    if (matches > 0) {
      active = continuing ? ((previous.active - 1 + (forward ? 1 : matches - 1)) % matches) + 1 : 1
    }
    finds.set(frame, { text: needle, matches, active })
    return { activeMatchOrdinal: active, matches }
  }

  function countMatches(frame: HTMLIFrameElement, needle: string): number {
    let body: HTMLElement | null = null
    try {
      body = frame.contentDocument?.body ?? null
    } catch {
      /* cross-origin */
    }
    if (body) {
      const haystack = (body.innerText || body.textContent || '').toLowerCase()
      let count = 0
      for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1))
        count++
      return count
    }
    let hash = 0
    for (const ch of needle) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
    return hash % 10
  }

  const snapshots = new WeakMap<HTMLIFrameElement, { key: string; data: string | null }>()

  /** How wide a card is, in device pixels, as the chrome said (`thumbnail.configure`). */
  let cardWidth = 0
  /** When each tab's card picture was last taken (`performance.now()`), for the freshness rule. */
  const cardTakenAt = new Map<string, number>()

  /**
   * The stand-in for Kotlin's card capture (`TabWebView.captureThumbnail`): the frame's cover
   * capture scaled to the card's width, kept in `localStorage` under the tab, and announced as
   * `thumbnail.captured`. Not twice within Kotlin's freshness window – a hide right after the
   * cover it shares the capture with publishes once between them.
   */
  async function captureCard(
    tabId: string,
    frame: HTMLIFrameElement,
    capture?: Promise<string | null>
  ): Promise<void> {
    const url = frame.dataset.url ?? ''
    // A frame whose document has not loaded shows white, and a picture of that would take the
    // place of the one kept from before (Kotlin's `paintedDocument`, BH-33).
    if (!url || frame.dataset.painted !== url) return
    const now = performance.now()
    if (now - (cardTakenAt.get(tabId) ?? -Infinity) < CARD_FRESH_MS) return
    cardTakenAt.set(tabId, now)
    const cover = await (capture ?? snapshotFrame(frame))
    const picture = cover ? await scaleToCard(cover, cardWidth || 480) : null
    // The page navigated meanwhile: the picture is of the page before (BH-14), and nothing of
    // it is kept.
    if (!picture || frame.dataset.url !== url) {
      cardTakenAt.delete(tabId)
      return
    }
    localStorage.setItem(THUMB_PREFIX + tabId, JSON.stringify({ ...picture, url }))
    host().hostEvent('thumbnail.captured', JSON.stringify({ tabId, ...picture }))
  }

  /** `cover` (a data URL) scaled to `width` pixels wide, its aspect kept, as a JPEG. */
  async function scaleToCard(cover: string, width: number): Promise<ThumbnailPicture | null> {
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('card failed'))
        img.src = cover
      })
      const w = Math.max(1, Math.min(width, image.naturalWidth))
      const h = Math.max(1, Math.round((image.naturalHeight * w) / image.naturalWidth))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(image, 0, 0, w, h)
      return { data: canvas.toDataURL('image/jpeg', 0.8), width: w, height: h }
    } catch {
      return null
    }
  }

  // The app going to the background (Kotlin's `Host.onPause`): the pages on screen are pictured.
  // Not on the way out of the document (a reload: `pagehide` comes first, then the hidden
  // state): nothing could finish, and an image a document loads while unloading is a beacon to
  // Chromium, which the chrome's connect-src then refuses in the console.
  let unloading = false
  window.addEventListener('pagehide', () => {
    unloading = true
  })
  document.addEventListener('visibilitychange', () => {
    if (unloading || document.visibilityState !== 'hidden') return
    for (const [tabId, frame] of views) {
      if (frameShown(frame)) void captureCard(tabId, frame)
    }
  })

  /** Whether the page's frame is on screen (`view.setVisible`; a VISIBLE WebView). */
  function frameShown(frame: HTMLIFrameElement): boolean {
    return frame.style.visibility !== 'hidden'
  }

  /**
   * The preview's stand-in for the hosts' page capture: same-origin frames are serialised into an
   * SVG `<foreignObject>` and rasterised (inline styles only – the image cannot fetch resources).
   * Cross-origin frames cannot be read and yield `null`, like a hidden page on a real host.
   * Rasterising is the expensive part, so an unchanged document reuses its last capture.
   */
  async function snapshotFrame(frame: HTMLIFrameElement): Promise<string | null> {
    let doc: Document | null
    try {
      doc = frame.contentDocument
    } catch {
      return null
    }
    const root = doc?.documentElement
    const width = frame.clientWidth
    const height = frame.clientHeight
    if (!root || !width || !height) return null
    const clone = root.cloneNode(true) as HTMLElement
    clone.querySelectorAll('script').forEach((s) => s.remove())
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
    const markup = new XMLSerializer().serializeToString(clone)
    const key = `${width}x${height}:${markup}`
    const cached = snapshots.get(frame)
    if (cached && cached.key === key) return cached.data
    const data = await rasterise(markup, width, height, frame.style.background)
    snapshots.set(frame, { key, data })
    return data
  }

  async function rasterise(
    markup: string,
    width: number,
    height: number,
    background: string
  ): Promise<string | null> {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`
    // A data: URL, not a blob: one – the chrome's CSP only lets images come from data:/http(s).
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('snapshot failed'))
        img.src = url
      })
      const scale = width > 1400 ? 1400 / width : 0.5
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.fillStyle = background || '#fff'
      // The canvas reads the colour back normalised: `rgba(…)` only when it has an alpha. A page
      // drawn over the chrome's wallpaper (zen://newtab, background `#00000000`) keeps its
      // transparency the way the WebView's bitmap does; JPEG would flatten it to black.
      const translucent = String(ctx.fillStyle).startsWith('rgba(')
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.scale(scale, scale)
      ctx.drawImage(image, 0, 0)
      return translucent ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.7)
    } catch {
      return null
    }
  }

  return {
    call(json) {
      const call = JSON.parse(json) as NativeCall
      Promise.resolve()
        .then(() => run(call))
        .then(
          (result) => host().resolve(call.id, result === undefined ? null : JSON.stringify(result)),
          (error: unknown) =>
            host().reject(call.id, error instanceof Error ? error.message : String(error))
        )
    },
    // One way, in order, off the caller's task like the Kotlin host's one main-thread task; a
    // failure is logged where the host logs its own (`JsBridge.batch`).
    batch(json) {
      const commands = JSON.parse(json) as NativeCommand[]
      void Promise.resolve().then(() => {
        for (const command of commands) {
          const warn = (error: unknown): void =>
            console.warn(`[zen preview] native ${command.method} failed`, error)
          try {
            // A handler answering with a promise (none of the view ops does) fails here too, not
            // out of the batch: as forgiving as `JsBridge.dispatchOneWay`.
            void Promise.resolve(run({ id: 0, ...command })).catch(warn)
          } catch (error) {
            warn(error)
          }
        }
      })
    },
    callSync(json) {
      const result = run(JSON.parse(json) as NativeCall)
      return result === undefined ? '' : JSON.stringify(result)
    }
  }
}

/**
 * A preview state announces an extension page it is about to open as a tab: the event's detail
 * names the page, and the host shows a stand-in for it when the tab loads that URL.
 */
export const PREVIEW_EXTENSION_PAGE_EVENT = 'zen-preview-extension-page'

export interface PreviewExtensionPage {
  /** `chrome-extension://<id>/<path>`, what the tab is created with. */
  url: string
  /** The extension's name, the page's heading. */
  name: string
  /** The document's title; empty for none, so the tab falls back to the extension's name. */
  title: string
}

/**
 * The stand-in for an extension's options page (`extension-page=<id>/<path>`): a document in
 * the extension's name with a few settings rows, following the system colour scheme like a
 * well-behaved extension page. Any resemblance to a particular extension's page is not intended;
 * the still is of the chrome around it.
 */
export function extensionPageDocument(page: PreviewExtensionPage): string {
  const escape = (text: string): string =>
    text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const row = (label: string, detail: string, on: boolean): string =>
    `<label class="row"><span><b>${escape(label)}</b><small>${escape(detail)}</small></span>` +
    `<input type="checkbox"${on ? ' checked' : ''}></label>`
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    (page.title ? `<title>${escape(page.title)}</title>` : '') +
    `<style>` +
    `:root{color-scheme:light dark;--fg:#1f1f24;--muted:#6b6b76;--line:#e4e4ea;--bg:#fff;--card:#f6f6f8;--accent:#3f51b5}` +
    `@media(prefers-color-scheme:dark){:root{--fg:#ececf1;--muted:#9a9aa6;--line:#2c2c34;--bg:#141418;--card:#1e1e24;--accent:#8c9eff}}` +
    `body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,Roboto,sans-serif}` +
    `header{padding:28px 20px 12px}h1{margin:0;font-size:22px;font-weight:600}` +
    `header p{margin:4px 0 0;color:var(--muted);font-size:14px}` +
    `h2{margin:20px 20px 8px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}` +
    `.card{margin:0 16px;background:var(--card);border-radius:14px;overflow:hidden}` +
    `.row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;border-top:1px solid var(--line)}` +
    `.row:first-child{border-top:0}.row span{display:flex;flex-direction:column;min-width:0}` +
    `.row b{font-weight:500}.row small{color:var(--muted);font-size:13px}` +
    `input{appearance:none;width:44px;height:26px;border-radius:13px;background:var(--line);position:relative;flex:none;margin:0}` +
    `input:checked{background:var(--accent)}` +
    `input::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:10px;background:#fff;transition:left .15s}` +
    `input:checked::after{left:21px}` +
    `</style></head><body>` +
    `<header><h1>${escape(page.name)}</h1><p>Settings</p></header>` +
    `<h2>General</h2><div class="card">` +
    row('Enable on all sites', 'New sites are handled as soon as they open', true) +
    row('Show notifications', 'A note when something needs your attention', false) +
    row('Sync settings', 'Keep these settings the same on every device', true) +
    `</div><h2>Appearance</h2><div class="card">` +
    row('Follow the system theme', 'Light and dark as the device decides', true) +
    row('Compact layout', 'Smaller controls in the popup', false) +
    `</div><h2>Advanced</h2><div class="card">` +
    row('Developer tools', 'Extra options for debugging', false) +
    `</div></body></html>`
  )
}

/**
 * The origin of a page this host serves itself (`samplePageDocument`), so the page is same-origin
 * and a picture of it can be taken (`view.snapshot`), where a site's frame cannot be read: for
 * stills of the chrome over a page's picture – the lock cover's blurred page (`private=page&
 * url=https://sample.example/&lock=on`). Any path under it is the same page.
 */
export const PREVIEW_SAMPLE_ORIGIN = 'https://sample.example'

/**
 * The stand-in page under `PREVIEW_SAMPLE_ORIGIN`: an article of a few paragraphs with a heading,
 * a picture block and a list, following the system colour scheme, enough for a blurred picture
 * of it to read as a page.
 */
export function samplePageDocument(): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Tide tables for the outer harbour</title>` +
    `<style>` +
    `:root{color-scheme:light dark;--fg:#1f1f24;--muted:#6b6b76;--bg:#fff;--card:#eef1f6;--accent:#2b6cb0}` +
    `@media(prefers-color-scheme:dark){:root{--fg:#ececf1;--muted:#9a9aa6;--bg:#141418;--card:#1e222c;--accent:#7fb2ff}}` +
    `body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.55 Georgia,'Times New Roman',serif}` +
    `header{padding:24px 20px 8px;font:13px system-ui,Roboto,sans-serif;color:var(--accent);letter-spacing:.06em;text-transform:uppercase}` +
    `h1{margin:0 20px 8px;font-size:30px;line-height:1.15;font-weight:600}` +
    `.by{margin:0 20px 20px;color:var(--muted);font:14px system-ui,Roboto,sans-serif}` +
    `figure{margin:0 0 20px;background:linear-gradient(160deg,#2b6cb0,#6fb1e6 55%,#f0c674);height:220px}` +
    `p{margin:0 20px 16px}ul{margin:0 20px 16px;padding-left:22px}li{margin:4px 0}` +
    `.note{margin:0 16px 16px;padding:14px 16px;background:var(--card);border-radius:12px;font:15px/1.5 system-ui,Roboto,sans-serif}` +
    `</style></head><body>` +
    `<header>Harbour notices</header>` +
    `<h1>Tide tables for the outer harbour</h1>` +
    `<p class="by">Published by the harbour office · 4 min read</p>` +
    `<figure></figure>` +
    `<p>High water reaches the outer wall twice a day, and the second of the two runs higher through the spring months. Skippers leaving before dawn should plan on the ebb, which sets north along the breakwater until an hour after low water.</p>` +
    `<div class="note">The east light is unlit until further notice. Keep to the marked channel after dark.</div>` +
    `<p>Berths on the north quay are let by the week. The office keeps a waiting list for the summer; visiting boats may lie alongside for two nights without notice.</p>` +
    `<ul><li>Fuel: weekdays 8 to 5, Saturdays to noon</li><li>Water on every pontoon</li><li>Showers by the slip, tokens at the office</li></ul>` +
    `<p>The tables below are corrected for the harbour datum. Heights are in metres above the sill of the inner basin, whose gate opens two hours either side of high water.</p>` +
    `<p>Charts are held at the office and may be consulted during opening hours. Corrections issued since the last edition are pinned beside the door.</p>` +
    `</body></html>`
  )
}

/** A preview state picks the stand-in recogniser's script: the event's detail is the script's name. */
export const PREVIEW_VOICE_EVENT = 'zen-preview-voice'

/**
 * The stand-in text-to-speech engine's voices (`speech.voices`), shaped and named as
 * `ReadAloud.kt` reports Google's (`ReadAloudLogic.voices`): `id` the engine's voice name, the
 * row's name the locale as the device's language spells it, numbered in rank order where the
 * locale has more than one voice and plain where it has one; the engine's default first, then by
 * quality; a few languages so the picker's "Other languages" group shows; one network voice.
 */
export const PREVIEW_VOICES: ReadAloudVoice[] = [
  {
    id: 'en-gb-x-gba-local',
    name: 'English (United Kingdom) 1',
    lang: 'en-GB',
    local: true,
    quality: 'high',
    default: true
  },
  {
    id: 'en-gb-x-rjs-local',
    name: 'English (United Kingdom) 2',
    lang: 'en-GB',
    local: true,
    quality: 'normal'
  },
  {
    id: 'en-us-x-iom-local',
    name: 'English (United States) 1',
    lang: 'en-US',
    local: true,
    quality: 'high'
  },
  {
    id: 'en-us-x-tpd-network',
    name: 'English (United States) 2',
    lang: 'en-US',
    local: false,
    quality: 'high'
  },
  {
    id: 'en-au-x-aua-local',
    name: 'English (Australia)',
    lang: 'en-AU',
    local: true,
    quality: 'normal'
  },
  {
    id: 'de-de-x-deb-local',
    name: 'German (Germany)',
    lang: 'de-DE',
    local: true,
    quality: 'high'
  },
  {
    id: 'fr-fr-x-frb-local',
    name: 'French (France)',
    lang: 'fr-FR',
    local: true,
    quality: 'normal'
  },
  {
    id: 'es-es-x-eea-local',
    name: 'Spanish (Spain)',
    lang: 'es-ES',
    local: true,
    quality: 'normal'
  }
]

/** What the stand-in recogniser does for `?voice=<name>`: the start's answer, then its events in order with the pause before each. */
export interface PreviewVoiceScript {
  outcome: VoiceStartOutcome
  events: Array<[delayMs: number, event: VoiceEvent]>
}

/** A run of levels, as `onRmsChanged` would report them: a swell, a dip, a swell. */
const PREVIEW_LEVELS: Array<[number, VoiceEvent]> = [
  0.25, 0.6, 0.9, 0.7, 0.4, 0.15, 0.3, 0.75, 1, 0.55, 0.2
].map((level) => [90, { kind: 'rms', level }])

export function previewVoiceScript(name: string): PreviewVoiceScript {
  const listening: Array<[number, VoiceEvent]> = [
    [200, { kind: 'ready' }],
    [300, { kind: 'begin' }],
    ...PREVIEW_LEVELS
  ]
  const heard: Array<[number, VoiceEvent]> = [
    ...listening,
    [200, { kind: 'partial', text: 'weather in' }],
    ...PREVIEW_LEVELS,
    [200, { kind: 'partial', text: 'weather in Lisbon this' }],
    ...PREVIEW_LEVELS,
    [200, { kind: 'partial', text: 'weather in Lisbon this weekend' }]
  ]
  switch (name) {
    case 'denied':
    case 'denied-permanently':
    case 'unavailable':
      return { outcome: name, events: [] }
    // The recogniser hears nothing it can make words of: the sheet's Try again state.
    case 'no-match':
      return {
        outcome: 'listening',
        events: [
          ...listening,
          ...PREVIEW_LEVELS,
          [400, { kind: 'end' }],
          [600, { kind: 'error', error: 'no-match' }]
        ]
      }
    case 'network':
    case 'busy':
      return { outcome: 'listening', events: [...listening, [400, { kind: 'error', error: name }]] }
    // Frozen mid-way, for a still of the sheet as it listens (the halo all the way out, at full
    // level), as it waits in silence (the glyph plain, no halo) or as it shows a partial transcript.
    case 'listening':
      return { outcome: 'listening', events: [...listening, [90, { kind: 'rms', level: 1 }]] }
    case 'listening-rest':
      return { outcome: 'listening', events: [...listening, [90, { kind: 'rms', level: 0 }]] }
    case 'partial':
      return { outcome: 'listening', events: heard }
    default:
      return {
        outcome: 'listening',
        events: [
          ...heard,
          [500, { kind: 'end' }],
          [700, { kind: 'result', text: 'weather in Lisbon this weekend' }]
        ]
      }
  }
}

/** A preview state picks the stand-in camera's script: the event's detail is the script's name. */
export const PREVIEW_QR_EVENT = 'zen-preview-qr'

/**
 * A preview state picks the stand-in speech engine's script (`readAloud=<status>`): the event's
 * detail is the status the still wants (`playing`, `paused`, `loading`, `ended`, `error`).
 */
export const PREVIEW_READ_ALOUD_EVENT = 'zen-preview-read-aloud'

/**
 * The article `reader=` shows and `readAloud=` reads: a few paragraphs, a heading and a quote,
 * enough to fill a phone; the stand-in page answers the core's `readAloud.extract` with it.
 */
export const PREVIEW_ARTICLE: RawArticle = {
  title: 'Why coffee tastes different at altitude',
  byline: 'Ada Marlowe',
  siteName: 'The Roastery Journal',
  excerpt: 'Pressure, water and a slow boil: what changes in a cup a mile up.',
  lang: 'en',
  dir: 'ltr',
  content: [
    '<p>Water boils cooler the higher you climb: at a mile up it gives out near 95 °C, and a brew that leans on a rolling boil never quite gets there. The grounds sit in water a few degrees short of what the recipe assumed, and the cup comes out thinner, brighter, a little sour at the edges.</p>',
    '<p>Roasters who work at altitude learn to lean the other way. A finer grind gives the water more surface to pull from; a longer steep makes up for the cooler pour. Neither is a fix so much as a trade – more body, but more of the bitter compounds that a hotter, shorter brew would have left behind.</p>',
    '<h2>The pressure in the pot</h2>',
    '<p>Espresso complicates the story. A machine holds its water at nine bars whatever the air outside is doing, so the extraction itself changes little. What changes is everything around it: the beans lose moisture faster in thin, dry air, and a bag opened on Monday tastes of Thursday by Wednesday.</p>',
    '<blockquote><p>“We do not roast for the bean. We roast for the room it will be drunk in.”</p></blockquote>',
    '<p>The oldest advice still holds. Taste as you go, and let the cup, not the recipe, have the last word.</p>'
  ].join('\n')
}

/** What the stand-in camera does for `?qr=<name>`: the start's answer, then its events in order with the pause before each. */
export interface PreviewQrScript {
  outcome: QrStartOutcome
  events: Array<[delayMs: number, event: QrEvent]>
}

export function previewQrScript(name: string): PreviewQrScript {
  // The camera "opens" and the still stands where the live preview would; the sheet is scanning.
  const scanning: Array<[number, QrEvent]> = [
    [400, { kind: 'ready', torch: true }],
    [50, { kind: 'still', dataUrl: previewQrStill() }]
  ]
  switch (name) {
    case 'denied':
    case 'denied-permanently':
    case 'unavailable':
      return { outcome: name, events: [] }
    case 'busy':
    case 'camera':
      return { outcome: 'scanning', events: [[600, { kind: 'error', error: name }]] }
    // Frozen while the camera opens (the title's "Starting the camera" line), or while it scans.
    case 'starting':
      return { outcome: 'scanning', events: [] }
    case 'scanning':
      return { outcome: 'scanning', events: scanning }
    case 'torch':
      return { outcome: 'scanning', events: [...scanning, [100, { kind: 'torch', on: true }]] }
    // A code with words on it: searched through the profile's engine.
    case 'text':
      return {
        outcome: 'scanning',
        events: [...scanning, [1200, { kind: 'decoded', text: 'weather in Lisbon this weekend' }]]
      }
    // A Wi-Fi code: its network name is searched, its password stays on the device.
    case 'wifi':
      return {
        outcome: 'scanning',
        events: [
          ...scanning,
          [1200, { kind: 'decoded', text: 'WIFI:T:WPA;S:Cafe Lisboa;P:hunter2;;' }]
        ]
      }
    default:
      return {
        outcome: 'scanning',
        events: [...scanning, [1200, { kind: 'decoded', text: 'https://example.org/' }]]
      }
  }
}

let qrStillCache: string | null = null

/**
 * The stand-in for a camera frame, drawn once: a desk in soft light with a card carrying a
 * QR-like pattern (the three finder squares and a fixed scatter of modules – a picture of a
 * code, not one that decodes), as a JPEG data URL of the size the sheet's window takes on a
 * phone. Where there is no canvas (tests) a 1 px placeholder.
 */
export function previewQrStill(): string {
  if (qrStillCache) return qrStillCache
  const size = 640
  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas')
  const ctx = canvas?.getContext('2d') ?? null
  if (!canvas || !ctx) {
    return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  }
  canvas.width = size
  canvas.height = size
  const desk = ctx.createLinearGradient(0, 0, size, size)
  desk.addColorStop(0, '#4a4f5c')
  desk.addColorStop(1, '#2a2d36')
  ctx.fillStyle = desk
  ctx.fillRect(0, 0, size, size)
  // The card, a little turned, with a soft shadow.
  ctx.save()
  ctx.translate(size / 2, size / 2)
  ctx.rotate(-0.06)
  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = 40
  ctx.shadowOffsetY = 18
  ctx.fillStyle = '#f7f6f2'
  ctx.fillRect(-190, -190, 380, 380)
  ctx.shadowColor = 'transparent'
  // The code: 25 modules across at 12 px, a 2-module quiet zone inside the card.
  const modules = 25
  const cell = 12
  const origin = -(modules * cell) / 2
  ctx.fillStyle = '#17171a'
  const finder = (mx: number, my: number): void => {
    ctx.fillRect(origin + mx * cell, origin + my * cell, 7 * cell, 7 * cell)
    ctx.fillStyle = '#f7f6f2'
    ctx.fillRect(origin + (mx + 1) * cell, origin + (my + 1) * cell, 5 * cell, 5 * cell)
    ctx.fillStyle = '#17171a'
    ctx.fillRect(origin + (mx + 2) * cell, origin + (my + 2) * cell, 3 * cell, 3 * cell)
  }
  finder(0, 0)
  finder(modules - 7, 0)
  finder(0, modules - 7)
  let seed = 7
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      const inFinder =
        (x < 8 && y < 8) || (x >= modules - 8 && y < 8) || (x < 8 && y >= modules - 8)
      if (inFinder) continue
      if (next() < 0.47) ctx.fillRect(origin + x * cell, origin + y * cell, cell, cell)
    }
  }
  ctx.restore()
  qrStillCache = canvas.toDataURL('image/jpeg', 0.82)
  return qrStillCache
}
