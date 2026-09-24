import { desktopCapturer, webContents, type Session, type WebContents } from 'electron'
import type { ScreenCaptureHost } from '../../core/platform'
import type { ScreenCaptureAnswer, ScreenCaptureService } from '../../core/screenCapture'
import { tabIdOfSource } from '../../core/screenCapture'
import type { ScreenCaptureSource } from '../../shared/types'
import type { ElectronTabViewHost } from './views'

type DisplayMediaRequest = Electron.DisplayMediaRequestHandlerHandlerRequest
type DisplayMediaCallback = (streams: Electron.Streams) => void

/** Picker thumbnails: Chrome's tiles are about this size; JPEG keeps the request's state small. */
const THUMBNAIL_SIZE = { width: 320, height: 180 }
const THUMBNAIL_JPEG_QUALITY = 72

/**
 * How long a page's announcement of a coming `getDisplayMedia` call stays good for the
 * permission request that follows it (normally within the same turn of the main process).
 */
const INTENT_TTL_MS = 10_000

/** How long the picker's answer waits for the engine's display-media request that consumes it. */
const ANSWER_TTL_MS = 30_000

/**
 * A screen pass that comes back empty is asked once more after this: the X error a window pass
 * trips stays in the capturer's state a moment, and the next screen enumeration after it can
 * resolve with nothing – the screens are back when asked again.
 */
const SCREEN_RETRY_DELAY_MS = 150

/** The passes' order: screens first, so a broken window pass cannot come before them. */
const SOURCE_PASS_ORDER: ReadonlyArray<'screen' | 'window'> = ['screen', 'window']

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** What a page told us right before its call: whether it asked for audio. */
interface Intent {
  audio: boolean
  at: number
}

/** The picker's answer from the permission stage, waiting for the engine's display-media stage. */
interface StoredAnswer {
  answer: ScreenCaptureAnswer
  /**
   * Whether the page asked for audio, from its announcement; null when there was none (the
   * shim did not reach the page's main world) – the engine's own word decides then.
   */
  audio: boolean | null
  at: number
}

/**
 * Screen capture on Electron (MW-19). The core's `ScreenCaptureService` puts up the picker and
 * this host hands the engine what was picked: a `desktopCapturer` screen or window, or a tab's
 * page (its main frame – Electron captures the whole page for it). System audio rides along
 * with a screen on Windows only (Chromium's loopback capture); a tab share carries the tab's own
 * audio, still audible locally, as Chrome's does.
 *
 * The picker is Chrome's consent, so cancelling it must refuse the call the way Chrome does:
 * `NotAllowedError: Permission denied`. On Electron only the permission stage can say that (a
 * refusal from `setDisplayMediaRequestHandler` surfaces as `AbortError: Invalid capture
 * constraints`), so the picker runs at the permission stage (`permission`) – always – where
 * Electron does not yet say whether the page asked for audio; the page's own call does, through
 * the shim in its main world (`shared/screenCapture`), announced synchronously before the
 * engine sees the call (`intent`). Without an announcement (a page whose main world the shim
 * could not reach) the picker is put up with audio unknown: it offers the audio choice, and
 * the choice counts only if the engine's request then says the page asked for audio. The
 * answer waits for the engine's display-media request (`handle`), which only ever hands over
 * a stored answer, never asks itself: a request with none waiting (the answer expired, or a
 * call this host never saw at the permission stage) is refused there.
 *
 * On Wayland `desktopCapturer.getSources` goes through the desktop portal, whose own dialog is
 * what the user sees; the list then holds the one source it granted. macOS 15's system picker
 * stays off so the picker is the same everywhere (Chrome draws its own there too).
 */
export class ElectronScreenCapture implements ScreenCaptureHost {
  /** The names of the sources last listed, for the engine's `{ id, name }` answer. */
  private readonly names = new Map<string, string>()
  /** Announced calls by web contents id, each consumed by the permission request that follows. */
  private readonly intents = new Map<number, Intent>()
  /** Permission-stage answers by web contents id, each consumed by the display-media request. */
  private readonly answers = new Map<number, StoredAnswer>()

  constructor(
    private readonly views: ElectronTabViewHost,
    private readonly service: () => ScreenCaptureService,
    private readonly now: () => number = Date.now,
    private readonly delay: (ms: number) => Promise<void> = wait
  ) {}

  attach(ses: Session): void {
    ses.setDisplayMediaRequestHandler((request, callback) => void this.handle(request, callback), {
      useSystemPicker: false
    })
  }

  /** A page announced a coming `getDisplayMedia` call and whether it asked for audio. */
  intent(wc: WebContents, audio: boolean): void {
    this.intents.set(wc.id, { audio, at: this.now() })
  }

  /**
   * The permission stage of a page's call: the picker. Resolves true when a source was picked
   * (the answer waits for the engine's display-media request) and false when the picker was
   * cancelled – the engine then refuses the call with `NotAllowedError`. With no announcement
   * to go by, the picker offers the audio choice (`audio: true`); whether it counts is decided
   * at the display-media stage, where the engine says if the page asked for audio.
   */
  async permission(wc: WebContents, tabId: string, url: string): Promise<boolean> {
    const intent = this.takeIntent(wc.id)
    const answer = await this.service().request({ tabId, url, audio: intent ?? true })
    if (!answer.sourceId) return false
    this.answers.set(wc.id, { answer, audio: intent, at: this.now() })
    return true
  }

