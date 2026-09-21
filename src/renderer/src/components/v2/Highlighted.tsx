import type { JSX } from 'react'
import type { MatchRange } from '@shared/tabSearch'

/**
 * A row's text with the query's matches set in the heading weight (v2 draft §4: the pair 400 /
 * 600, no highlight fill): the tab search popover's titles and hosts, the omnibox dropdown's
 * titles and completions (omnibox-21). Each range is a `<mark>` – the element for a match in a
 * list of results – that the shared `.zen-v2-row mark` rule (main.css) draws as weight alone.
 */
export function Highlighted({
  text,
  ranges
}: {
  text: string
  ranges: readonly MatchRange[]
}): JSX.Element {
  if (ranges.length === 0) return <>{text}</>
  const parts: JSX.Element[] = []
  let cursor = 0
  ranges.forEach(([start, end], i) => {
    if (start > cursor) parts.push(<span key={`t${i}`}>{text.slice(cursor, start)}</span>)
    parts.push(<mark key={`m${i}`}>{text.slice(start, end)}</mark>)
    cursor = end
  })
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>)
  return <>{parts}</>
}
