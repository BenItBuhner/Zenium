import { desktopCapturer, webContents, type Session } from 'electron'
import type { ScreenCaptureHost } from '../../core/platform'
import type { ScreenCaptureService } from '../../core/screenCapture'
import { tabIdOfSource } from '../../core/screenCapture'
import type { ScreenCaptureSource } from '../../shared/types'
import type { ElectronTabViewHost } from './views'

type DisplayMediaRequest = Electron.DisplayMediaRequestHandlerHandlerRequest
type DisplayMediaCallback = (streams: Electron.Streams) => void

/** Picker thumbnails: Chrome's tiles are about this size; JPEG keeps the request's state small. */
const THUMBNAIL_SIZE = { width: 320, height: 180 }
const THUMBNAIL_JPEG_QUALITY = 72

/**
 * Screen capture on Electron (MW-19). Every session's `getDisplayMedia` lands in
 * `setDisplayMediaRequestHandler`; the core's `ScreenCaptureService` puts up the picker and this
 * host hands the engine what was picked: a `desktopCapturer` screen or window, or a tab's page
 * (its main frame – Electron captures the whole page for it). System audio rides along with a
 * screen on Windows only (Chromium's loopback capture); a tab share carries the tab's own
 * audio, still audible locally, as Chrome's does.
 *
 * On Wayland `desktopCapturer.getSources` goes through the desktop portal, whose own dialog is
 * what the user sees; the list then holds the one source it granted. macOS 15's system picker
 * stays off so the picker is the same everywhere (Chrome draws its own there too).
 */
export class ElectronScreenCapture implements ScreenCaptureHost {
  /** The names of the sources last listed, for the engine's `{ id, name }` answer. */
  private readonly names = new Map<string, string>()

  constructor(
    private readonly views: ElectronTabViewHost,
    private readonly service: () => ScreenCaptureService
  ) {}

  attach(ses: Session): void {
    ses.setDisplayMediaRequestHandler((request, callback) => void this.handle(request, callback), {
      useSystemPicker: false
    })
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
    if (!tabId || !frame) {
      deny(callback)
      return
    }
    const answer = await this.service().request({
      tabId,
      url: request.securityOrigin || frame.url,
      audio: request.audioRequested
    })
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
          ...(request.audioRequested ? { audio: page, enableLocalEcho: true } : {})
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

/** The engine refuses the page's call (`NotAllowedError`, as Chrome's cancelled picker does). */
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
