import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  PRINT_MESSAGES,
  defaultPrintSettings,
  pagesToPrint,
  parsePageRanges,
  pdfRenderOptions,
  printSummary,
  twoSidedAvailable,
  validateCopies,
  validateScale,
  type PrintCustomMargins,
  type PrintDestination,
  type PrintPagesMode,
  type PrintSessionInfo,
  type PrintSettings
} from '@shared/print'
import { cmd } from '@renderer/lib/api'
import { closePrintPreview } from '@renderer/lib/ui'
import { bytesFromBase64, closePdf, openPdf } from '@renderer/lib/pdfDocument'
import { marginInches, marginTexts, marginUnitFor, type MarginUnit } from './printForm'

/**
 * The print preview's state: the session `core/print.ts` opened for the tab, the settings as
 * the form edits them, the typed fields with Chrome's validation, and the PDF the page renders
 * to with those settings (`print.preview`), which the pane draws and the page count is read
 * from. The render is asked for again, 150 ms after the last change, whenever a setting that
 * lays the pages out moves (paper, layout, margins, scale, headers, background); the pages
 * picked, the copies, the colour and the destination change what is printed, not how the page
 * looks, so they leave the render alone – the pane just shows the pages picked out of it, as
 * Chrome's does. Print or Save (`print.run`) sends the preview's own PDF; while it runs the
 * form is busy (§9.30). Pure view logic; the dialog is a view of what this returns.
 */

/** How long the form waits after the last layout change before rendering again. */
const RENDER_DEBOUNCE_MS = 150

export type PreviewPhase =
  /** The session and the first render are on their way: nothing to draw yet. */
  | 'loading'
  /** A document is up; `rendering` says whether a fresh one is on its way over it. */
  | 'ready'
  /** The render failed (`error` says why); the last document, if any, stays up. */
  | 'failed'

export interface PrintTexts {
  pages: string
  copies: string
  scale: string
  margins: Record<keyof PrintCustomMargins, string>
}

export interface PrintErrors {
  pages: string | null
  copies: string | null
  scale: string | null
  margins: string | null
}

export interface PrintPreviewForm {
  session: PrintSessionInfo | null
  settings: PrintSettings
  texts: PrintTexts
  errors: PrintErrors
  unit: MarginUnit
  phase: PreviewPhase
  /** A render is on its way (the pane keeps the last document, dimmed). */
  rendering: boolean
  document: PDFDocumentProxy | null
  /** The document's page count, from the last full render; null before the first. */
  pageCount: number | null
  /** The pages of `document` the pane shows, 1-based: the selection, or every page. */
  shownPages: number[]
  /** Chrome's total line, or null while the page count is not known. */
  summary: string | null
  /** The last render's or run's failure, for the pane or the footer. */
  error: string | null
  /** Print / Save is at work (§9.30: the form is busy). */
  running: boolean
  /** Whether Print / Save may be pressed: a document, a page to print and no field in error. */
  canSubmit: boolean
  /** Whether the two-sided option applies to the destination. */
  twoSided: boolean
  more: boolean
  setMore: (open: boolean) => void
  setDestination: (destination: PrintDestination) => void
  update: (patch: Partial<PrintSettings>) => void
  setPagesMode: (mode: PrintPagesMode) => void
  setPagesText: (text: string) => void
  setCopiesText: (text: string) => void
  setScaleText: (text: string) => void
  setMarginText: (side: keyof PrintCustomMargins, text: string) => void
  submit: () => void
  cancel: () => void
  /** Chrome's "Print using system dialog…": the engine's own dialog for the page. */
  systemDialog: () => void
}

