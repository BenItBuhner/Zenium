import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** How long a typed search waits before it filters and moves the URL. */
export const SEARCH_DEBOUNCE_MS = 150

/**
 * A page's search field bound to its URL (`?q=`, `InternalPageQuery`): what is typed settles
 * after {@link SEARCH_DEBOUNCE_MS} into `text`, which the page filters by and `push`es into the
 * tab's URL (`page.navigate` with `replace: true`, so the address says what the page shows and
 * a restored tab comes back searching, without a history entry per keystroke); a query the URL
 * brings – a deep link, the omnibox's `@history <text>`, Chrome's "More from this site", back,
 * forward – fills the field and `onAdopt`s (the page starts over: its selection was the old
 * list's). What the page pushed (`pushed`, in order – the core answers in order) comes back as
 * the tab's URL and is not adopted again; a clear that lands before the last push has echoed is
 * still pushed, measured against what the URL is about to say.
 */
export function usePageSearch({
  urlQuery,
  push,
  onAdopt
}: {
  urlQuery: string
  push: (text: string) => void
  onAdopt?: (text: string) => void
}): { query: string; setQuery: (value: string) => void; text: string } {
  const [query, setQuery] = useState(urlQuery)
  const [text, setText] = useState(urlQuery.trim())
  const pushed = useRef<string[]>([])
  const lastUrl = useRef(urlQuery)
  const latest = useRef({ push, onAdopt })
  useLayoutEffect(() => {
    latest.current = { push, onAdopt }
  }, [push, onAdopt])
  useEffect(() => {
    if (urlQuery === lastUrl.current) return
    lastUrl.current = urlQuery
    const at = pushed.current.indexOf(urlQuery)
    if (at >= 0) {
      pushed.current.splice(0, at + 1)
      return
    }
    pushed.current = []
    setQuery(urlQuery)
    setText(urlQuery.trim())
    latest.current.onAdopt?.(urlQuery.trim())
  }, [urlQuery])
  useEffect(() => {
    const timer = setTimeout(() => setText(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])
  const pushedFor = useRef(text)
  useEffect(() => {
    if (pushedFor.current === text) return
    pushedFor.current = text
    if (text === (pushed.current.at(-1) ?? lastUrl.current)) return
    pushed.current.push(text)
    latest.current.push(text)
  }, [text])
  return { query, setQuery, text }
}
