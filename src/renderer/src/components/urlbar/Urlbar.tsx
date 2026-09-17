import type { JSX, RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Bookmark, Clock, Globe, Layers, Search, Terminal, X } from 'lucide-react'
import type { PhoneBarLayout, PhoneBarPosition, Rect, Suggestion, UIState } from '@shared/types'
import { BAR_BUTTON, BAR_GAP, BAR_PADDING } from '@shared/phoneBar'
import { ERROR_URL_PREFIX, BLANK_URL } from '@shared/url'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { cmd, run } from '@renderer/lib/api'
import { useBackDismissal } from '@renderer/lib/back'
import { viewportStore } from '@renderer/lib/formFactor'
import { closeUrlbar, uiStore, type UrlbarState } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'

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

function initialTextFor(state: UIState, urlbar: UrlbarState): string {
  if (urlbar.initialText !== undefined) return urlbar.initialText
  if (urlbar.mode !== 'edit' || !urlbar.tabId) return drafts.get('new') ?? ''
  const tab = state.tabs[urlbar.tabId]
  if (!tab) return ''
  const draft = drafts.get(`${tab.id}|${tab.url}`)
  if (draft !== undefined) return draft
  if (tab.url === BLANK_URL) return ''
  if (tab.url.startsWith(ERROR_URL_PREFIX)) {
    try {
      return new URL(tab.url).searchParams.get('url') ?? ''
    } catch {
      return ''
    }
  }
  return tab.url
}

