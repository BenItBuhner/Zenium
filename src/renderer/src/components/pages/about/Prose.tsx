import type { JSX } from 'react'
import { parseProse, type ProseBlock, type ProseSpan } from '@renderer/lib/prose'
import { run } from '@renderer/lib/api'

/**
 * A page's running text (v2 §10.1's page family; the What's new page and the legal pages):
 * the blocks `lib/prose.ts` read out of a markdown text, each its own element inside one
 * `.zen-page-prose` column – §9.27's 15/600 heading for a `##`, a 13/600 sub-heading for a
 * `###`, 15/400 paragraphs at the body line, one-level lists, a fenced block in the monospace
 * ink – tokens only, at the page's text column. A link is the shared `.zen-v2-link`, opened as
 * a tab of this browser (`tab.create`), never a document rendered from the notes.
 */
export function Prose({ text, testId }: { text: string; testId?: string }): JSX.Element {
  const blocks = parseProse(text)
  return (
    <div className="zen-page-prose" data-testid={testId}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  )
}

function Block({ block }: { block: ProseBlock }): JSX.Element {
  switch (block.kind) {
    case 'heading':
      return block.level === 2 ? (
        <h2 className="zen-v2-heading zen-page-prose-heading">
          <Spans spans={block.spans} />
        </h2>
      ) : (
        <h3 className="zen-page-prose-subheading">
          <Spans spans={block.spans} />
        </h3>
      )
    case 'paragraph':
      return (
        <p className="zen-page-prose-p">
          <Spans spans={block.spans} />
        </p>
      )
    case 'list': {
      const items = block.items.map((spans, i) => (
        <li key={i}>
          <Spans spans={spans} />
        </li>
      ))
      return block.ordered ? (
        <ol className="zen-page-prose-list">{items}</ol>
      ) : (
        <ul className="zen-page-prose-list">{items}</ul>
      )
    }
    case 'code':
      return (
        <pre className="zen-page-prose-pre">
          <code>{block.text}</code>
        </pre>
      )
  }
}

function Spans({ spans }: { spans: readonly ProseSpan[] }): JSX.Element {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'text':
            return span.text
          case 'bold':
            return <strong key={i}>{span.text}</strong>
          case 'code':
            return (
              <code key={i} className="zen-page-prose-code">
                {span.text}
              </code>
            )
          case 'link':
            return (
              <a
                key={i}
                className="zen-v2-link"
                href={span.href}
                title={span.href === span.text ? undefined : span.href}
                onClick={(e) => {
                  e.preventDefault()
                  run('tab.create', { url: span.href, active: true })
                }}
              >
                {span.text}
              </a>
            )
        }
      })}
    </>
  )
}
