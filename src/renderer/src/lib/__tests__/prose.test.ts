import { describe, expect, it } from 'vitest'
import { parseProse, parseSpans, spansText } from '../prose'

/*
 * The What's new page's reading of the release notes' markdown (SET-54): headings, bullets,
 * numbers, paragraphs and fences into blocks; bold, code, links and bare addresses into spans;
 * a link only on http(s).
 */

describe('parseProse', () => {
  it('reads the release notes’ shape: headings, bullets, a paragraph, a numbered list', () => {
    const blocks = parseProse(
      [
        '## Highlights',
        '',
        '- **Spaces** arrived, with a `zen://spaces` page.',
        '- The pill copies on a long-press.',
        '',
        '### Upgrading',
        'Nothing to do; the updater',
        'carries the settings over.',
        '',
        '1. Open Settings',
        '2. Tap About'
      ].join('\n')
    )
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'list', 'heading', 'paragraph', 'list'])
    expect(blocks[0]).toEqual({
      kind: 'heading',
      level: 2,
      spans: [{ kind: 'text', text: 'Highlights' }]
    })
    expect(blocks[1]).toEqual({
      kind: 'list',
      ordered: false,
      items: [
        [
          { kind: 'bold', text: 'Spaces' },
          { kind: 'text', text: ' arrived, with a ' },
          { kind: 'code', text: 'zen://spaces' },
          { kind: 'text', text: ' page.' }
        ],
        [{ kind: 'text', text: 'The pill copies on a long-press.' }]
      ]
    })
    expect(blocks[2]).toMatchObject({ kind: 'heading', level: 3 })
    expect(blocks[3]).toEqual({
      kind: 'paragraph',
      spans: [{ kind: 'text', text: 'Nothing to do; the updater carries the settings over.' }]
    })
    expect(blocks[4]).toMatchObject({ kind: 'list', ordered: true })
  })

  it('keeps a fenced block verbatim, reads CRLF, folds a bullet’s indented continuation, and an empty text is no blocks', () => {
    const blocks = parseProse(
      'Before\r\n```\r\nline 1\r\n  line 2\r\n```\r\n- one\r\n  goes on\r\n- two'
    )
    expect(blocks).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'Before' }] },
      { kind: 'code', text: 'line 1\n  line 2' },
      {
        kind: 'list',
        ordered: false,
        items: [[{ kind: 'text', text: 'one goes on' }], [{ kind: 'text', text: 'two' }]]
      }
    ])
    expect(parseProse('')).toEqual([])
    expect(parseProse('\n\n')).toEqual([])
  })

  it('reads a # as the page’s own 15/600 heading and #### and deeper as the sub-heading', () => {
    expect(parseProse('# Title').map((b) => b.kind === 'heading' && b.level)).toEqual([2])
    expect(parseProse('#### Deep').map((b) => b.kind === 'heading' && b.level)).toEqual([3])
  })
})

describe('parseSpans', () => {
  it('links [text](url) and bare addresses on http(s) alone, leaving the sentence’s full stop out', () => {
    expect(
      parseSpans('See [the notes](https://example.com/notes) or https://example.org/a, then.')
    ).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'the notes', href: 'https://example.com/notes' },
      { kind: 'text', text: ' or ' },
      { kind: 'link', text: 'https://example.org/a', href: 'https://example.org/a' },
      { kind: 'text', text: ',' },
      { kind: 'text', text: ' then.' }
    ])
    // No other scheme rides the notes into the chrome: the text stays text.
    expect(parseSpans('[run](javascript:void%200) and [file](file:///etc/passwd)')).toEqual([
      { kind: 'text', text: 'run' },
      { kind: 'text', text: ' and ' },
      { kind: 'text', text: 'file' }
    ])
  })

  it('reads the text of the spans back without the markup', () => {
    expect(spansText(parseSpans('**Bold** and `code` and [a link](https://z.example)'))).toBe(
      'Bold and code and a link'
    )
  })
})
