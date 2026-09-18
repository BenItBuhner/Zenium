import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { returnFocusToPage, uiStore } from '@renderer/lib/ui'
import { cn, findCounter } from '@renderer/lib/utils'

/**
 * Firefox-style find bar docked at the bottom of the content frame. On a phone it becomes one
 * row of 44 px targets around a field that takes the remaining width, with the match count
 * inside the field the way Chrome's does; the desktop layout is unchanged.
 */
export function FindBar({ state, tabId }: { state: UIState; tabId: string }): JSX.Element {
  // "Use selection for find" opens the bar with the page's selection already in it.
  const [text, setText] = useState(() => {
    const seed = uiStore.get().findSeed
    if (seed !== null) uiStore.set({ findSeed: null })
    return seed ?? ''
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const result = state.findResult?.tabId === tabId ? state.findResult : null
  const phone = useViewport().formFactor === 'phone'

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    if (text) run('find.start', { tabId, text, forward: true, newSession: true })
    // Only on mount: the seed is what the bar opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const again = (e: Event): void => {
      const dir = (e as CustomEvent<'next' | 'prev'>).detail
      inputRef.current?.focus()
      if (text) run('find.start', { tabId, text, forward: dir === 'next', newSession: false })
    }
    // The bar is already up and a new selection arrives: search for it afresh.
    const seed = (e: Event): void => {
      const value = (e as CustomEvent<string>).detail
      uiStore.set({ findSeed: null })
      setText(value)
      inputRef.current?.focus()
      inputRef.current?.select()
      if (value) run('find.start', { tabId, text: value, forward: true, newSession: true })
    }
    window.addEventListener('zen-find-again', again)
    window.addEventListener('zen-find-seed', seed)
    return () => {
      window.removeEventListener('zen-find-again', again)
      window.removeEventListener('zen-find-seed', seed)
    }
  }, [tabId, text])

  const close = (): void => {
    run('find.stop', { tabId, keepSelection: true })
    uiStore.set({ findOpen: false, findTabId: null })
    returnFocusToPage()
  }

  const search = (value: string, forward = true, newSession = true): void => {
    run('find.start', { tabId, text: value, forward, newSession })
  }

  const count = findCounter(text, result, phone)
  const buttonClass = phone
    ? 'zen-toolbar-button h-11 w-11 rounded-[12px]'
    : 'zen-toolbar-button h-7 w-7'
  const glyphClass = phone ? 'h-5 w-5' : 'h-4 w-4'

  return (
    <div
      className={cn(
        'zen-animate-in flex items-center bg-[var(--zen-bg-solid)] px-3',
        phone ? 'zen-find-phone h-14 gap-1' : 'h-10 gap-2 border-t border-[var(--zen-border)]'
      )}
    >
      <div
        className={
          phone
            ? 'zen-squircle flex h-10 min-w-0 flex-1 items-center rounded-[10px] bg-[var(--zen-element-bg)] pl-3 pr-2.5'
            : 'contents'
        }
      >
        <input
          ref={inputRef}
          value={text}
          placeholder="Find in page"
          aria-label="Find in page"
          inputMode="search"
          enterKeyHint="search"
          autoCapitalize="none"
          autoComplete="off"
          className={
            phone
              ? 'h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--zen-muted)]'
              : 'h-7 w-72 rounded-md bg-[var(--zen-element-bg)] px-2 text-[13px] outline-none ring-1 ring-transparent focus:ring-[var(--zen-accent)]/60'
          }
          onChange={(e) => {
            setText(e.target.value)
            search(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') search(text, !e.shiftKey, false)
            if (e.key === 'Escape') close()
          }}
        />
        <span
          className={
            phone
              ? 'shrink-0 pl-2 text-[13px] tabular-nums text-[var(--zen-muted)]'
              : 'min-w-[80px] text-[12px] text-[var(--zen-muted)]'
          }
        >
          {count}
        </span>
      </div>
      <button
        type="button"
        className={buttonClass}
        title="Previous (Shift+Enter)"
        aria-label="Previous match"
        onClick={() => search(text, false, false)}
        disabled={!text}
      >
        <ChevronUp className={glyphClass} />
      </button>
      <button
        type="button"
        className={buttonClass}
        title="Next (Enter)"
        aria-label="Next match"
        onClick={() => search(text, true, false)}
        disabled={!text}
      >
        <ChevronDown className={glyphClass} />
      </button>
      {!phone && <span className="flex-1" />}
      <button
        type="button"
        className={buttonClass}
        title="Close (Esc)"
        aria-label="Close find bar"
        onClick={close}
      >
        <X className={glyphClass} />
      </button>
    </div>
  )
}
