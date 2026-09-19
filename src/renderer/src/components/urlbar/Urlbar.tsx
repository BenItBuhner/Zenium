import type { JSX, RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Camera, Mic, X } from 'lucide-react'
import type {
  PhoneBarLayout,
  PhoneBarPosition,
  Rect,
  Suggestion,
  Tab,
  UIState
} from '@shared/types'
import {
  BAR_BUTTON,
  BAR_GAP,
  BAR_PADDING,
  phoneBarForHost,
  phoneBarOffered
} from '@shared/phoneBar'
import { SEARCH_SCOPES, completeWwwCom, matchKeyword } from '@shared/search'
import { internalPageAliasUrl } from '@shared/internalPages'
import { ERROR_URL_PREFIX, isEmptyTabUrl, isNewTabUrl } from '@shared/url'
import { qrScanAvailable } from '@shared/qrScan'
import { voiceSearchAvailable } from '@shared/voice'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { cmd, run } from '@renderer/lib/api'
import { useBackDismissal } from '@renderer/lib/back'
import { dropStore } from '@renderer/lib/drag'
import { viewportStore } from '@renderer/lib/formFactor'
import { startQrScan } from '@renderer/lib/qrScan'
import { closeUrlbar, uiStore, type UrlbarState } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { startVoiceSearch } from '@renderer/lib/voiceSearch'
import { suggestionIcon } from './suggestionIcon'

interface Props {
  state: UIState
  urlbar: UrlbarState
  /** Content area the bar floats in (desktop layouts); null for the phone sheet. */
  area: Rect | null
  /**
   * Phone layout: the edge the address bar is docked at. The field takes the bar's own band and
   * the suggestions fill the content frame, growing away from it towards the middle of the screen.
   */
  phoneEdge?: PhoneBarPosition
}

/** Zen remembers what you typed until you navigate away. */
const drafts = new Map<string, string>()
let keywordSeq = 0

/**
 * The text the field holds for a page: its address, the address an error page stands in for, or
 * an internal page's user-facing `zenium://` alias (`zen://` never shows; v2 §10.1). Empty tabs –
 * blank and the new tab page alike – hold nothing, as Chrome's omnibox does there.
 */
function pageTextFor(tab: Tab): string {
  if (isEmptyTabUrl(tab.url)) return ''
  if (tab.url.startsWith(ERROR_URL_PREFIX)) {
    try {
      return new URL(tab.url).searchParams.get('url') ?? ''
    } catch {
      return ''
    }
  }
  return internalPageAliasUrl(tab.url)
}

function initialTextFor(state: UIState, urlbar: UrlbarState): string {
  if (urlbar.initialText !== undefined) return urlbar.initialText
  if (urlbar.mode !== 'edit' || !urlbar.tabId) return drafts.get('new') ?? ''
  const tab = state.tabs[urlbar.tabId]
  if (!tab) return ''
  const draft = drafts.get(`${tab.id}|${tab.url}`)
  if (draft !== undefined) return draft
  return pageTextFor(tab)
}

/** The completion tail is selected: the caret's selection runs from inside the text to its end. */
function hasCompletionTail(el: HTMLInputElement): boolean {
  return (
    el.selectionStart !== null &&
    el.selectionEnd !== null &&
    el.selectionStart < el.selectionEnd &&
    el.selectionEnd === el.value.length
  )
}

