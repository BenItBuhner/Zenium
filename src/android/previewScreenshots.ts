import type { LongCapture, ScreenshotSaved } from '@shared/types'

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>

/** A picture in the stand-in gallery. */
interface Picture {
  data: string
  width: number
  height: number
  bytes: number
}

/** Chrome's long screenshot stops at about ten screens of page (`Screenshots.kt` cuts there too). */
export const LONG_CAPTURE_SCREENS = 10
/** How long the flash takes to clear (the Kotlin overlay's fade; v2 §11.3: opacity only). */
export const FLASH_MS = 120

/** The flash the preview holds part-way for a `screenshot=flash` still: this opaque. */
export const FLASH_HOLD_OPACITY = 0.65

interface PreviewHolds {
  __zenPreviewFlashHold?: number
  __zenPreviewLongHold?: boolean
}

/**
 * A `screenshot=flash` preview state holds the flash sheet at this opacity instead of letting it
 * fade (`window.__zenPreviewFlashHold`), so a still can show the frame mid-flash.
 */
export function previewFlashHold(): number | null {
  const value = (window as unknown as PreviewHolds).__zenPreviewFlashHold
  return typeof value === 'number' && value > 0 ? Math.min(1, value) : null
}

/**
 * What a preview state asks of the stand-in: hold the flash part-way (`flash`), or never answer
 * the long capture (`long`: the editor's wait). Both off between states (`resetPreviewScreenshots`).
 */
export function holdPreviewScreenshots(holds: { flash?: boolean; long?: boolean }): void {
  const w = window as unknown as PreviewHolds
  if (holds.flash) w.__zenPreviewFlashHold = FLASH_HOLD_OPACITY
  else delete w.__zenPreviewFlashHold
  if (holds.long) w.__zenPreviewLongHold = true
  else delete w.__zenPreviewLongHold
}

/** Every flash sheet off the page and every hold released: the next state starts clean. */
export function resetPreviewScreenshots(): void {
  holdPreviewScreenshots({})
  for (const sheet of document.querySelectorAll('.zen-preview-flash')) sheet.remove()
}

function longHeld(): boolean {
  return (window as unknown as PreviewHolds).__zenPreviewLongHold === true
}

/**
 * The preview host's stand-in for `Screenshots.kt` (SH-07, SH-08): the flash is a white sheet
 * over the page's frame fading in 120 ms, the gallery a map of pictures, the picture the frame's
 * own capture where the page can be read (same origin) and a drawn stand-in page elsewhere, so
 * the card's thumbnail and the editor's long picture have something to show for any site. Share
 * goes to the browser's `navigator.share` where there is one and is logged otherwise, Delete
 * takes the picture out of the map, and the viewer is a new window with the picture.
 */
