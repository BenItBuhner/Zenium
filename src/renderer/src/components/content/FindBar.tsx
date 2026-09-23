import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { UIState } from '@shared/types'
import { findAnnouncement } from '@renderer/lib/announce'
import { run } from '@renderer/lib/api'
import { hint } from '@renderer/lib/shortcuts'
import { useViewport } from '@renderer/lib/formFactor'
import { isPdfViewerTab, pdfCommand, pdfViewerStore } from '@renderer/lib/pdfViewer'
import { closeFindBar, uiStore, type UiState } from '@renderer/lib/ui'
import { cn, findCounter } from '@renderer/lib/utils'

/**
 * The find bar, docked under the page (v2 §9.32): a `--v2-control` + 8 row on `--v2-panel` with
 * a hairline top edge – the shared 320 field (§9.12), then the match count 13/20 deemphasised,
 * then previous / next / close as the shared §9.3 icon buttons. On a phone it becomes one row of
 * 44px targets around a field that takes the remaining width. `docked="fullscreen"` is the bar
 * under a page in HTML fullscreen; it tells the main process how much of the window to leave it.
 *
 * The query lives in the UI store (`findText`), so the bar keeps it across a remount, and each
 * opening arrives as a `findRequest`: Ctrl+F re-selects the query (or brings the page's selection
 * in), F3 / Ctrl+G step to the next or previous match at once.
 *
 * Over the inline PDF viewer (`zen://pdf`, `lib/pdfViewer.ts`) the same bar searches the
 * document instead of the page's text: the query goes to the viewer as its `find` command and
 * the count is the viewer's tally, growing as its pages are read (Chrome's find in a PDF).
 */
