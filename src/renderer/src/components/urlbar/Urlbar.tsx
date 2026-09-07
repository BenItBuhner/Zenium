import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Bookmark, Clock, Globe, Layers, Search, Terminal } from 'lucide-react'
import type { Rect, Suggestion, UIState } from '@shared/types'
import { ERROR_URL_PREFIX, BLANK_URL } from '@shared/url'
import { cmd, run } from '@renderer/lib/api'
import { closeUrlbar, type UrlbarState } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'

interface Props {
  state: UIState
  urlbar: UrlbarState
  area: Rect
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

export function Urlbar({ state, urlbar, area }: Props): JSX.Element {
  const [text, setText] = useState(() => initialTextFor(state, urlbar))
  const [results, setResults] = useState<Suggestion[]>([])
  const [selected, setSelected] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestSeq = useRef(0)
  const lastTyped = useRef(text)
  const engine =
    state.searchEngines.find((e) => e.id === state.settings.searchEngineId) ??
    state.searchEngines[0]
  const tab = urlbar.tabId ? state.tabs[urlbar.tabId] : null

  useEffect(() => {
    const el = inputRef.current
    el?.focus()
    el?.select()
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

  const close = useCallback(
    (keepDraft: boolean) => {
      const key = tab ? `${tab.id}|${tab.url}` : 'new'
      if (keepDraft && text.trim() && text !== tab?.url) drafts.set(key, text)
      else drafts.delete(key)
      closeUrlbar()
    },
    [tab, text]
  )

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
  const width = Math.min(680, area.width - 32)
  const style = useMemo(() => {
    const top = floating ? Math.max(24, area.height * 0.16) : 8
    return {
      left: floating ? (area.width - width) / 2 : 8,
      top,
      width: floating ? width : area.width - 16,
      // Never grow past the content area – on phones the keyboard takes most of it.
      maxHeight: Math.max(120, area.height - top - 8)
    }
  }, [floating, area.width, area.height, width])

  const placeholder =
    urlbar.mode === 'search' ? `Search with ${engine.name}` : 'Search or enter address'

  return (
    <div className="absolute inset-0 z-30" onMouseDown={() => close(true)}>
      <div
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
          <ul className="min-h-0 max-h-[420px] flex-1 overflow-y-auto border-t border-[var(--zen-border)] p-1.5">
            {results.map((item, i) => (
              <SuggestionRow
                key={item.id}
                item={item}
                selected={i === selected}
                onHover={() => setSelected(i)}
                onPick={(e) => submit(item, { newTab: e.altKey || e.button === 1 })}
              />
            ))}
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

function SuggestionRow({
  item,
  selected,
  onHover,
  onPick
}: {
  item: Suggestion
  selected: boolean
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
      className="zen-suggestion flex h-9 cursor-default items-center gap-3 rounded-lg px-2.5"
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
      <span className="min-w-0 flex-1 truncate text-[13.5px]">{item.title}</span>
      <span className="max-w-[45%] truncate text-[12px] text-[var(--zen-muted)]">
        {item.subtitle}
      </span>
      {item.kind === 'tab' && <ArrowRight className="h-3.5 w-3.5 opacity-50" />}
    </li>
  )
}
