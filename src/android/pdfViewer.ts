/**
 * The PDF viewer document (`zen://pdf`; the shell in `shared/pdfPage.ts`, the arithmetic in
 * `pdfViewerLogic.ts`): Chrome Android's inline viewer on pdf.js, built into the app's assets
 * (`vite.android.config.ts --mode pdf`) and served by the Kotlin host from the viewer's origin.
 *
 * The document draws the pages – a continuous column, fitted to the width to begin with as
 * Chrome fits them – and owns what happens on them: pinch and double tap to zoom, the links a
 * page carries, the highlights of a search. Everything else is the chrome's: it learns where
 * the viewer stands from the reports this posts on its window (`pdfViewerProtocol.ts`; the page
 * script relays them) and drives it through `window.__zeniumPdf.command`.
 */
// First: what pdf.js expects of an engine older WebViews (Chromium 113 on the emulator) lack.
import './pdfViewerPolyfills'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import {
  PDF_VIEWER_GLOBAL,
  PDF_VIEWER_MESSAGE_KEY,
  PDF_VIEWER_TOKEN_KEY,
  steppedZoom,
  type PdfFitMode,
  type PdfOutlineItem,
  type PdfViewerCommand,
  type PdfViewerReport
} from '@shared/pdfViewerProtocol'
import {
  annotationRect,
  canvasScale,
  clampZoom,
  CSS_UNITS,
  doubleTapZoom,
  failureText,
  findInRuns,
  findOrder,
  fitZoom,
  matchKey,
  matchRect,
  mergeMatches,
  nextMatchIndex,
  OUTLINE_LIMIT,
  pageInView,
  pagesToRender,
  pinchOf,
  pinchZoom,
  scrollAfterZoom,
  type FractionRect,
  type PageBand,
  type PageSize,
  type Pinch,
  type TextMatch,
  type TextRun
} from './pdfViewerLogic'

/** What the shell wrote for this document (`pdfViewerPageHtml`). */
interface ViewerConfig {
  id: string
  name: string
  /** The document's token, posted beside every report (`PdfDocumentInfo.token`). */
  token: string
  src: string
  workerSrc: string
}

interface PageSlot {
  index: number
  page: PDFPageProxy | null
  /** The page's size in points at rotation 0. */
  size: PageSize
  element: HTMLDivElement
  canvas: HTMLCanvasElement | null
  hits: HTMLDivElement
  links: HTMLDivElement
  /** The zoom and rotation the canvas holds, or null while it holds nothing. */
  drawn: { zoom: number; rotation: number } | null
  rendering: { task: RenderTask; zoom: number; rotation: number } | null
  text: TextRun[] | null
  linksDrawn: boolean
}

const config = (window as unknown as { __zeniumPdfDocument?: ViewerConfig }).__zeniumPdfDocument
/**
 * The box the pages pan in, the size of the screen (`pdfPage.ts`): the viewer's scroll offset,
 * viewport and page positions are all the scroller's, never the window's – a wide-viewport
 * WebView grows the window's layout viewport past the screen once a page is wider than it.
 */
const scroller = document.getElementById('scroller') as HTMLDivElement
const pagesRoot = document.getElementById('pages') as HTMLDivElement
const status = document.getElementById('status') as HTMLDivElement

pdfjs.GlobalWorkerOptions.workerSrc = config?.workerSrc ?? ''

/**
 * pdf.js's worker for a document that runs under the PDF's own URL (`pdfViewerBaseUrl`), where
 * the viewer's files are another origin's. A worker cannot be made from a cross-origin script
 * URL; pdf.js would wrap one in a blob that `import()`s it from inside the worker – a request
 * of the worker's, which the host cannot answer (its `useWorkerFetch: false` reason) – and fall
 * back to running the worker's code on the main thread. So the document fetches the script
 * itself (a request of its own, which the host answers with CORS) and the worker runs off a
 * blob of it; `workerPort` hands it to pdf.js. The worker asks the host for nothing: pdf.js's
 * data files reach it from here. A document on the viewer's own origin leaves pdf.js its
 * same-origin worker; null then, and when the script cannot be fetched (pdf.js's fallback).
 */