export function createPreviewScreenshots(
  frameOf: (tabId: string) => HTMLIFrameElement | undefined,
  snapshot: (frame: HTMLIFrameElement) => Promise<string | null>
): Record<string, Handler> {
  const gallery = new Map<string, Picture>()
  const held = new Map<string, Picture>()
  let seq = 0

  const flash = (frame: HTMLIFrameElement): Promise<void> => {
    const parent = frame.parentElement
    if (!parent) return Promise.resolve()
    const sheet = document.createElement('div')
    sheet.className = 'zen-preview-flash'
    // Over the frame exactly – its place, its transform, its clip – and one layer above it.
    sheet.style.cssText =
      `position:fixed;left:${frame.style.left};top:${frame.style.top};width:${frame.style.width};` +
      `height:${frame.style.height};border-radius:${frame.style.borderRadius};background:#fff;` +
      `pointer-events:none;z-index:${Number(frame.style.zIndex) + 1 || 51};opacity:1;` +
      `transition:opacity ${FLASH_MS}ms linear`
    sheet.style.transform = frame.style.transform
    sheet.style.clipPath = frame.style.clipPath
    parent.appendChild(sheet)
    const hold = previewFlashHold()
    if (hold !== null) {
      sheet.style.transition = 'none'
      sheet.style.opacity = String(hold)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        sheet.style.opacity = '0'
        setTimeout(() => {
          sheet.remove()
          resolve()
        }, FLASH_MS + 40)
      })
    })
  }

  const picture = async (frame: HTMLIFrameElement, screens: number): Promise<Picture> => {
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(frame.clientWidth * dpr))
    const screen = Math.max(1, Math.round(frame.clientHeight * dpr))
    const height = screen * screens
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    const cover = screens === 1 ? await snapshot(frame) : null
    if (cover) {
      const image = await loadImage(cover)
      ctx.drawImage(image, 0, 0, width, height)
    } else {
      drawStandInPage(ctx, width, height, dpr)
    }
    const data = canvas.toDataURL('image/png')
    return { data, width, height, bytes: Math.round((data.length - 22) * 0.75) }
  }

  const thumbnail = async (source: Picture, tall: number): Promise<string> => {
    const image = await loadImage(source.data)
    const scale = tall / source.height
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(source.width * scale))
    canvas.height = tall
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  }

  const save = async (shot: Picture): Promise<ScreenshotSaved> => {
    const uri = `content://media/external/images/media/${1000 + ++seq}`
    gallery.set(uri, shot)
    return {
      uri,
      thumbnail: await thumbnail(shot, 320),
      width: shot.width,
      height: shot.height,
      bytes: shot.bytes
    }
  }

  return {
    'screenshot.capture': async ({ tabId }) => {
      const frame = frameOf(String(tabId))
      if (!frame) return null
      const [shot] = await Promise.all([picture(frame, 1), flash(frame)])
      // A `screenshot=flash` still: the frame mid-flash, before the save answers and the card
      // comes up (on a device the write to the gallery follows the flash).
      if (previewFlashHold() !== null) return new Promise<ScreenshotSaved | null>(() => undefined)
      return save(shot)
    },
    'screenshot.captureLong': async ({ tabId }): Promise<LongCapture | null> => {
      const frame = frameOf(String(tabId))
      if (!frame) return null
      // A `screenshot=editor&wait` still: the page never arrives, the editor keeps waiting.
      if (longHeld()) return new Promise<LongCapture | null>(() => undefined)
      const shot = await picture(frame, LONG_CAPTURE_SCREENS)
      const id = `long-${++seq}`
      held.set(id, shot)
      // The editor's picture at the frame's width in CSS px: the full one is kept for the crop.
      const image = await loadImage(shot.data)
      const scale = frame.clientWidth / shot.width
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(shot.width * scale))
      canvas.height = Math.max(1, Math.round(shot.height * scale))
      canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
      return {
        id,
        preview: canvas.toDataURL('image/jpeg', 0.8),
        width: shot.width,
        height: shot.height,
        viewportHeight: Math.round(shot.height / LONG_CAPTURE_SCREENS)
      }
    },
    'screenshot.saveLong': async ({ id, top, bottom, share }) => {
      const shot = held.get(String(id))
      if (!shot) return null
      held.delete(String(id))
      const from = Math.max(0, Math.min(shot.height - 1, Math.round(Number(top) || 0)))
      const to = Math.max(
        from + 1,
        Math.min(shot.height, Math.round(Number(bottom) || shot.height))
      )
      const image = await loadImage(shot.data)
      const canvas = document.createElement('canvas')
      canvas.width = shot.width
      canvas.height = to - from
      canvas.getContext('2d')?.drawImage(image, 0, -from)
      const data = canvas.toDataURL('image/png')
      const saved = await save({
        data,
        width: shot.width,
        height: to - from,
        bytes: Math.round((data.length - 22) * 0.75)
      })
      if (share) console.info('[zen preview] share screenshot', saved.uri)
      return saved
    },
    'screenshot.discardLong': ({ id }) => {
      held.delete(String(id))
    },
    'screenshot.share': async ({ uri }) => {
      const shot = gallery.get(String(uri))
      if (!shot) return
      if (typeof navigator.share === 'function') {
        const blob = await (await fetch(shot.data)).blob()
        const file = new File([blob], 'Screenshot.png', { type: 'image/png' })
        await navigator.share({ files: [file] }).catch(() => undefined)
      } else console.info('[zen preview] share screenshot', uri)
    },
    'screenshot.delete': ({ uri }) => gallery.delete(String(uri)),
    'screenshot.open': ({ uri }) => {
      const shot = gallery.get(String(uri))
      if (shot) window.open(shot.data, '_blank')
    }
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('picture failed'))
    img.src = src
  })
}

/**
 * A page the stand-in draws when the frame's document cannot be read (a cross-origin site): a
 * header band, a heading, paragraphs and a picture block per screen, in neutral greys – enough
 * for the card's thumbnail and the editor's long picture to read as a page.
 */
function drawStandInPage(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number
): void {
  const u = dpr
  ctx.fillStyle = '#f3f4f6'
  ctx.fillRect(0, 0, width, 56 * u)
  ctx.fillStyle = '#d1d5db'
  ctx.fillRect(16 * u, 20 * u, 96 * u, 16 * u)
  let y = 84 * u
  const line = (w: number, h: number, color: string): void => {
    ctx.fillStyle = color
    roundRect(ctx, 16 * u, y, w, h, 3 * u)
    y += h + 10 * u
  }
  while (y < height - 40 * u) {
    line(width * 0.7, 22 * u, '#1f2937')
    line(width * 0.45, 22 * u, '#1f2937')
    y += 8 * u
    for (let i = 0; i < 6 && y < height - 40 * u; i++)
      line(width - 32 * u - (i % 3) * 28 * u, 10 * u, '#9ca3af')
    y += 8 * u
    if (y + 200 * u < height) {
      ctx.fillStyle = '#e5e7eb'
      roundRect(ctx, 16 * u, y, width - 32 * u, 190 * u, 8 * u)
      y += 214 * u
    }
    for (let i = 0; i < 9 && y < height - 40 * u; i++)
      line(width - 32 * u - ((i * 7) % 5) * 22 * u, 10 * u, '#9ca3af')
    y += 24 * u
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
  ctx.fill()
}
