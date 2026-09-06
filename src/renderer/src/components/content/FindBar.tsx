import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { returnFocusToPage, uiStore } from '@renderer/lib/ui'

/** Firefox-style find bar docked at the bottom of the content frame. */
export function FindBar({ state, tabId }: { state: UIState; tabId: string }): JSX.Element {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const result = state.findResult?.tabId === tabId ? state.findResult : null

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const handler = (e: Event): void => {
      const dir = (e as CustomEvent<'next' | 'prev'>).detail
      inputRef.current?.focus()
      if (text) run('find.start', { tabId, text, forward: dir === 'next', newSession: false })
    }
    window.addEventListener('zen-find-again', handler)
    return () => window.removeEventListener('zen-find-again', handler)
  }, [tabId, text])

  const close = (): void => {
    run('find.stop', { tabId, keepSelection: true })
    uiStore.set({ findOpen: false, findTabId: null })
    returnFocusToPage()
  }

  const search = (value: string, forward = true, newSession = true): void => {
    run('find.start', { tabId, text: value, forward, newSession })
  }

  return (
    <div className="zen-animate-in flex h-10 items-center gap-2 border-t border-[var(--zen-border)] bg-[var(--zen-bg-solid)] px-3">
      <input
        ref={inputRef}
        value={text}
        placeholder="Find in page"
        className="h-7 w-72 rounded-md bg-[var(--zen-element-bg)] px-2 text-[13px] outline-none ring-1 ring-transparent focus:ring-[var(--zen-accent)]/60"
        onChange={(e) => {
          setText(e.target.value)
          search(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') search(text, !e.shiftKey, false)
          if (e.key === 'Escape') close()
        }}
      />
      <span className="min-w-[80px] text-[12px] text-[var(--zen-muted)]">
        {text
          ? result && result.matches > 0
            ? `${result.activeMatchOrdinal} of ${result.matches}`
            : 'Phrase not found'
          : ''}
      </span>
      <button
        type="button"
        className="zen-toolbar-button h-7 w-7"
        title="Previous (Shift+Enter)"
        onClick={() => search(text, false, false)}
        disabled={!text}
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="zen-toolbar-button h-7 w-7"
        title="Next (Enter)"
        onClick={() => search(text, true, false)}
        disabled={!text}
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      <span className="flex-1" />
      <button
        type="button"
        className="zen-toolbar-button h-7 w-7"
        title="Close (Esc)"
        onClick={close}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
