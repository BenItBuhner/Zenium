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

/** What a page told us right before its call: whether it asked for audio. */
interface Intent {
  audio: boolean
  at: number
}

/** The picker's answer from the permission stage, waiting for the engine's display-media stage. */
interface StoredAnswer {
  answer: ScreenCaptureAnswer
  /** The page asked for audio (from its announcement): decides whether a tab share carries sound. */
  audio: boolean
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
 * constraints`), so the picker runs at the permission stage (`permission`), where Electron does
 * not yet say whether the page asked for audio; the page's own call does, through the shim in
 * its main world (`shared/screenCapture`), announced synchronously before the engine sees the
 * call (`intent`). The answer waits for the engine's display-media request (`handle`), which
 * hands it over without asking again. A call that reaches the display-media stage without one
 * (a page whose main world the shim could not reach) still gets the picker there.
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
    private readonly now: () => number = Date.now
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
   * cancelled – the engine then refuses the call with `NotAllowedError`.
   */
  async permission(wc: WebContents, tabId: string, url: string): Promise<boolean> {
    const audio = this.takeIntent(wc.id)
    const answer = await this.service().request({ tabId, url, audio })
    if (!answer.sourceId) return false
    this.answers.set(wc.id, { answer, audio, at: this.now() })
    return true
  }

  private takeIntent(id: number): boolean {
    const intent = this.intents.get(id)
    this.intents.delete(id)
    return Boolean(intent && this.now() - intent.at <= INTENT_TTL_MS && intent.audio)
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
    // screens are fine, and one call for both would lose the lot. Each pass stands alone.
    const out: ScreenCaptureSource[] = []
    for (const type of kinds) {
      const list = await this.enumerate(type)
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
    // The picker normally ran at the permission stage; its answer is handed over here. The
    // engine's own word on audio wins over the page's announcement when it has one.
    const stored = this.takeAnswer(wc.id)
    const audioRequested = request.audioRequested || Boolean(stored?.audio)
    const answer =
      stored?.answer ??
      (await this.service().request({
        tabId,
        url: request.securityOrigin || frame.url,
        audio: request.audioRequested
      }))
    if (!answer.sourceId) {
      deny(callback)
      return
    }
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
        ...(answer.audio ? { audio: 'loopback' } : {})
      })
    } catch (error) {
      // The frame went away between the answer and the grant.
      console.warn('[zen] screen capture:', (error as Error).message)
    }
  }
}

/**
 * The engine refuses the page's call. Only reached when the picker had to run at this stage
 * (or the picked tab vanished): Electron words this refusal as an `AbortError`, so the ordinary
 * cancel – a `NotAllowedError`, as Chrome's – is given at the permission stage instead.
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