export function Urlbar({ state, urlbar, area, phoneEdge }: Props): JSX.Element {
  const [text, setText] = useState(() => initialTextFor(state, urlbar))
  const [results, setResults] = useState<Suggestion[]>([])
  const [selected, setSelected] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const fadeResults = useFadeEdges<HTMLUListElement>({ axis: 'y' })
  const requestSeq = useRef(0)
  /** What the user typed, without any inline completion the field shows after it. */
  const lastTyped = useRef(text)
  /** An IME composition is under way: nothing is completed inline until it is committed. */
  const composing = useRef(false)
  const engines = state.searchEngines
  const defaultEngine = engines.find((e) => e.id === state.settings.searchEngineId) ?? engines[0]
  const tab = urlbar.tabId ? state.tabs[urlbar.tabId] : null

  // Keyword mode (`@ddg cats`, `@bookmarks foo`): the chip names where the search goes.
  const keyword = useMemo(() => matchKeyword(text.trimStart(), engines), [text, engines])
  const engine = keyword?.kind === 'engine' ? keyword.engine : defaultEngine
  const scopeLabel =
    keyword?.kind === 'scope'
      ? (SEARCH_SCOPES.find((s) => s.scope === keyword.scope)?.label ?? keyword.scope)
      : null
  // The scope labels already read "Search bookmarks" / "Search history" / "Search tabs".
  const chipLabel = keyword
    ? keyword.kind === 'engine'
      ? `Search ${keyword.engine.name}`
      : scopeLabel
    : null

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (urlbar.typed) {
      // Text the user typed into the new tab page before the bar was up: carry on after it.
      el.setSelectionRange(el.value.length, el.value.length)
      return
    }
    // Everything selected, read from the start: `select()` alone puts the caret end at the tail
    // and scrolls a long URL so only its query is visible. A backward selection keeps the focus
    // end – the one the field scrolls to – at the origin.
    el.setSelectionRange(0, el.value.length, 'backward')
    el.scrollLeft = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on mount
  }, [])

  const fetchSuggestions = useCallback(
    async (query: string, autofill: boolean) => {
      const seq = ++requestSeq.current
      const list = await cmd('urlbar.suggest', { query, tabId: urlbar.tabId }).catch(
        () => [] as Suggestion[]
      )
      if (seq !== requestSeq.current) return
      setResults(list)
      const first = list[0]
      const el = inputRef.current
      // Inline completion of the default match (Chrome's rule, decided in the core: the top row
      // outranks the verbatim query and extends what was typed): what was typed stays as typed,
      // the remainder is appended selected, so typing on replaces it and Backspace removes it.
      // Only while the field still shows the text the request was for, with the caret at its
      // end and no IME composition under way.
      if (
        autofill &&
        first?.inline &&
        el &&
        !composing.current &&
        el.value === query &&
        el.selectionStart === query.length &&
        el.selectionEnd === query.length &&
        first.fill.length > query.length &&
        first.fill.toLowerCase().startsWith(query.toLowerCase())
      ) {
        const fill = query + first.fill.slice(query.length)
        el.value = fill
        setText(fill)
        el.setSelectionRange(query.length, fill.length)
        setSelected(0)
      } else {
        setSelected(-1)
      }
    },
    [urlbar.tabId]
  )

  useEffect(() => {
    // Typed text behaves as if typed here: inline completion applies to it from the start.
    const autofill = Boolean(urlbar.typed) && !/\s/.test(lastTyped.current)
    const timer = setTimeout(() => void fetchSuggestions(lastTyped.current, autofill), 0)
    return () => clearTimeout(timer)
  }, [fetchSuggestions, urlbar.typed])

  // Keys the new tab page's search box received while this bar was already open (a keystroke
  // that raced the focus hand-off): spliced in at the caret as if typed here.
  useEffect(() => {
    const onType = (e: Event): void => {
      const el = inputRef.current
      const typed = (e as CustomEvent<string>).detail
      if (!el || !typed) return
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? el.value.length
      const value = el.value.slice(0, start) + typed + el.value.slice(end)
      el.value = value
      el.setSelectionRange(start + typed.length, start + typed.length)
      el.focus()
      const grew = value.length > lastTyped.current.length && value.startsWith(lastTyped.current)
      lastTyped.current = value
      setText(value)
      void fetchSuggestions(value, grew && !/\s/.test(value))
    }
    window.addEventListener('zen-urlbar-type', onType)
    return () => window.removeEventListener('zen-urlbar-type', onType)
  }, [fetchSuggestions])

  const onChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value
    const grew = value.length > lastTyped.current.length && value.startsWith(lastTyped.current)
    const caretAtEnd = e.target.selectionStart === value.length
    lastTyped.current = value
    setText(value)
    setSelected(-1)
    // A deletion, an edit in the middle or a composition in progress never re-inlines.
    const native = e.nativeEvent as Event & { isComposing?: boolean }
    void fetchSuggestions(value, grew && caretAtEnd && !composing.current && !native.isComposing)
  }

  /** Put `value` in the field with the caret at its end, as the text the user now "typed". */
  const setTyped = (value: string, refetch: boolean): void => {
    lastTyped.current = value
    setText(value)
    const el = inputRef.current
    if (el) {
      el.value = value
      el.setSelectionRange(value.length, value.length)
    }
    if (refetch) void fetchSuggestions(value, false)
  }

  const clear = (): void => {
    setTyped('', true)
    inputRef.current?.focus()
  }

  // A picked keyword row (`@d` → `@ddg `) becomes the typed text once the pick has rendered: the
  // row's click handler itself stays clear of the field's refs.
  const [keywordFill, setKeywordFill] = useState<{ fill: string; seq: number } | null>(null)
  useEffect(() => {
    if (!keywordFill) return
    const { fill } = keywordFill
    lastTyped.current = fill
    const el = inputRef.current
    if (el) {
      el.value = fill
      el.setSelectionRange(fill.length, fill.length)
    }
    void fetchSuggestions(fill, false)
  }, [keywordFill, fetchSuggestions])

  // A new-tab draft is shared by every new tab page, as it is for the bar without a tab.
  const draftKey = tab && urlbar.mode !== 'new-tab' ? `${tab.id}|${tab.url}` : 'new'
  const close = useCallback(
    (keepDraft: boolean) => {
      if (keepDraft && text.trim() && (!tab || text !== pageTextFor(tab))) {
        drafts.set(draftKey, text)
      } else drafts.delete(draftKey)
      // An extension's omnibox session, if one was on, ends without an entry.
      run('urlbar.cancel', undefined)
      closeUrlbar()
    },
    [draftKey, tab, text]
  )

  // The system back gesture lifts the bar away like a sheet off the top edge, fading as it goes;
  // commit closes it keeping the draft, like Escape, cancel springs it back. On the phone the
  // suggestions sheet shrinks towards the bar's edge and the field settles back into the pill.
  const panelRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLDivElement>(null)
  useBackDismissal('urlbar', {
    travel: 320,
    render: (v) => {
      const sheet = sheetRef.current
      if (sheet) {
        sheet.style.transform = `scale(${1 - 0.08 * v})`
        sheet.style.opacity = String(1 - 0.6 * v)
        const field = fieldRef.current
        if (field) field.style.opacity = String(1 - 0.5 * v)
        return
      }
      const el = panelRef.current
      if (!el) return
      el.style.transformOrigin = '50% 0%'
      el.style.transform = `translateY(${-100 * v}%) scale(${1 - 0.06 * v})`
      el.style.opacity = String(1 - 0.7 * v)
    },
    dismissed: () => close(true)
  })

  /**
   * Whether a plain submit opens a new tab: without a tab, or in new-tab mode – except over a new
   * tab page, which the bar edits (what is typed loads there, no second tab).
   */
  const submitsToNewTab = (): boolean => {
    const overNewTabPage = urlbar.mode === 'new-tab' && Boolean(tab && isNewTabUrl(tab.url))
    return !tab || (urlbar.mode === 'new-tab' && !overNewTabPage)
  }

  const submit = (
    item: Suggestion | null,
    opts: { newTab?: boolean; background?: boolean; input?: string } = {}
  ): void => {
    const value = (opts.input ?? text).trim()
    const newTab = opts.newTab || submitsToNewTab()
    const navigate = (input: string): void =>
      run('urlbar.submit', {
        input,
        newTab,
        tabId: tab?.id ?? null,
        background: opts.background
      })
    if (item) {
      switch (item.kind) {
        case 'tab':
          if (item.targetId) run('tab.activate', { tabId: item.targetId })
          break
        case 'space':
          if (item.targetId) run('space.activate', { spaceId: item.targetId })
          break
        case 'command':
          if (item.targetId) run('urlbar.runCommand', { action: item.targetId })
          break
        case 'engine':
          // A keyword to complete (`@d` → `@ddg `): the field enters keyword mode and stays open.
          setText(item.fill)
          setKeywordFill({ fill: item.fill, seq: ++keywordSeq })
          return
        case 'omnibox':
          // The keyword-prefixed text goes back whole: the extension takes it from there.
          navigate(item.fill)
          break
        case 'bookmark':
          // Through the bookmark so its "last used" date is recorded.
          if (item.targetId && !opts.background) {
            run('bookmark.open', { id: item.targetId, newTab, tabId: tab?.id ?? null })
            break
          }
          if (item.url) navigate(item.url)
          break
        case 'search':
          // `@bookmarks foo` / `@history foo`: the typed text carries the scope the core acts on.
          if (item.id === 'scope') navigate(value)
          else if (item.url) navigate(item.url)
          break
        default:
          if (item.url) navigate(item.url)
      }
    } else {
      if (!value) return
      navigate(value)
    }
    drafts.delete(draftKey)
    drafts.delete('new')
    closeUrlbar()
  }

  const removeHistoryRow = (index: number): boolean => {
    const row = results[index]
    if (!row || row.kind !== 'history' || !row.url) return false
    run('history.delete', { url: row.url })
    setResults((r) => r.filter((_, i) => i !== index))
    setSelected(-1)
    setTyped(lastTyped.current, false)
    return true
  }

  const removeOmniboxRow = (index: number): boolean => {
    const row = results[index]
    if (!row || row.kind !== 'omnibox' || !row.deletable) return false
    run('urlbar.deleteSuggestion', { input: row.fill })
    setResults((r) => r.filter((_, i) => i !== index))
    setSelected(-1)
    setTyped(lastTyped.current, false)
    return true
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const el = inputRef.current
    if (e.nativeEvent.isComposing) return
    switch (e.key) {
      case 'Escape': {
        e.preventDefault()
        const pageText = tab && urlbar.mode === 'edit' ? pageTextFor(tab) : null
        if (pageText !== null && text !== pageText) {
          // Esc restores the page's address (selected, read from the start) and closes the popup;
          // a second Esc closes the bar. The draft is gone with the edit.
          requestSeq.current++
          drafts.delete(draftKey)
          lastTyped.current = pageText
          setText(pageText)
          setResults([])
          setSelected(-1)
          if (el) {
            el.value = pageText
            el.setSelectionRange(0, pageText.length, 'backward')
            el.scrollLeft = 0
          }
          return
        }
        close(pageText === null)
        return
      }
      case 'Tab': {
        // Tab accepts the inline completion (design language v2 §9.22); otherwise it moves the
        // selection like the arrows.
        if (el && hasCompletionTail(el) && !e.shiftKey) {
          e.preventDefault()
          setTyped(el.value, true)
          return
        }
        if (results.length === 0) return
        e.preventDefault()
        moveSelection(e.shiftKey ? -1 : 1)
        return
      }
      case 'ArrowDown':
      case 'ArrowUp':
        if (results.length === 0) return
        e.preventDefault()
        moveSelection(e.key === 'ArrowUp' ? -1 : 1)
        return
      case 'ArrowRight':
      case 'End':
        // The caret collapses to the end natively; the completion is now what was typed.
        if (el && hasCompletionTail(el) && !e.shiftKey) lastTyped.current = el.value
        return
      case 'Enter': {
        e.preventDefault()
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+Enter: `www.` and `.com` around what was typed, never the completion.
          const typed = el && hasCompletionTail(el) ? lastTyped.current : text
          submit(null, { input: completeWwwCom(typed), newTab: e.altKey })
          return
        }
        submit(selected >= 0 ? results[selected] : null, {
          newTab: e.altKey,
          background: e.altKey && e.shiftKey
        })
        return
      }
      case 'Delete':
        // Shift+Delete removes the highlighted history row (Chrome); plain Delete does too when a
        // row is highlighted, since the field's caret then has nothing to delete. An omnibox row
        // its extension marked deletable goes the same way (`omnibox.onDeleteSuggestion`).
        if (selected >= 0 && (removeHistoryRow(selected) || removeOmniboxRow(selected)))
          e.preventDefault()
        return
    }
  }

  const moveSelection = (dir: 1 | -1): void => {
    const next = selected + dir
    const wrapped = next < -1 ? results.length - 1 : next >= results.length ? -1 : next
    setSelected(wrapped)
    const el = inputRef.current
    if (!el) return
    const row = wrapped >= 0 ? results[wrapped] : null
    const fill = row ? row.fill || row.url || lastTyped.current : lastTyped.current
    el.value = fill
    setText(fill)
    requestAnimationFrame(() => el.setSelectionRange(fill.length, fill.length))
  }

  const floating = !urlbar.attached
  const width = Math.min(907, (area?.width ?? 0) - 32)
  const style = useMemo(() => {
    if (!area) return undefined
    const top = floating ? Math.max(24, area.height * 0.16) : 8
    return {
      left: floating ? (area.width - width) / 2 : 8,
      top,
      width: floating ? width : area.width - 16,
      // Never grow past the content area – on phones the keyboard takes most of it.
      maxHeight: Math.max(120, area.height - top - 8)
    }
  }, [floating, area, width])

  const placeholder =
    keyword || urlbar.mode === 'search' ? `Search with ${engine.name}` : 'Search or enter address'
  // The field's native context menu ("Paste and Go") acts on the tab a submit would: the current
  // one while editing, a new one from the new-tab bar (`data-zen-menu`, read by the main process).
  const menuTabId = urlbar.mode === 'new-tab' || !tab ? undefined : tab.id

  const rows = (sheet: boolean): JSX.Element[] =>
    results.map((item, i) => (
      <SuggestionRow
        key={item.id}
        id={`zen-omnibox-row-${i}`}
        item={item}
        selected={i === selected}
        sheet={sheet}
        onPick={(e) => submit(item, { newTab: e.altKey || e.button === 1 })}
      />
    ))

  const activeRow = selected >= 0 ? `zen-omnibox-row-${selected}` : undefined
  // An address or text dragged over the field goes where a submit would (lib/dnd.ts, Chrome's
  // paste and go); the field shows it will take the drop (§9.4).
  const dropInto = dropStore.use((s) => s.key === 'address:')

  // The empty field's trailing controls (OMN-19, OMN-22), each where the host can answer it.
  const voice = voiceSearchAvailable(state.capabilities)
  const camera = qrScanAvailable(state.capabilities)

  if (phoneEdge) {
    return (
      <PhoneSheet
        edge={phoneEdge}
        sheetRef={sheetRef}
        fieldRef={fieldRef}
        onDismiss={() => close(true)}
        rows={rows(true)}
        hint={results.length === 0 && !text ? placeholder : null}
        field={
          <div
            // The trailing slot's control is a §9.3 icon button, 44 × 44 with the 20 glyph: as
            // tall as the pill, round, flush with its end, so it is the pill's end cap.
            className="zen-omnibox-field flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full pl-2"
            style={fieldGrowFrom(
              phoneBarForHost(state.settings.phoneBar, phoneBarOffered(state.capabilities))
            )}
          >
            <span
              role="img"
              aria-label={`Search engine: ${engine.name}`}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--zen-element-bg)] text-[11px] font-semibold"
            >
              {engine.glyph}
            </span>
            <input
              ref={inputRef}
              value={text}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
              placeholder={placeholder}
              data-testid="urlbar-input"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="go"
              data-zen-menu="urlbar"
              data-zen-menu-tab={menuTabId}
              className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--zen-muted)]"
            />
            {text ? (
              <button
                type="button"
                className="zen-toolbar-button h-11 w-11 shrink-0 rounded-full"
                aria-label="Clear"
                // Keep the input focused so the keyboard stays where it is.
                onPointerDown={(e) => e.preventDefault()}
                onClick={clear}
              >
                <X className="h-5 w-5" strokeWidth={1.75} />
              </button>
            ) : (
              (voice || camera) && (
                // OMN-19 and OMN-22: the empty field offers the mic and the camera where Clear
                // will be; the listening or scan sheet takes the frame from the bar, and its result
                // loads where a submit here would. The last control is the 44 px pill's round end
                // cap; one before it is the §9.3 box.
                <>
                  {voice && (
                    <button
                      type="button"
                      className={cn(
                        'zen-toolbar-button h-11 w-11 shrink-0',
                        !camera && 'rounded-full'
                      )}
                      aria-label="Search by voice"
                      onClick={() =>
                        void startVoiceSearch({ tabId: tab?.id ?? null, newTab: submitsToNewTab() })
                      }
                    >
                      <Mic className="h-5 w-5" strokeWidth={1.75} />
                    </button>
                  )}
                  {camera && (
                    <button
                      type="button"
                      className="zen-toolbar-button h-11 w-11 shrink-0 rounded-full"
                      aria-label="Scan a QR code"
                      onClick={() =>
                        void startQrScan({ tabId: tab?.id ?? null, newTab: submitsToNewTab() })
                      }
                    >
                      <Camera className="h-5 w-5" strokeWidth={1.75} />
                    </button>
                  )}
                </>
              )
            )}
          </div>
        }
      />
    )
  }

  /*
    The desktop bar on design language v2 §6 "Floating URL bar": a neutral opaque surface at radius
    12 with the URL bar shadow (anchored under the pill it is a popover, §9.20: radius 8, hairline,
    panel shadow), a 62 px field with a hairline under it, 50 px rows with a 16 px favicon, the
    title then ` — ` then the host at 69%. Page tokens only (§9.29).
  */
  return (
    <div className="absolute inset-0 z-30" onMouseDown={() => close(true)}>
      <div
        ref={panelRef}
        className="zen-omnibox zen-animate-in absolute flex flex-col overflow-hidden"
        data-surface="page"
        data-attached={!floating}
        style={style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="zen-omnibox-input-row flex shrink-0 items-center"
          data-drop-into={dropInto || undefined}
        >
          {chipLabel ? (
            <span className="zen-omnibox-badge" data-keyword-chip title={chipLabel}>
              {chipLabel}
            </span>
          ) : (
            <span className="zen-omnibox-engine" title={`Search engine: ${engine.name}`}>
              {engine.glyph}
            </span>
          )}
          <input
            ref={inputRef}
            value={text}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            placeholder={placeholder}
            data-testid="urlbar-input"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-label="Search or enter address"
            aria-autocomplete="both"
            aria-expanded={results.length > 0}
            aria-controls="zen-omnibox-results"
            aria-activedescendant={activeRow}
            data-zen-menu="urlbar"
            data-zen-menu-tab={menuTabId}
            className="zen-omnibox-input h-full min-w-0 flex-1 bg-transparent outline-none"
          />
          {tab && urlbar.mode === 'edit' && <span className="zen-omnibox-badge">Current tab</span>}
        </div>
        {results.length > 0 && (
          <ul
            ref={fadeResults}
            id="zen-omnibox-results"
            role="listbox"
            className="zen-omnibox-results min-h-0 max-h-[520px] flex-1 overflow-y-auto"
          >
            {rows(false)}
          </ul>
        )}
        <div className="zen-omnibox-footer zen-kbd-hint flex shrink-0 items-center">
          <span>
            <kbd className="zen-omnibox-kbd">↵</kbd> Open
          </span>
          <span>
            <kbd className="zen-omnibox-kbd">Alt ↵</kbd> New tab
          </span>
          <span>
            <kbd className="zen-omnibox-kbd">Ctrl ↵</kbd> www.com
          </span>
          <span>
            <kbd className="zen-omnibox-kbd">Tab</kbd> Complete
          </span>
          <span>
            <kbd className="zen-omnibox-kbd">@</kbd> Engines, bookmarks, history, tabs
          </span>
          <span className="flex-1" />
          <span className="min-w-0 truncate">Type a command like “compact mode”</span>
        </div>
      </div>
    </div>
  )
}

