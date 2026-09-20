import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { UIState } from '@shared/types'
import { announce, findAnnouncement } from '@renderer/lib/announce'
import { run } from '@renderer/lib/api'
import { hint } from '@renderer/lib/shortcuts'
import { useViewport } from '@renderer/lib/formFactor'
import { closeFindBar, uiStore, type UiState } from '@renderer/lib/ui'
import { cn, findCounter } from '@renderer/lib/utils'

/**
 * The find bar, docked under the page: a panel row (v2 §9.21) with a 32px field that carries
 * the match count, and 28px previous / next / close buttons. On a phone it becomes one row of
 * 44px targets around a field that takes the remaining width. `docked="fullscreen"` is the bar
 * under a page in HTML fullscreen; it tells the main process how much of the window to leave it.
 *
 * The query lives in the UI store (`findText`), so the bar keeps it across a remount, and each
 * opening arrives as a `findRequest`: Ctrl+F re-selects the query (or brings the page's selection
 * in), F3 / Ctrl+G step to the next or previous match at once.
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
  const result = state.findResult?.tabId === tabId ? state.findResult : null
  const phone = useViewport().formFactor === 'phone'

  const search = (value: string, forward: boolean): void => {
    // Stepping continues the session for that text; anything else starts one from the selection.
    const follow = value !== '' && session.current === value
    session.current = value
    run('find.start', { tabId, text: value, forward, newSession: !follow })
  }

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

  // Each count the page reports is said through the chrome's status region ("3 of 12 matches",
  // "No matches"), as Chrome's find bar announces its count; the count in the field is plain text.
  useEffect(() => {
    const words = findAnnouncement(text, result)
    if (words) announce(words)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per result; the query is read as it stands then
  }, [result?.activeMatchOrdinal, result?.matches, result === null])

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
  const noMatch = result !== null && result.matches === 0
  const buttonClass = phone
    ? 'zen-toolbar-button h-11 w-11 rounded-[12px]'
    : 'zen-toolbar-button zen-find-button'
  const glyphClass = phone ? 'h-5 w-5' : 'h-4 w-4'

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
      <div
        className={
          phone
            ? 'zen-squircle flex h-10 min-w-0 flex-1 items-center rounded-[10px] bg-[var(--zen-element-bg)] pl-3 pr-2.5'
            : 'zen-find-field'
        }
        data-no-match={noMatch ? 'true' : undefined}
      >
        <input
          ref={inputRef}
          value={text}
          placeholder="Find in page"
          aria-label="Find in page"
          data-testid="find-input"
          inputMode="search"
          enterKeyHint="search"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          className={
            phone
              ? 'h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--zen-muted)]'
              : undefined
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
        <span
          className={
            phone
              ? 'shrink-0 pl-2 text-[13px] tabular-nums text-[var(--zen-muted)]'
              : 'zen-find-count'
          }
        >
          {count}
        </span>
      </div>
      <button
        type="button"
        className={buttonClass}
        title={hint('Previous match', state, 'find.prev')}
        aria-label="Previous match"
        onClick={() => search(text, false)}
        disabled={!text || noMatch}
      >
        <ChevronUp className={glyphClass} />
      </button>
      <button
        type="button"
        className={buttonClass}
        title={hint('Next match', state, 'find.next')}
        aria-label="Next match"
        onClick={() => search(text, true)}
        disabled={!text || noMatch}
      >
        <ChevronDown className={glyphClass} />
      </button>
      {!phone && <span className="flex-1" />}
      <button
        type="button"
        className={buttonClass}
        title="Close (Esc)"
        aria-label="Close find bar"
        onClick={() => closeFindBar()}
      >
        <X className={glyphClass} />
      </button>
    </div>
  )
}