async function crossOriginWorker(workerSrc: string): Promise<Worker | null> {
  let src: URL
  try {
    src = new URL(workerSrc, location.href)
  } catch {
    return null
  }
  if (!workerSrc || src.origin === location.origin) return null
  try {
    const response = await fetch(src)
    if (!response.ok) return null
    const blob = new Blob([await response.text()], { type: 'text/javascript' })
    return new Worker(URL.createObjectURL(blob), { type: 'module' })
  } catch {
    return null
  }
}

class Viewer {
  private doc: PDFDocumentProxy | null = null
  private readonly slots: PageSlot[] = []
  private zoom = 1
  private fit: PdfFitMode | null = 'width'
  private rotation = 0
  private title: string | null = null
  private outline: PdfOutlineItem[] = []
  private state: PdfViewerReport['state'] = 'loading'
  private error: string | undefined
  private passwordWrong = false
  private pendingPassword: ((password: string) => void) | null = null
  private current = 0
  private matches: TextMatch[] = []
  private matchIndex = -1
  /** Pages remain to be read for the query: the tally is still growing. */
  private searching = false
  private findQuery = ''
  private findGeneration = 0
  private reportTimer: number | null = null
  private layoutFrame: number | null = null
  private pinch: Pinch | null = null
  /** Where the pinch stands: the zoom the fingers ask for and where they are now. */
  private pinched: { zoom: number; centre: { x: number; y: number } } | null = null
  private pinching = false
  /** A single finger that landed: a tap unless it travels or lingers. */
  private touchDown: { at: number; x: number; y: number } | null = null
  private lastTap: { at: number; x: number; y: number } | null = null

  constructor(private readonly config: ViewerConfig) {}