/**
 * The phone's omnibox. The field sits exactly where the address pill was – in the bar band at
 * `edge`, riding the keyboard inset – and the suggestions take over the whole content frame,
 * ordered so the first one is nearest the field and the list grows towards the middle of the
 * screen. Nothing of the page shows through: the frame is the surface, whatever the keyboard's
 * height or the phone's orientation.
 */
function PhoneSheet({
  edge,
  field,
  rows,
  hint,
  onDismiss,
  sheetRef,
  fieldRef
}: {
  edge: PhoneBarPosition
  field: JSX.Element
  rows: JSX.Element[]
  /** Shown in the empty sheet before anything is typed. */
  hint: string | null
  onDismiss: () => void
  /** Painted by the back gesture (transform and opacity only). */
  sheetRef: RefObject<HTMLDivElement | null>
  fieldRef: RefObject<HTMLDivElement | null>
}): JSX.Element {
  const bottom = edge === 'bottom'
  // A long list dissolves at the edge that has more past it, like every scroller in the chrome.
  const fadeRows = useFadeEdges<HTMLUListElement>({ axis: 'y' })
  const bandStyle = {
    left: 'var(--zen-inset-left)',
    right: 'var(--zen-inset-right)',
    [bottom ? 'bottom' : 'top']: 0,
    paddingTop: bottom ? 6 : 'calc(var(--zen-inset-top) + 6px)',
    paddingBottom: bottom ? 'calc(var(--zen-inset-bottom) + 6px)' : 6
  }
  const sheetStyle = {
    left: 'calc(var(--zen-inset-left) + var(--zen-padding))',
    right: 'calc(var(--zen-inset-right) + var(--zen-padding))',
    top: bottom
      ? 'calc(var(--zen-inset-top) + var(--zen-padding))'
      : 'calc(var(--zen-inset-top) + var(--zen-phone-bar))',
    bottom: bottom
      ? 'calc(var(--zen-inset-bottom) + var(--zen-phone-bar))'
      : 'calc(var(--zen-inset-bottom) + var(--zen-padding))',
    transformOrigin: bottom ? '50% 100%' : '50% 0%'
  }
  return (
    <div className="absolute inset-0 z-30" onMouseDown={onDismiss}>
      <div
        ref={sheetRef}
        className="zen-omnibox-sheet zen-animate-fade absolute overflow-hidden"
        style={sheetStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {rows.length > 0 ? (
          <ul
            ref={fadeRows}
            className={cn(
              'absolute inset-0 flex overflow-y-auto p-1',
              bottom ? 'flex-col-reverse' : 'flex-col'
            )}
            style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}
          >
            {rows}
          </ul>
        ) : (
          hint && (
            <div className="absolute inset-0 flex items-center justify-center px-10 text-center text-[13px] text-[var(--zen-muted)]">
              {hint}
            </div>
          )
        )}
      </div>
      <div
        ref={fieldRef}
        className="absolute flex items-center px-2"
        style={bandStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {field}
      </div>
    </div>
  )
}

/**
 * Where the grow animation starts: the pill's slot as a shift and a scale of the band's inner
 * width, so the field's backdrop sets out exactly from where the pill was. The slot is what the
 * bar's buttons leave it: 44 px plus a 4 px gap for each control either side of the pill.
 */
function fieldGrowFrom(layout: PhoneBarLayout): React.CSSProperties {
  const { width } = viewportStore.get()
  const { left, right } = uiStore.get().insets
  const slotLeft = layout.left.length * (BAR_BUTTON + BAR_GAP)
  const slotRight = layout.right.length * (BAR_BUTTON + BAR_GAP)
  const band = width - left - right - 2 * BAR_PADDING
  const scale = band > slotLeft + slotRight ? (band - slotLeft - slotRight) / band : 0.5
  return {
    '--zen-field-shift': `${slotLeft}px`,
    '--zen-field-scale': scale.toFixed(3)
  } as React.CSSProperties
}

function SuggestionRow({
  id,
  item,
  selected,
  sheet,
  onPick
}: {
  id: string
  item: Suggestion
  /** The keyboard's highlight; hovering a row never moves it (Chrome), only a click picks. */
  selected: boolean
  /** A row of the phone sheet: touch height (44), the desktop list keeps v2's 50. */
  sheet: boolean
  onPick: (e: React.MouseEvent) => void
}): JSX.Element {
  const touch = useRef(false)
  // A favicon that fails to load leaves the kind's glyph, as Chrome's globe (never a blank cell).
  const [faviconBroken, setFaviconBroken] = useState(false)
  const { Icon, page } = suggestionIcon(item)
  const pointerProps = {
    onPointerDown: (e: React.PointerEvent) => {
      // Keep the input focused (no blur → no keyboard flicker on phones). A mouse picks on
      // press like Firefox; a finger picks on tap so the list can still be scrolled.
      e.preventDefault()
      if (e.pointerType === 'mouse') onPick(e)
      else touch.current = true
    },
    onClick: (e: React.MouseEvent) => {
      if (!touch.current) return
      touch.current = false
      onPick(e)
    }
  }
  const icon =
    item.favicon && !faviconBroken && !page ? (
      <img
        src={item.favicon}
        alt=""
        className="h-4 w-4 rounded-[3px]"
        referrerPolicy="no-referrer"
        onError={() => setFaviconBroken(true)}
      />
    ) : (
      <Icon className="h-4 w-4 shrink-0 opacity-60" />
    )
  if (sheet) {
    return (
      <li
        id={id}
        role="option"
        aria-selected={selected}
        className="zen-suggestion zen-suggestion-sheet flex h-11 shrink-0 cursor-default items-center gap-3 px-2.5"
        data-selected={selected}
        {...pointerProps}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-[14px]">{item.title}</span>
        <span className="max-w-[45%] truncate text-[13px] text-[var(--zen-muted)]">
          {item.subtitle}
        </span>
        {item.kind === 'tab' && <ArrowRight className="h-3.5 w-3.5 opacity-50" />}
      </li>
    )
  }
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      className="zen-omnibox-row flex shrink-0 cursor-default items-center"
      data-selected={selected}
      data-kind={item.kind}
      {...pointerProps}
    >
      <span className="zen-omnibox-row-icon flex shrink-0 items-center justify-center">{icon}</span>
      <span className="zen-omnibox-row-title">{item.title}</span>
      {item.subtitle && (
        <span className="zen-omnibox-row-host">
          <span aria-hidden="true"> — </span>
          {item.subtitle}
        </span>
      )}
      {item.kind === 'tab' && (
        <span className="zen-omnibox-row-hint">
          Switch to tab
          <ArrowRight className="h-3.5 w-3.5" />
        </span>
      )}
    </li>
  )
}