export function FindBar({
  state,
  tabId,
  ui,
  docked
}: {
  state: UIState
  tabId: string
  ui: UiState
  docked: 'content' | 'fullscreen'
}): JSX.Element {
  const text = ui.findText
  const request = ui.findRequest
  const inputRef = useRef<HTMLInputElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  /** The query the page's find session is for ('' between sessions): only it can be followed up. */
  const session = useRef('')
  const pdf = isPdfViewerTab(state, tabId)
  const pdfFind = pdfViewerStore.use((s) => (pdf ? (s.reports[tabId]?.find ?? null) : null))
  const result = pdf
    ? pdfFind && pdfFind.query === text
      ? {
          tabId,
          activeMatchOrdinal: pdfFind.current,
          matches: pdfFind.total,
          searching: pdfFind.searching
        }
      : null
    : state.findResult?.tabId === tabId
      ? { ...state.findResult, searching: false }
      : null
  const phone = useViewport().formFactor === 'phone'

  const search = (value: string, forward: boolean): void => {
    // Stepping continues the session for that text; anything else starts one from the selection.
    const follow = value !== '' && session.current === value
    session.current = value
    if (pdf) {
      if (!value) pdfCommand(tabId, { kind: 'stopFind' })
      else
        pdfCommand(tabId, {
          kind: 'find',
          query: value,
          direction: follow ? (forward ? 'next' : 'prev') : 'new'
        })
      return
    }
    run('find.start', { tabId, text: value, forward, newSession: !follow })
  }

  // The bar leaving the viewer takes its marks with it (the core's `find.stop` reaches the page's
  // own find, which the viewer document does not use).
  useEffect(() => {
    if (!pdf) return
    return () => pdfCommand(tabId, { kind: 'stopFind' })
  }, [pdf, tabId])

  // Every opening focuses the field and selects the query so typing replaces it. A query that no
  // session is running for (the bar reopened with the last one, a selection came in) is searched
  // so its matches light up; F3 / Ctrl+G step on instead.
  useEffect(() => {
    const again = request?.again ?? null
    if (again) {
      if (text) search(text, again === 'next')
    } else if (text && text !== session.current) {
      search(text, true)
    }
    inputRef.current?.focus()
    inputRef.current?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per request; the rest is read as it stands then
  }, [request?.seq])

  // Under a fullscreen page the view is drawn by the main process; it makes room for the bar.
  useEffect(() => {
    if (docked !== 'fullscreen') return
    const el = barRef.current
    if (!el) return
    run('window.fullscreenInset', { bottom: el.getBoundingClientRect().height })
    return () => run('window.fullscreenInset', { bottom: 0 })
  }, [docked])

  const setText = (value: string): void => {
    uiStore.set({ findText: value })
    search(value, true)
  }

  const count = findCounter(text, result)
  // A tally still growing (the viewer reading its pages) is not "nothing found" yet.
  const noMatch = result !== null && result.matches === 0 && !result.searching
  // The count is the bar's own status region (a11y-35; Chrome's find bar's is one): polite, so
  // it waits for what the reader is saying, atomic, so it is read whole, and its words ("3 of 12
  // matches", "No matches") its accessible text, the figures the eye reads hidden from it. A
  // reader hears the region when its text changes, so it hears each count once: a keystroke
  // whose result reads the same (a miss after a miss, a lone match narrowed to a lone match)
  // leaves the node as it was, and nothing repeats. Nothing goes through the chrome's general
  // announcer for it, which would say the same words twice. The figures keep the `find-count`
  // test id the desktop smoke reads ("1/2"); the region is `find-status`.
  const words = findAnnouncement(text, result) ?? ''
  const counter = (className: string): JSX.Element => (
    <span
      className={className}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="find-status"
      data-no-match={noMatch ? 'true' : undefined}
    >
      <span aria-hidden="true" data-testid="find-count">
        {count}
      </span>
      {words && <span className="sr-only">{words}</span>}
    </span>
  )
  // The desktop's buttons are the shared §9.3 icon button (28, the 16 glyph at stroke 1.5); the
  // phone's are 44 boxes beside the 40 field (§9.12) in the bar's 56 (§9.21); the keyboard hints
  // are the desktop's tooltips (§9.31, components/Tooltip.tsx: on hover and on keyboard focus).
  const buttonClass = phone ? 'zen-toolbar-button h-11 w-11 rounded-[12px]' : 'zen-v2-icon-button'
  const glyphClass = phone ? 'h-5 w-5' : undefined
  const input = (
    <input
      ref={inputRef}
      value={text}
      placeholder="Find in page"
      // On the phone the placeholder names the field (A11Y-01): the WebView reads a text
      // field's label and its placeholder both, so the same words were heard twice.
      aria-label={phone ? undefined : 'Find in page'}
      data-testid="find-input"
      inputMode="search"
      enterKeyHint="search"
      autoCapitalize="none"
      autoComplete="off"
      spellCheck={false}
      className={
        phone
          ? 'h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--zen-muted)]'
          : 'zen-v2-field zen-find-field'
      }
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (text) search(text, !e.shiftKey)
        }
        if (e.key === 'Escape') closeFindBar('afterKey')
      }}
    />
  )

  return (
    <div
      ref={barRef}
      className={cn(
        'zen-animate-in flex items-center',
        phone ? 'zen-find-phone h-14 gap-1 bg-[var(--zen-bg-solid)] px-3' : 'zen-find-bar'
      )}
      role="search"
      aria-label="Find in page"
      data-surface={phone ? undefined : 'page'}
      data-testid="find-bar"
    >
      {phone ? (
        // The phone keeps Chrome's count inside its field.
        <div
          className="zen-squircle flex h-10 min-w-0 flex-1 items-center rounded-[10px] bg-[var(--zen-element-bg)] pl-3 pr-2.5"
          data-no-match={noMatch ? 'true' : undefined}
        >
          {input}
          {counter('shrink-0 pl-2 text-[13px] tabular-nums text-[var(--zen-muted)]')}
        </div>
      ) : (
        // The desktop's row (§9.32): the 320 field, then the count – the miss shows there alone.
        <>
          {input}
          {counter('zen-find-count')}
        </>
      )}
      <button
        type="button"
        className={buttonClass}
        data-tooltip={phone ? undefined : hint('Previous match', state, 'find.prev')}
        aria-label="Previous match"
        onClick={() => search(text, false)}
        disabled={!text || noMatch}
      >
        <ChevronUp className={glyphClass} aria-hidden />
      </button>
      <button
        type="button"
        className={buttonClass}
        data-tooltip={phone ? undefined : hint('Next match', state, 'find.next')}
        aria-label="Next match"
        onClick={() => search(text, true)}
        disabled={!text || noMatch}
      >
        <ChevronDown className={glyphClass} aria-hidden />
      </button>
      {!phone && <span className="flex-1" />}
      <button
        type="button"
        className={buttonClass}
        data-tooltip={phone ? undefined : 'Close (Esc)'}
        aria-label="Close find bar"
        onClick={() => closeFindBar()}
      >
        <X className={glyphClass} aria-hidden />
      </button>
    </div>
  )
}