  async open(): Promise<void> {
    this.showStatus('Loading…')
    const worker = await crossOriginWorker(this.config.workerSrc)
    if (worker) pdfjs.GlobalWorkerOptions.workerPort = worker
    const task = pdfjs.getDocument({
      url: this.config.src,
      // The host answers requests of the document, not of its worker: pdf.js's data files are
      // fetched here and handed over.
      useWorkerFetch: false,
      cMapUrl: this.asset('cmaps/'),
      standardFontDataUrl: this.asset('standard_fonts/'),
      wasmUrl: this.asset('wasm/'),
      iccUrl: this.asset('iccs/')
    })
    task.onPassword = (update: (password: string) => void, reason: number): void => {
      this.pendingPassword = update
      this.passwordWrong = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD
      this.state = 'password'
      this.showStatus(
        this.passwordWrong ? 'Incorrect password.' : 'This document is password protected.'
      )
      this.report()
    }
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }): void => {
      if (this.state !== 'loading' || !total) return
      this.showStatus(`Loading… ${Math.min(99, Math.round((loaded / total) * 100))}%`)
    }
    let doc: PDFDocumentProxy
    try {
      doc = await task.promise
    } catch (error) {
      this.state = 'error'
      this.error = failureText(error)
      this.showStatus(this.error)
      this.report()
      return
    }
    this.doc = doc
    this.pendingPassword = null
    this.passwordWrong = false
    await this.layoutPages(doc)
    this.state = 'ready'
    status.hidden = true
    this.installGestures()
    this.report()
    void this.readMetadata(doc)
    void this.readOutline(doc)
  }

  /** The chrome's command; anything the state cannot take is ignored. */
  command(command: PdfViewerCommand): void {
    switch (command.kind) {
      case 'zoom':
        this.setZoom(clampZoom(command.factor), null)
        return
      case 'zoomBy':
        this.setZoom(steppedZoom(this.zoom, command.steps), null)
        return
      case 'fit':
        this.setFit(command.mode)
        return
      case 'goTo':
        this.goTo(command.page)
        return
      case 'find':
        void this.find(command.query, command.direction)
        return
      case 'stopFind':
        this.stopFind()
        return
      case 'rotate':
        this.rotation = (this.rotation + 90) % 360
        if (this.fit) this.zoom = this.fitted(this.fit)
        this.relayout()
        return
      case 'password':
        if (this.pendingPassword) {
          const update = this.pendingPassword
          this.pendingPassword = null
          this.state = 'loading'
          this.showStatus('Loading…')
          update(command.password)
        }
        return
      case 'report':
        this.report(true)
        return
    }
  }

  // --- layout ------------------------------------------------------------------------------

  private async layoutPages(doc: PDFDocumentProxy): Promise<void> {
    const first = await doc.getPage(1)
    const firstSize = sizeOf(first)
    for (let i = 0; i < doc.numPages; i++) {
      const element = document.createElement('div')
      element.className = 'zen-pdf-page'
      element.dataset.page = String(i + 1)
      const hits = document.createElement('div')
      hits.className = 'zen-pdf-hits'
      const links = document.createElement('div')
      links.className = 'zen-pdf-links'
      element.append(links, hits)
      pagesRoot.append(element)
      this.slots.push({
        index: i,
        page: i === 0 ? first : null,
        // Every page is given the first one's size until it is opened: a mixed document settles
        // its heights as they are read (`ensurePage`).
        size: firstSize,
        element,
        canvas: null,
        hits,
        links,
        drawn: null,
        rendering: null,
        text: null,
        linksDrawn: false
      })
    }
    // The sizes of the pages ahead, so a fit to the widest page and the page count's heights are
    // right from the start; a long document reads the rest as it scrolls.
    const upfront = Math.min(doc.numPages, 24)
    for (let i = 1; i < upfront; i++) await this.ensurePage(this.slots[i])
    this.zoom = this.fitted(this.fit ?? 'width')
    this.relayout()
  }

  private async ensurePage(slot: PageSlot): Promise<PDFPageProxy | null> {
    if (slot.page || !this.doc) return slot.page
    try {
      const page = await this.doc.getPage(slot.index + 1)
      slot.page = page
      slot.size = sizeOf(page)
      this.sizeElement(slot)
      return page
    } catch {
      return null
    }
  }

  private rotatedSize(slot: PageSlot): PageSize {
    const turned = this.rotation % 180 !== 0
    return turned ? { width: slot.size.height, height: slot.size.width } : slot.size
  }

  private fitted(mode: PdfFitMode): number {
    const sizes = this.slots.map((s) => this.rotatedSize(s))
    return fitZoom(mode, sizes, viewportSize())
  }

  private sizeElement(slot: PageSlot): void {
    const size = this.rotatedSize(slot)
    slot.element.style.width = `${Math.round(size.width * CSS_UNITS * this.zoom)}px`
    slot.element.style.height = `${Math.round(size.height * CSS_UNITS * this.zoom)}px`
  }

  /** Every page to its size at the zoom and rotation; the visible ones redrawn. */
  private relayout(): void {
    for (const slot of this.slots) this.sizeElement(slot)
    this.scheduleLayout()
    this.report()
  }

  private scheduleLayout(): void {
    if (this.layoutFrame !== null) return
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = null
      this.onViewportMoved()
    })
  }

  /** Each page's band down the scroller, in css px from its top edge. */
  private bands(): PageBand[] {
    const origin = scroller.getBoundingClientRect().top
    return this.slots.map((slot) => {
      const rect = slot.element.getBoundingClientRect()
      return { top: rect.top - origin, bottom: rect.bottom - origin }
    })
  }

  /** Scroll or zoom moved the pages under the window: the page in view, and what to draw. */
  private onViewportMoved(): void {
    if (!this.doc || this.pinching) return
    const bands = this.bands()
    const { height } = viewportSize()
    const inView = pageInView(bands, height)
    if (inView !== this.current) {
      this.current = inView
      this.report()
    }
    const { render, keep } = pagesToRender(bands, height)
    for (const slot of this.slots) {
      if (render.has(slot.index)) void this.draw(slot)
      else if (!keep.has(slot.index)) this.release(slot)
    }
  }

  private async draw(slot: PageSlot): Promise<void> {
    const page = await this.ensurePage(slot)
    if (!page) return
    const zoom = this.zoom
    const rotation = this.rotation
    if (slot.drawn && slot.drawn.zoom === zoom && slot.drawn.rotation === rotation) return
    if (slot.rendering) {
      if (slot.rendering.zoom === zoom && slot.rendering.rotation === rotation) return
      slot.rendering.task.cancel()
      slot.rendering = null
    }
    const size = this.rotatedSize(slot)
    const scale = canvasScale(size, zoom, window.devicePixelRatio || 1)
    const viewport = page.getViewport({ scale: CSS_UNITS * zoom * scale, rotation })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    const task = page.render({ canvas, viewport })
    slot.rendering = { task, zoom, rotation }
    try {
      await task.promise
    } catch {
      // Cancelled: a newer render took over, or the page went out of range.
      if (slot.rendering?.task === task) slot.rendering = null
      return
    }
    if (slot.rendering?.task !== task) return
    slot.rendering = null
    slot.canvas?.remove()
    slot.canvas = canvas
    slot.element.prepend(canvas)
    slot.drawn = { zoom, rotation }
    if (!slot.linksDrawn) void this.drawLinks(slot, page)
  }

  /** A page far from the window gives its bitmap back; its box keeps the column in place. */
  private release(slot: PageSlot): void {
    if (slot.rendering) {
      slot.rendering.task.cancel()
      slot.rendering = null
    }
    if (slot.canvas) {
      slot.canvas.remove()
      slot.canvas = null
    }
    slot.drawn = null
  }

  // --- zoom --------------------------------------------------------------------------------

  private setFit(mode: PdfFitMode): void {
    this.fit = mode
    const zoom = this.fitted(mode)
    if (mode === 'page' && this.current > 0) {
      this.zoom = zoom
      this.relayout()
      this.goTo(this.current)
      return
    }
    this.setZoom(zoom, null, true)
  }

  /**
   * Zoom about `focus` (a document point and where it is on screen), or about the middle of the
   * window when there is none. A zoom the user chose ends the fit, unless `keepFit`.
   */
  private setZoom(
    zoom: number,
    focus: { point: { x: number; y: number }; centre: { x: number; y: number } } | null,
    keepFit = false
  ): void {
    const from = this.zoom
    if (Math.abs(zoom - from) < 1e-6) {
      if (!keepFit) this.fit = null
      this.report()
      return
    }
    const centre = focus?.centre ?? middleOf(viewportSize())
    const point = focus?.point ?? documentPoint(centre)
    this.zoom = zoom
    if (!keepFit) this.fit = null
    for (const slot of this.slots) this.sizeElement(slot)
    const scroll = scrollAfterZoom(point, from, zoom, centre)
    scroller.scrollTo(scroll.x, scroll.y)
    this.scheduleLayout()
    this.report()
  }

  private goTo(page: number): void {
    const slot = this.slots[Math.round(page) - 1]
    if (!slot) return
    const top =
      slot.element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      8
    scroller.scrollTo(scroller.scrollLeft, Math.max(0, top))
    this.scheduleLayout()
  }

  private installGestures(): void {
    scroller.addEventListener('scroll', () => this.scheduleLayout(), { passive: true })
    window.addEventListener('resize', () => {
      if (this.fit) this.zoom = this.fitted(this.fit)
      this.relayout()
    })
    document.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length < 2) {
          const t = e.touches[0]
          this.touchDown = t ? { at: performance.now(), x: t.clientX, y: t.clientY } : null
          return
        }
        this.touchDown = null
        e.preventDefault()
        this.beginPinch(e)
      },
      { passive: false }
    )
    document.addEventListener(
      'touchmove',
      (e) => {
        if (!this.pinch || e.touches.length !== 2) return
        e.preventDefault()
        this.movePinch(e)
      },
      { passive: false }
    )
    const end = (e: TouchEvent): void => {
      if (this.pinch) {
        if (e.touches.length < 2) this.endPinch()
        return
      }
      const down = this.touchDown
      this.touchDown = null
      if (e.type !== 'touchend' || !down || e.touches.length !== 0) return
      const touch = e.changedTouches[0]
      if (!touch) return
      const still = Math.hypot(touch.clientX - down.x, touch.clientY - down.y) < 12
      if (still && performance.now() - down.at < 300) this.onTap(touch)
      else this.lastTap = null
    }
    document.addEventListener('touchend', end)
    document.addEventListener('touchcancel', end)
  }

  private beginPinch(e: TouchEvent): void {
    if (e.touches.length !== 2) {
      this.pinch = null
      return
    }
    this.pinch = pinchOf([e.touches[0], e.touches[1]].map(screenTouch), this.zoom, {
      x: scroller.scrollLeft,
      y: scroller.scrollTop
    })
    this.pinching = true
    this.pinched = null
    this.lastTap = null
    if (this.pinch)
      pagesRoot.style.transformOrigin = `${this.pinch.focus.x}px ${this.pinch.focus.y}px`
  }

  private movePinch(e: TouchEvent): void {
    const pinch = this.pinch
    if (!pinch) return
    const [a, b] = [e.touches[0], e.touches[1]].map(screenPoint)
    const distance = Math.hypot(b.x - a.x, b.y - a.y)
    const zoom = pinchZoom(pinch, distance)
    const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const dx = centre.x - pinch.centre.x
    const dy = centre.y - pinch.centre.y
    // The pages follow the fingers as a picture until they lift; then they are drawn afresh.
    pagesRoot.style.transform = `translate(${dx}px, ${dy}px) scale(${zoom / pinch.startZoom})`
    this.pinched = { zoom, centre }
  }

  private endPinch(): void {
    const pinch = this.pinch
    const pinched = this.pinched
    this.pinch = null
    this.pinched = null
    this.pinching = false
    pagesRoot.style.transform = ''
    if (!pinch) return
    if (!pinched) {
      this.scheduleLayout()
      return
    }
    this.setZoom(pinched.zoom, { point: pinch.focus, centre: pinched.centre })
  }

  /** Chrome Android's double tap: a fit to twice it about the tap, and back. */
  private onTap(touch: Touch): void {
    const now = performance.now()
    const last = this.lastTap
    this.lastTap = { at: now, x: touch.clientX, y: touch.clientY }
    if (
      !last ||
      now - last.at > 300 ||
      Math.hypot(touch.clientX - last.x, touch.clientY - last.y) > 40
    )
      return
    this.lastTap = null
    const fitted = this.fitted('width')
    const zoom = doubleTapZoom(this.zoom, fitted)
    const centre = screenPoint(touch)
    this.setZoom(zoom, { point: documentPoint(centre), centre })
    if (Math.abs(zoom - fitted) < 0.01) this.fit = 'width'
  }

  // --- links -------------------------------------------------------------------------------

  private async drawLinks(slot: PageSlot, page: PDFPageProxy): Promise<void> {
    slot.linksDrawn = true
    let annotations: Array<Record<string, unknown>>
    try {
      annotations = (await page.getAnnotations({ intent: 'display' })) as Array<
        Record<string, unknown>
      >
    } catch {
      return
    }
    const viewport = page.getViewport({ scale: 1, rotation: this.rotation })
    const convert = viewportRect(viewport)
    for (const annotation of annotations) {
      if (annotation.subtype !== 'Link') continue
      const rect = annotationRect(annotation.rect as number[], convert, viewport)
      if (!rect) continue
      const anchor = document.createElement('a')
      anchor.className = 'zen-pdf-link'
      place(anchor, rect)
      const url = typeof annotation.url === 'string' ? annotation.url : null
      if (url && /^https?:/i.test(url)) {
        anchor.href = url
        anchor.rel = 'noreferrer'
      } else if (annotation.dest) {
        anchor.href = '#'
        const dest = annotation.dest as string | unknown[]
        anchor.addEventListener('click', (e) => {
          e.preventDefault()
          void this.goToDestination(dest)
        })
      } else continue
      slot.links.append(anchor)
    }
  }

  private async goToDestination(dest: string | unknown[]): Promise<void> {
    const page = await this.pageOfDestination(dest)
    if (page) this.goTo(page)
  }

  private async pageOfDestination(dest: string | unknown[] | null): Promise<number | null> {
    if (!this.doc || !dest) return null
    try {
      const explicit = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest
      const ref = explicit?.[0]
      if (!ref) return null
      if (typeof ref === 'number') return ref + 1
      return (await this.doc.getPageIndex(ref as { num: number; gen: number })) + 1
    } catch {
      return null
    }
  }

  // --- find --------------------------------------------------------------------------------

  private async find(query: string, direction: 'new' | 'next' | 'prev'): Promise<void> {
    if (!this.doc) return
    const fresh = direction === 'new' || query !== this.findQuery
    if (fresh) {
      const generation = ++this.findGeneration
      this.findQuery = query
      this.matches = []
      this.matchIndex = -1
      this.searching = Boolean(query.trim())
      this.clearHits()
      this.report()
      if (!this.searching) return
      // Chrome's find: the pages read from the one in view, the first match current the moment
      // it is found and the tally growing as later pages come in, in reading order.
      for (const pageNumber of findOrder(this.slots.length, this.current || 1)) {
        const slot = this.slots[pageNumber - 1]
        if (!slot) continue
        const runs = await this.textOf(slot)
        if (generation !== this.findGeneration) return
        const found = findInRuns(runs, query, pageNumber)
        if (found.length) {
          const first = this.matchIndex < 0
          const merged = mergeMatches(this.matches, found, this.matchIndex)
          this.matches = merged.matches
          this.matchIndex = merged.current
          this.paintHits(slot, found)
          if (first) this.markCurrent()
          this.report()
        }
      }
      this.searching = false
      this.report()
      return
    }
    this.matchIndex = nextMatchIndex(this.matches, this.matchIndex, direction, this.current || 1)
    this.markCurrent()
    this.report()
  }

  private stopFind(): void {
    this.findGeneration++
    this.findQuery = ''
    this.matches = []
    this.matchIndex = -1
    this.searching = false
    this.clearHits()
    this.report()
  }

  private async textOf(slot: PageSlot): Promise<TextRun[]> {
    if (slot.text) return slot.text
    const page = await this.ensurePage(slot)
    if (!page) return []
    try {
      const content = await page.getTextContent()
      slot.text = content.items
        .filter((item): item is TextItem => 'str' in item)
        .map((item) => ({
          str: item.str,
          transform: item.transform,
          width: item.width,
          height: item.height
        }))
    } catch {
      slot.text = []
    }
    return slot.text
  }

  private paintHits(slot: PageSlot, matches: TextMatch[]): void {
    const page = slot.page
    if (!page || !slot.text) return
    const viewport = page.getViewport({ scale: 1, rotation: this.rotation })
    const convert = viewportRect(viewport)
    for (const match of matches) {
      const run = slot.text[match.run]
      const rect = run ? matchRect(run, match, convert, viewport) : null
      if (!rect) continue
      const hit = document.createElement('div')
      hit.className = 'zen-pdf-hit'
      hit.dataset.match = matchKey(match)
      place(hit, rect)
      slot.hits.append(hit)
    }
  }

  private clearHits(): void {
    for (const slot of this.slots) slot.hits.replaceChildren()
  }

  private markCurrent(): void {
    for (const el of pagesRoot.querySelectorAll('.zen-pdf-hit.current'))
      el.classList.remove('current')
    const match = this.matches[this.matchIndex]
    if (!match) return
    const slot = this.slots[match.page - 1]
    const el = slot?.hits.querySelector(`[data-match="${matchKey(match)}"]`)
    if (el) {
      el.classList.add('current')
      el.scrollIntoView({ block: 'center', inline: 'center' })
      this.scheduleLayout()
    } else this.goTo(match.page)
  }

  // --- metadata ----------------------------------------------------------------------------

  private async readMetadata(doc: PDFDocumentProxy): Promise<void> {
    try {
      const { info } = await doc.getMetadata()
      const title = (info as { Title?: unknown }).Title
      if (typeof title === 'string' && title.trim()) {
        this.title = title.trim()
        document.title = this.title
        this.report()
      }
    } catch {
      // No metadata: the file's name stays the title.
    }
  }

  private async readOutline(doc: PDFDocumentProxy): Promise<void> {
    try {
      const raw = await doc.getOutline()
      if (!raw?.length) return
      let count = 0
      const convert = async (
        items: Array<{ title: string; dest: string | unknown[] | null; items: unknown[] }>
      ): Promise<PdfOutlineItem[]> => {
        const out: PdfOutlineItem[] = []
        for (const item of items) {
          if (count >= OUTLINE_LIMIT) break
          count++
          out.push({
            title: item.title,
            page: await this.pageOfDestination(item.dest),
            children: await convert(item.items as typeof items)
          })
        }
        return out
      }
      this.outline = await convert(raw as Parameters<typeof convert>[0])
      this.report()
    } catch {
      this.outline = []
    }
  }

  // --- reports -----------------------------------------------------------------------------

  /** pdf.js's data folders, beside the worker under the viewer's origin. */
  private asset(path: string): string {
    return new URL(path, this.config.workerSrc).toString()
  }

  private showStatus(text: string): void {
    status.hidden = false
    status.textContent = ''
    const p = document.createElement('p')
    p.textContent = text
    status.append(p)
  }

  private snapshot(): PdfViewerReport {
    return {
      state: this.state,
      pageCount: this.doc?.numPages ?? 0,
      page: this.current,
      zoom: this.zoom,
      fit: this.fit,
      title: this.title,
      find: this.findQuery
        ? {
            query: this.findQuery,
            current: this.matchIndex + 1,
            total: this.matches.length,
            searching: this.searching
          }
        : null,
      outline: this.outline,
      ...(this.error ? { error: this.error } : {}),
      ...(this.state === 'password' ? { passwordWrong: this.passwordWrong } : {})
    }
  }

  /** Post the state, coalescing a burst of changes into one message (at once when `now`). */
  private report(now = false): void {
    if (this.reportTimer !== null) {
      if (!now) return
      clearTimeout(this.reportTimer)
      this.reportTimer = null
    }
    const post = (): void => {
      this.reportTimer = null
      window.postMessage(
        { [PDF_VIEWER_MESSAGE_KEY]: this.snapshot(), [PDF_VIEWER_TOKEN_KEY]: config?.token ?? '' },
        location.origin
      )
    }
    if (now) post()
    else this.reportTimer = window.setTimeout(post, 40)
  }
}