export function Urlbar({ state, urlbar, area, phoneEdge }: Props): JSX.Element {
  const [text, setText] = useState(() => initialTextFor(state, urlbar))
  const [results, setResults] = useState<Suggestion[]>([])
  const [selected, setSelected] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const fadeResults = useFadeEdges<HTMLUListElement>({ axis: 'y' })
  const requestSeq = useRef(0)
  const lastTyped = useRef(text)
  const engine =
    state.searchEngines.find((e) => e.id === state.settings.searchEngineId) ??
    state.searchEngines[0]
  const tab = urlbar.tabId ? state.tabs[urlbar.tabId] : null

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    // Everything selected, read from the start: `select()` alone puts the caret end at the tail
    // and scrolls a long URL so only its query is visible. A backward selection keeps the focus
    // end – the one the field scrolls to – at the origin.
    el.setSelectionRange(0, el.value.length, 'backward')
    el.scrollLeft = 0
  }, [])

  const fetchSuggestions = useCallback(
    async (query: string, autofill: boolean) => {
      const seq = ++requestSeq.current
      const list = await cmd('urlbar.suggest', { query, tabId: urlbar.tabId }).catch(
        () => [] as Suggestion[]
      )
      if (seq !== requestSeq.current) return
      setResults(list)
      setSelected(-1)
      const first = list[0]
      const el = inputRef.current
      if (
        autofill &&
        first &&
        first.kind === 'url' &&
        el &&
        first.fill.toLowerCase().startsWith(query.toLowerCase()) &&
        first.fill.length > query.length
      ) {
        // Inline completion: keep what was typed, select the completed remainder.
        el.value = first.fill
        setText(first.fill)
        el.setSelectionRange(query.length, first.fill.length)
      }
    },
    [urlbar.tabId]
  )

  useEffect(() => {
    const timer = setTimeout(() => void fetchSuggestions(lastTyped.current, false), 0)
    return () => clearTimeout(timer)
  }, [fetchSuggestions])

  const onChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value
    const grew = value.length > lastTyped.current.length && value.startsWith(lastTyped.current)
    lastTyped.current = value
    setText(value)
    void fetchSuggestions(value, grew && !/\s/.test(value))
  }

  const clear = (): void => {
    lastTyped.current = ''
    setText('')
    void fetchSuggestions('', false)
    inputRef.current?.focus()
  }

  const close = useCallback(
    (keepDraft: boolean) => {
      const key = tab ? `${tab.id}|${tab.url}` : 'new'
      if (keepDraft && text.trim() && text !== tab?.url) drafts.set(key, text)
      else drafts.delete(key)
      closeUrlbar()
    },
    [tab, text]
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

  const submit = (
    item: Suggestion | null,
    opts: { newTab?: boolean; background?: boolean } = {}
  ): void => {
    const value = text.trim()
    const newTab = opts.newTab || urlbar.mode === 'new-tab' || !tab
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
        case 'bookmark':
          // Through the bookmark so its "last used" date is recorded.
          if (item.targetId && !opts.background) {
            run('bookmark.open', { id: item.targetId, newTab, tabId: tab?.id ?? null })
            break
          }
          if (item.url)
            run('urlbar.submit', {
              input: item.url,
              newTab,
              tabId: tab?.id ?? null,
              background: opts.background
            })
          break
        default:
          if (item.url)
            run('urlbar.submit', {
              input: item.url,
              newTab,
              tabId: tab?.id ?? null,
              background: opts.background
            })
      }
    } else {
      if (!value) return
      run('urlbar.submit', {
        input: value,
        newTab,
        tabId: tab?.id ?? null,
        background: opts.background
      })
    }
    drafts.delete(tab ? `${tab.id}|${tab.url}` : 'new')
    drafts.delete('new')
    closeUrlbar()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        close(true)
        return
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Tab': {
        if (results.length === 0) return
        e.preventDefault()
        const dir = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1
        const next = selected + dir
        const wrapped = next < -1 ? results.length - 1 : next >= results.length ? -1 : next
        setSelected(wrapped)
        const el = inputRef.current
        if (el) {
          const fill =
            wrapped === -1
              ? lastTyped.current
              : results[wrapped].fill || results[wrapped].url || lastTyped.current
          el.value = fill
          setText(fill)
          requestAnimationFrame(() => el.setSelectionRange(fill.length, fill.length))
        }
        return
      }
      case 'Enter':
        e.preventDefault()
        submit(selected >= 0 ? results[selected] : null, {
          newTab: e.altKey,
          background: e.altKey && e.shiftKey
        })
        return
      case 'Delete':
        if (selected >= 0 && results[selected]?.kind === 'history' && results[selected].url) {
          e.preventDefault()
          run('history.delete', { url: results[selected].url! })
          setResults((r) => r.filter((_, i) => i !== selected))
          setSelected(-1)
        }
        return
    }
  }

  const floating = !urlbar.attached
  const width = Math.min(680, (area?.width ?? 0) - 32)
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
    urlbar.mode === 'search' ? `Search with ${engine.name}` : 'Search or enter address'

  const rows = (sheet: boolean): JSX.Element[] =>
    results.map((item, i) => (
      <SuggestionRow
        key={item.id}
        item={item}
        selected={i === selected}
        sheet={sheet}
        onHover={() => setSelected(i)}
        onPick={(e) => submit(item, { newTab: e.altKey || e.button === 1 })}
      />
    ))

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
            className="zen-omnibox-field flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full pl-2 pr-1.5"
            style={fieldGrowFrom(state.settings.phoneBar)}
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
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="go"
              className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--zen-muted)]"
            />
            {text && (
              <button
                type="button"
                className="zen-toolbar-button h-8 w-8 shrink-0 rounded-full"
                aria-label="Clear"
                // Keep the input focused so the keyboard stays where it is.
                onPointerDown={(e) => e.preventDefault()}
                onClick={clear}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        }
      />
    )
  }

  return (
    <div className="absolute inset-0 z-30" onMouseDown={() => close(true)}>
      <div
        ref={panelRef}
        className={cn(
          'zen-panel zen-animate-in absolute flex flex-col overflow-hidden',
          floating ? 'rounded-2xl' : 'rounded-xl'
        )}
        style={style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-3 px-4">
          <span
            className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--zen-element-bg)] text-[11px] font-semibold"
            title={`Search engine: ${engine.name}`}
          >
            {engine.glyph}
          </span>
          <input
            ref={inputRef}
            value={text}
            onChange={onChange}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--zen-muted)]"
          />
          {tab && urlbar.mode === 'edit' && (
            <span className="rounded-md bg-[var(--zen-element-bg)] px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide text-[var(--zen-muted)]">
              Current tab
            </span>
          )}
        </div>
        {results.length > 0 && (
          <ul
            ref={fadeResults}
            className="min-h-0 max-h-[420px] flex-1 overflow-y-auto border-t border-[var(--zen-border)] p-1.5"
          >
            {rows(false)}
          </ul>
        )}
        <div className="zen-kbd-hint flex h-7 shrink-0 items-center gap-3 border-t border-[var(--zen-border)] px-4 text-[10.5px] text-[var(--zen-muted)]">
          <span>
            <kbd className="zen-kbd">↵</kbd> Open
          </span>
          <span>
            <kbd className="zen-kbd">Alt ↵</kbd> New tab
          </span>
          <span>
            <kbd className="zen-kbd font-mono">` ␣</kbd> Spaces
          </span>
          <span>
            <kbd className="zen-kbd">@ddg</kbd> Engine
          </span>
          <span className="flex-1" />
          <span>Type a command like “compact mode”</span>
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
  item,
  selected,
  sheet,
  onHover,
  onPick
}: {
  item: Suggestion
  selected: boolean
  /** A row of the phone sheet: touch height (44), the desktop list keeps 36. */
  sheet: boolean
  onHover: () => void
  onPick: (e: React.MouseEvent) => void
}): JSX.Element {
  const touch = useRef(false)
  const Icon =
    item.kind === 'search'
      ? Search
      : item.kind === 'history'
        ? Clock
        : item.kind === 'bookmark'
          ? Bookmark
          : item.kind === 'command'
            ? Terminal
            : item.kind === 'space'
              ? Layers
              : Globe
  return (
    <li
      className={cn(
        'zen-suggestion flex shrink-0 cursor-default items-center gap-3 px-2.5',
        sheet ? 'zen-suggestion-sheet h-11' : 'h-9'
      )}
      data-selected={selected}
      onMouseEnter={onHover}
      onPointerDown={(e) => {
        // Keep the input focused (no blur → no keyboard flicker on phones). A mouse picks on
        // press like Firefox; a finger picks on tap so the list can still be scrolled.
        e.preventDefault()
        if (e.pointerType === 'mouse') onPick(e)
        else touch.current = true
      }}
      onClick={(e) => {
        if (!touch.current) return
        touch.current = false
        onPick(e)
      }}
    >
      {item.favicon ? (
        <img
          src={item.favicon}
          alt=""
          className="h-4 w-4 rounded-[3px]"
          referrerPolicy="no-referrer"
        />
      ) : (
        <Icon className="h-4 w-4 shrink-0 opacity-60" />
      )}
      <span className={cn('min-w-0 flex-1 truncate', sheet ? 'text-[14px]' : 'text-[13.5px]')}>
        {item.title}
      </span>
      <span
        className={cn(
          'max-w-[45%] truncate text-[var(--zen-muted)]',
          sheet ? 'text-[13px]' : 'text-[12px]'
        )}
      >
        {item.subtitle}
      </span>
      {item.kind === 'tab' && <ArrowRight className="h-3.5 w-3.5 opacity-50" />}
    </li>
  )
}
