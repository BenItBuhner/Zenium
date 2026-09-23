/**
 * Web capture (`shared/capture.ts` for the contract): the chrome's capture UI – Edge's Web
 * capture, a rectangle dragged over the dimmed page, a result overlay with Copy and Save – gets
 * the page's picture from the hosts' agent capture engines through this service, and hands it
 * back to be copied or saved:
 *
 *  - `capture` paints the visible area, the whole page or a region (CSS pixels relative to the
 *    document) through `TabView.capture`, PNG by default, and answers with a data URL and the
 *    picture's own pixel size (read from the bytes' header, whatever the host reports). The
 *    request is measured against `CAPTURE_MAX_PIXELS` before anything is painted and refused
 *    with `CaptureTooLargeError` past it – a named error the UI shows, never a silent null. A
 *    host that could only paint the visible area says so (`fallback: 'viewport'`) and the
 *    answer carries it.
 *  - `viewport` is the page's geometry the overlay maps its drag rectangle with
 *    (`regionFromChrome`): the chrome cannot read a live view's scroll offset itself.
 *  - `copy` puts the picture on the clipboard as a PNG (`ClipboardHost.writeImageFromUrl`, the
 *    image context menu's path on both hosts).
 *  - `save` writes it to the downloads location through the host (`DownloadHost.saveFile`) and
 *    lists it as a completed download, so the bubble and the Downloads page show where it went
 *    – the same rule Take Screenshot follows, under the one screenshot name rule.
 *
 * The dimmed page behind the overlay is the existing stand-in (`overlay.snapshot`, `TabView.snapshot`).
 */
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import type { AgentCapture, AgentCaptureOptions, TabView } from './platform'
import type { Rect } from '../shared/types'
import {
  CaptureTooLargeError,
  captureArea,
  captureBudget,
  captureExtension,
  imageDimensions,
  parseImageDataUrl,
  screenshotFileName,
  type PageCaptureRequest,
  type PageCaptureResult,
  type PageViewport
} from '../shared/capture'
import { sanitizeDownloadName } from '../shared/downloads'
import { base64Decode } from './extensions/bytes'

export class CaptureService {
  /** The clock the save's file name reads; tests set their own. */
  now: () => Date = () => new Date()

  constructor(private readonly browser: Browser) {}

  /** The page's geometry, or null when the tab has no page view or the host cannot read it. */
  viewport(tabId: string): Promise<PageViewport | null> {
    const view = this.browser.tabs.view(tabId)
    return view ? this.viewportOf(view) : Promise.resolve(null)
  }

  /**
   * The picture the chrome asked for. Null for a tab without a page view or a host without the
   * agent capture, a page that cannot be painted (nothing painted yet, gone) or a region that
   * lies outside the document; `CaptureTooLargeError` past the budget.
   */
  async capture(tabId: string, request: PageCaptureRequest): Promise<PageCaptureResult | null> {
    const view = this.browser.tabs.view(tabId)
    if (!view?.capture) return null
    const format = request.format === 'jpeg' ? 'jpeg' : 'png'
    const viewport = await this.viewportOf(view)
    const area = captureArea(request, viewport)
    if (request.mode === 'region' && !area) return null
    if (area) {
      const budget = captureBudget(area, viewport?.devicePixelRatio ?? 1)
      if (!budget.withinBudget) throw new CaptureTooLargeError(budget.pixels, budget)
    }
    const options: AgentCaptureOptions =
      request.mode === 'region'
        ? { mode: 'region', region: area as Rect, format }
        : { mode: request.mode, format }
    let picture: AgentCapture | null
    try {
      picture = await view.capture(options)
    } catch {
      picture = null
    }
    if (!picture || !picture.data) return null
    return describe(picture, area, viewport)
  }

  /** The picture on the clipboard as a PNG; false for anything but an image data URL or a host that could not. */
  async copy(dataUrl: string): Promise<boolean> {
    if (!parseImageDataUrl(dataUrl)) return false
    try {
      return await this.browser.platform.clipboard.writeImageFromUrl(dataUrl)
    } catch {
      return false
    }
  }

  /**
   * The picture into the downloads location and the downloads list. `fileName` is taken as a
   * leaf name with the picture's extension put right; without one the screenshot rule names it.
   */
  async save(
    dataUrl: string,
    win: ZenWindow,
    options: { fileName?: string; tabId?: string } = {}
  ): Promise<{ path: string } | null> {
    const image = parseImageDataUrl(dataUrl)
    const host = this.browser.platform.downloads.saveFile
    if (!image || !host) return null
    const extension = captureExtension(image.mimeType)
    const name = fileNameFor(options.fileName, extension) ?? screenshotFileName(this.now(), extension)
    let path: string | null
    try {
      path = await host.call(this.browser.platform.downloads, {
        name,
        mimeType: image.mimeType,
        data: image.data
      })
    } catch {
      path = null
    }
    if (!path) return null
    const tab = options.tabId ? this.browser.tabs.tab(options.tabId) : undefined
    this.browser.downloads.addCompleted(path, image.mimeType, {
      containerId: tab?.containerId,
      private: win.isPrivate
    })
    return { path }
  }

  private async viewportOf(view: TabView): Promise<PageViewport | null> {
    if (!view.viewport) return null
    try {
      return await view.viewport()
    } catch {
      return null
    }
  }
}

/**
 * The answer from the host's picture: the data URL, the size the bytes declare (the host's
 * numbers when the header cannot be read), and the pixels per CSS pixel of the area captured –
 * for a picture that came back as the visible area instead, the page's own ratio (the crop
 * was made at it, whatever the region's width).
 */
function describe(
  picture: AgentCapture,
  area: Rect | null,
  viewport: PageViewport | null
): PageCaptureResult {
  const declared = imageDimensions(headerBytes(picture.data))
  const width = declared?.width ?? picture.width
  const height = declared?.height ?? picture.height
  const pageRatio = viewport?.devicePixelRatio ?? 1
  const ratio =
    picture.fallback || !area || !(area.width > 0) || !(width > 0) ? pageRatio : width / area.width
  const result: PageCaptureResult = {
    dataUrl: `data:${picture.mimeType};base64,${picture.data}`,
    width,
    height,
    devicePixelRatio: round(ratio)
  }
  if (picture.fallback) result.fallback = picture.fallback
  return result
}

function round(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : 1
}

/** The first 64 KB of a base64 picture (a PNG's header is in its first 24 bytes; a JPEG's frame header follows its metadata). */
function headerBytes(base64: string, max = 64 * 1024): Uint8Array {
  const chars = Math.floor(max / 3) * 4
  try {
    return base64Decode(base64.length > chars ? base64.slice(0, chars) : base64)
  } catch {
    return new Uint8Array(0)
  }
}

/** The chrome's name for the file as a safe leaf name with the right extension; null for nothing usable. */
function fileNameFor(name: string | undefined, extension: 'png' | 'jpg'): string | null {
  if (!name) return null
  const leaf = sanitizeDownloadName(name.split(/[\\/]/).pop() ?? '')
  if (leaf === '') return null
  const lower = leaf.toLowerCase()
  const has =
    extension === 'jpg'
      ? lower.endsWith('.jpg') || lower.endsWith('.jpeg')
      : lower.endsWith('.png')
  return has ? leaf : `${leaf.replace(/\.(png|jpe?g)$/i, '')}.${extension}`
}