function sizeOf(page: PDFPageProxy): PageSize {
  const viewport = page.getViewport({ scale: 1 })
  return { width: viewport.width, height: viewport.height }
}

/**
 * The scroller's box in CSS pixels – the area on screen, since the scroller fills the window
 * and the window never grows past the screen (`pdfPage.ts`): what the pages are fitted to and
 * what "in view" is measured against. Neither `innerHeight` (a wide-viewport WebView's grown
 * layout viewport) nor the visual viewport (an engine's own scale) stand in.
 */
function viewportSize(): { width: number; height: number } {
  const root = document.documentElement
  return {
    width: scroller.clientWidth || root.clientWidth,
    height: scroller.clientHeight || root.clientHeight
  }
}

/** A touch's position within the scroller's box. */
function screenPoint(touch: { clientX: number; clientY: number }): { x: number; y: number } {
  const box = scroller.getBoundingClientRect()
  return { x: touch.clientX - box.left, y: touch.clientY - box.top }
}

/** [screenPoint] under a touch's own field names, for `pinchOf`. */
function screenTouch(touch: { clientX: number; clientY: number }): {
  clientX: number
  clientY: number
} {
  const point = screenPoint(touch)
  return { clientX: point.x, clientY: point.y }
}

/** The point of the pages under a position on screen: the scroller's offset added. */
function documentPoint(screen: { x: number; y: number }): { x: number; y: number } {
  return { x: scroller.scrollLeft + screen.x, y: scroller.scrollTop + screen.y }
}

function middleOf(size: { width: number; height: number }): { x: number; y: number } {
  return { x: size.width / 2, y: size.height / 2 }
}

/** A rectangle in the page's user space → its two corners in viewport pixels (pdf.js 6 dropped `convertToViewportRectangle`). */
function viewportRect(
  viewport: PageViewport
): (rect: [number, number, number, number]) => number[] {
  return ([x0, y0, x1, y1]) => {
    const a = viewport.convertToViewportPoint(x0, y0) as number[]
    const b = viewport.convertToViewportPoint(x1, y1) as number[]
    return [a[0], a[1], b[0], b[1]]
  }
}

function place(el: HTMLElement, rect: FractionRect): void {
  el.style.left = `${(rect.left * 100).toFixed(3)}%`
  el.style.top = `${(rect.top * 100).toFixed(3)}%`
  el.style.width = `${(rect.width * 100).toFixed(3)}%`
  el.style.height = `${(rect.height * 100).toFixed(3)}%`
}

if (config) {
  const viewer = new Viewer(config)
  ;(window as unknown as Record<string, unknown>)[PDF_VIEWER_GLOBAL] = {
    command: (command: PdfViewerCommand) => viewer.command(command)
  }
  void viewer.open()
}