export function usePrintPreview(tabId: string): PrintPreviewForm {
  const [session, setSession] = useState<PrintSessionInfo | null>(null)
  const [settings, setSettings] = useState<PrintSettings | null>(null)
  const [texts, setTexts] = useState<PrintTexts>({
    pages: '',
    copies: '1',
    scale: '100',
    margins: { top: '', right: '', bottom: '', left: '' }
  })
  const [unit, setUnit] = useState<MarginUnit>('mm')
  const [phase, setPhase] = useState<PreviewPhase>('loading')
  const [rendering, setRendering] = useState(false)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [more, setMore] = useState(false)
  /** The last pages selection that parsed, for the pane while the field is in error. */
  const [validPages, setValidPages] = useState<PrintSettings['pages']>({ mode: 'all', custom: '' })
  /** The layout the document up was rendered with; the form is stale until the next matches. */
  const [renderedKey, setRenderedKey] = useState<string | null>(null)
  /**
   * The hook's life outside React's state: the render in flight (`seq`, stepped by every new
   * render and by unmount so a late answer is dropped), whether it is still mounted, and the
   * document held for the pane, which the next render or the unmount releases.
   */
  const life = useRef({ seq: 0, alive: true, doc: null as PDFDocumentProxy | null })

  // The session: the page's title, the printers and the settings to open with. A tab that
  // cannot be printed here has no preview to show.
  useEffect(() => {
    const me = life.current
    me.alive = true
    void cmd('print.session', { tabId }).then((info) => {
      if (!me.alive) return
      if (!info) {
        closePrintPreview()
        return
      }
      const marginUnit = marginUnitFor(navigator.language)
      setUnit(marginUnit)
      setSession(info)
      setSettings(info.settings)
      setValidPages(info.settings.pages)
      setTexts({
        pages: info.settings.pages.custom,
        copies: String(info.settings.copies),
        scale: String(info.settings.scale.percent),
        margins: marginTexts(info.settings.margins.custom, marginUnit)
      })
    })
    return () => {
      me.alive = false
      me.seq++
      closePdf(me.doc)
      me.doc = null
    }
  }, [tabId])

  // What lays the pages out: a change here renders again; the pages picked do not (the pane
  // shows the subset), nor do the copies, the colour or the destination.
  const layoutKey = settings ? JSON.stringify(pdfRenderOptions(settings, null)) : null
  useEffect(() => {
    if (!settings || layoutKey === null) return
    const me = life.current
    const seq = ++me.seq
    const timer = window.setTimeout(async () => {
      setRendering(true)
      // Every page renders (no count given): the pane shows the pages picked out of the whole,
      // and the count read from the PDF is the document's own.
      const result = await cmd('print.preview', { tabId, settings, pageCount: null })
      if (!me.alive || seq !== me.seq) return
      if (!result.ok) {
        setRendering(false)
        setPhase('failed')
        setError(result.error)
        return
      }
      try {
        const doc = await openPdf(bytesFromBase64(result.pdf))
        if (!me.alive || seq !== me.seq) {
          closePdf(doc)
          return
        }
        closePdf(me.doc)
        me.doc = doc
        setDocument(doc)
        setPageCount(doc.numPages)
        setRenderedKey(layoutKey)
        setPhase('ready')
        setError(null)
      } catch (e) {
        setPhase('failed')
        setError(
          `${PRINT_MESSAGES.previewFailed}${e instanceof Error && e.message ? ` (${e.message})` : ''}`
        )
      } finally {
        if (me.alive && seq === me.seq) setRendering(false)
      }
    }, RENDER_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // The settings object changes with every edit; the key says whether the layout did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, layoutKey])

  const update = useCallback((patch: Partial<PrintSettings>): void => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
  }, [])

  const setDestination = useCallback(
    (destination: PrintDestination): void => {
      setSettings((s) => {
        if (!s) return s
        const printers = session?.printers ?? []
        return {
          ...s,
          destination,
          // A printer that cannot print two-sided drops the option; a PDF has no sides.
          twoSided: s.twoSided && twoSidedAvailable(destination, printers)
        }
      })
    },
    [session]
  )

  const setPagesText = useCallback(
    (text: string): void => {
      setTexts((t) => ({ ...t, pages: text }))
      setSettings((s) => (s ? { ...s, pages: { mode: 'custom', custom: text } } : s))
      const parsed = parsePageRanges(text, pageCount)
      if (parsed.ok) setValidPages({ mode: 'custom', custom: text })
    },
    [pageCount]
  )

  const setCopiesText = useCallback((text: string): void => {
    setTexts((t) => ({ ...t, copies: text }))
    const v = validateCopies(text)
    if (v.ok) setSettings((s) => (s ? { ...s, copies: v.value } : s))
  }, [])

  const setScaleText = useCallback((text: string): void => {
    setTexts((t) => ({ ...t, scale: text }))
    const v = validateScale(text)
    if (v.ok) setSettings((s) => (s ? { ...s, scale: { mode: 'custom', percent: v.value } } : s))
  }, [])

  const setMarginText = useCallback(
    (side: keyof PrintCustomMargins, text: string): void => {
      setTexts((t) => ({ ...t, margins: { ...t.margins, [side]: text } }))
      setSettings((s) => {
        if (!s) return s
        const inches = marginInches(text, unit, s.paperSize)
        if (inches === null) return s
        return {
          ...s,
          margins: { mode: 'custom', custom: { ...s.margins.custom, [side]: inches } }
        }
      })
    },
    [unit]
  )

  // The Pages menu: leaving Custom keeps the typed range for the next time; the pane follows
  // whatever selection parses.
  const setPagesMode = useCallback(
    (mode: PrintPagesMode): void => {
      const pages = { mode, custom: texts.pages }
      setSettings((s) => (s ? { ...s, pages } : s))
      if (mode !== 'custom' || parsePageRanges(texts.pages, pageCount).ok) setValidPages(pages)
    },
    [texts.pages, pageCount]
  )

  const errors = useMemo<PrintErrors>(() => {
    if (!settings) return { pages: null, copies: null, scale: null, margins: null }
    const pages =
      settings.pages.mode === 'custom'
        ? (() => {
            const parsed = parsePageRanges(texts.pages, pageCount)
            return parsed.ok ? null : parsed.error
          })()
        : null
    const copies = (() => {
      const v = validateCopies(texts.copies)
      return v.ok ? null : v.error
    })()
    const scale =
      settings.scale.mode === 'custom'
        ? (() => {
            const v = validateScale(texts.scale)
            return v.ok ? null : v.error
          })()
        : null
    const margins =
      settings.margins.mode === 'custom' &&
      (['top', 'right', 'bottom', 'left'] as const).some(
        (side) => marginInches(texts.margins[side], unit, settings.paperSize) === null
      )
        ? 'Use a number'
        : null
    return { pages, copies, scale, margins }
  }, [settings, texts, pageCount, unit])

  const shownPages = useMemo(() => {
    if (pageCount === null) return []
    const picked = pagesToPrint(validPages, pageCount)
    return picked.length > 0 ? picked : []
  }, [validPages, pageCount])

  const submit = useCallback((): void => {
    if (!settings || running || pageCount === null) return
    if (errors.pages || errors.copies || errors.scale || errors.margins) return
    if (pagesToPrint(settings.pages, pageCount).length === 0) return
    setRunning(true)
    setError(null)
    void cmd('print.run', { tabId, settings, pageCount }).then((result) => {
      if (!life.current.alive) return
      if (!result.ok) {
        setRunning(false)
        setError(result.error)
        return
      }
      if (result.action === 'cancelled') {
        // The save dialog was dismissed: the preview stays, as Chrome's does.
        setRunning(false)
        return
      }
      closePrintPreview()
    })
  }, [tabId, settings, running, pageCount, errors])

  const cancel = useCallback((): void => closePrintPreview(), [])

  const systemDialog = useCallback((): void => {
    closePrintPreview()
    void cmd('page.print', { tabId })
  }, [tabId])

  const effective = settings ?? session?.settings ?? defaultPrintSettings(navigator.language)
  const summary = printSummary(effective, pageCount)
  const twoSided = twoSidedAvailable(effective.destination, session?.printers ?? [])
  // Chrome greys Print while the preview is behind the settings: the document up must be the
  // one these settings lay out, so the count and the pages it will send are the ones shown.
  const canSubmit =
    settings !== null &&
    document !== null &&
    pageCount !== null &&
    renderedKey === layoutKey &&
    !rendering &&
    !running &&
    !errors.pages &&
    !errors.copies &&
    !errors.scale &&
    !errors.margins &&
    pagesToPrint(settings.pages, pageCount).length > 0

  return {
    session,
    settings: effective,
    texts,
    errors,
    unit,
    phase,
    rendering,
    document,
    pageCount,
    shownPages,
    summary,
    error,
    running,
    canSubmit,
    twoSided,
    more,
    setMore,
    setDestination,
    update,
    setPagesMode,
    setPagesText,
    setCopiesText,
    setScaleText,
    setMarginText,
    submit,
    cancel,
    systemDialog
  }
}