  /** The page's fresh announcement, consumed; null when there is none to go by. */
  private takeIntent(id: number): boolean | null {
    const intent = this.intents.get(id)
    this.intents.delete(id)
    return intent && this.now() - intent.at <= INTENT_TTL_MS ? intent.audio : null
  }

  private takeAnswer(id: number): StoredAnswer | undefined {
    const stored = this.answers.get(id)
    this.answers.delete(id)
    return stored && this.now() - stored.at <= ANSWER_TTL_MS ? stored : undefined
  }

  systemAudio(): boolean {
    return process.platform === 'win32'
  }

  async sources(kinds: Array<'screen' | 'window'>): Promise<ScreenCaptureSource[]> {
    // Screens and windows are enumerated separately: on some Linux setups (a bare X server with
    // no window manager, a portal that lists only what it granted) the window pass throws while
    // screens are fine, and one call for both would lose the lot. Each pass stands alone, and
    // the screens go first whatever order was asked, so nothing the window pass trips can be
    // ahead of them; a screen pass that still comes back empty is asked once more
    // (`SCREEN_RETRY_DELAY_MS`) before "no screens" is believed.
    const out: ScreenCaptureSource[] = []
    for (const type of SOURCE_PASS_ORDER) {
      if (!kinds.includes(type)) continue
      let list = await this.enumerate(type)
      if (type === 'screen' && list.length === 0) {
        await this.delay(SCREEN_RETRY_DELAY_MS)
        list = await this.enumerate(type)
      }
      for (const source of list) {
        const kind = source.id.startsWith('screen:') ? 'screen' : 'window'
        this.names.set(source.id, source.name)
        out.push({
          id: source.id,
          name: screenName(source, kind, list),
          kind,
          thumbnail: source.thumbnail.isEmpty()
            ? null
            : `data:image/jpeg;base64,${source.thumbnail.toJPEG(THUMBNAIL_JPEG_QUALITY).toString('base64')}`,
          icon:
            kind === 'window' && source.appIcon && !source.appIcon.isEmpty()
              ? source.appIcon.toDataURL()
              : null
        })
      }
    }
    return out
  }

  /** One type's sources; a pass that throws (no window manager, portal quirk) yields nothing. */
  private async enumerate(type: 'screen' | 'window'): Promise<Electron.DesktopCapturerSource[]> {
    try {
      return await desktopCapturer.getSources({
        types: [type],
        thumbnailSize: THUMBNAIL_SIZE,
        fetchWindowIcons: type === 'window'
      })
    } catch (error) {
      console.warn(`[zen] screen capture: could not list ${type}s:`, (error as Error).message)
      return []
    }
  }

  private async handle(
    request: DisplayMediaRequest,
    callback: DisplayMediaCallback
  ): Promise<void> {
    const frame = request.frame
    const wc = frame ? webContents.fromFrame(frame) : undefined
    const tabId = wc ? this.views.tabIdForWebContents(wc) : undefined
    if (!tabId || !frame || !wc) {
      deny(callback)
      return
    }
    // The picker ran at the permission stage; its answer is handed over here, and a request
    // with none waiting is refused (the picker never runs at this stage: a cancel here could
    // only read as an `AbortError`). The page asked for audio when the engine says so or its
    // own announcement did; with no announcement the engine's word is the only one, and the
    // picker's audio choice – offered on the chance – is dropped unless the engine confirms it.
    const stored = this.takeAnswer(wc.id)
    if (!stored || !stored.answer.sourceId) {
      deny(callback)
      return
    }
    const { answer } = stored
    const audioRequested = request.audioRequested || stored.audio === true
    const targetTab = tabIdOfSource(answer.sourceId)
    try {
      if (targetTab) {
        const view = this.views.viewForTab(targetTab)
        if (!view || view.isDestroyed()) {
          deny(callback)
          return
        }
        const page = view.webContents.mainFrame
        callback({
          video: page,
          // The tab's sound goes with its picture when the page asked for audio, and keeps
          // playing here (Chrome's "Also share tab audio" leaves the tab audible).
          ...(audioRequested ? { audio: page, enableLocalEcho: true } : {})
        })
        return
      }
      callback({
        video: { id: answer.sourceId, name: this.names.get(answer.sourceId) ?? '' },
        ...(answer.audio && audioRequested ? { audio: 'loopback' } : {})
      })
    } catch (error) {
      // The frame went away between the answer and the grant.
      console.warn('[zen] screen capture:', (error as Error).message)
    }
  }
}

/**
 * The engine refuses the page's call. Only reached when no answer of the picker's was waiting
 * (a call this host never saw at the permission stage, an answer that expired) or the picked
 * tab vanished: Electron words this refusal as an `AbortError`, so the ordinary cancel – a
 * `NotAllowedError`, as Chrome's – is given at the permission stage instead.
 */
function deny(callback: DisplayMediaCallback): void {
  try {
    callback({})
  } catch {
    /* the request is already gone */
  }
}

/**
 * Chrome names one screen "Entire screen" and several "Screen 1", "Screen 2", …; Electron's own
 * names follow the same rule but say "Entire Screen".
 */
function screenName(
  source: Electron.DesktopCapturerSource,
  kind: 'screen' | 'window',
  all: Electron.DesktopCapturerSource[]
): string {
  if (kind !== 'screen') return source.name
  const screens = all.filter((s) => s.id.startsWith('screen:'))
  if (screens.length <= 1) return 'Entire screen'
  return source.name.replace(/^Entire Screen$/i, 'Entire screen')
}
