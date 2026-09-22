// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  EXACT_TEXT_MAX_CHARS,
  appendTextDirective,
  encodeTextDirective,
  findTerm,
  findTextDirective,
  generateDirective,
  generateForRange,
  generateForSelection,
  hasFragmentDirective,
  linearize,
  matchDirective,
  parseTextDirectives,
  type TextDirective
} from '../textFragment'

function page(html: string): Document {
  document.body.innerHTML = html
  return document
}

function selectText(doc: Document, text: string, nth = 0): Range {
  const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */)
  let seen = 0
  let node: Node | null
  while ((node = walker.nextNode())) {
    const data = (node as Text).data
    for (let at = data.indexOf(text); at >= 0; at = data.indexOf(text, at + 1)) {
      if (seen++ < nth) continue
      const range = doc.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + text.length)
      return range
    }
  }
  throw new Error(`no text node holds ${JSON.stringify(text)}`)
}

/** Generate for a selection, then check that the receiving side finds exactly that selection. */
function roundTrip(doc: Document, range: Range): TextDirective {
  const d = generateForRange(doc, range)
  expect(d).not.toBeNull()
  const found = findTextDirective(doc, d!)
  expect(found).not.toBeNull()
  expect(found!.toString()).toBe(range.toString())
  return d!
}

describe('text directive URL syntax', () => {
  it('encodes prefix-,start,end,-suffix with the spec escapes', () => {
    const encoded = encodeTextDirective({
      prefix: 'a-b',
      textStart: 'start, here',
      textEnd: 'end & fin',
      suffix: 'after'
    })
    expect(encoded).toBe('text=a%2Db-,start%2C%20here,end%20%26%20fin,-after')
    expect(parseTextDirectives(`:~:${encoded}`)).toEqual([
      { prefix: 'a-b', textStart: 'start, here', textEnd: 'end & fin', suffix: 'after' }
    ])
  })

  it('parses every shape and rejects malformed directives', () => {
    expect(parseTextDirectives('page-anchor:~:text=one')).toEqual([{ textStart: 'one' }])
    expect(parseTextDirectives(':~:text=one,two')).toEqual([{ textStart: 'one', textEnd: 'two' }])
    expect(parseTextDirectives(':~:text=p-,one')).toEqual([{ prefix: 'p', textStart: 'one' }])
    expect(parseTextDirectives(':~:text=one,-s')).toEqual([{ textStart: 'one', suffix: 's' }])
    expect(parseTextDirectives(':~:text=a&text=b&other=c')).toEqual([
      { textStart: 'a' },
      { textStart: 'b' }
    ])
    expect(parseTextDirectives('no-directive-here')).toEqual([])
    expect(parseTextDirectives(':~:text=')).toEqual([])
    expect(parseTextDirectives(':~:text=a,b,c,d,e')).toEqual([])
    expect(parseTextDirectives(':~:text=%E0%A4%A')).toEqual([])
  })

  it('appends the directive after the page fragment and replaces an earlier one', () => {
    expect(appendTextDirective('https://a.test/p', 'text=x')).toBe('https://a.test/p#:~:text=x')
    expect(appendTextDirective('https://a.test/p#sec', 'text=x')).toBe(
      'https://a.test/p#sec:~:text=x'
    )
    expect(appendTextDirective('https://a.test/p#sec:~:text=old', 'text=new')).toBe(
      'https://a.test/p#sec:~:text=new'
    )
    expect(hasFragmentDirective('https://a.test/p#sec:~:text=x')).toBe(true)
    expect(hasFragmentDirective('https://a.test/p:~:#sec')).toBe(false)
    expect(hasFragmentDirective('https://a.test/p#sec')).toBe(false)
  })
})

describe('matching', () => {
  const text = 'The quick brown fox\njumps over the lazy dog. The  quick\tbrown cat sleeps.\n'

  it('matches whole words only, case-insensitively, with whitespace runs collapsed', () => {
    expect(findTerm(text, 'quick brown', 0)).toEqual([4, 15])
    expect(findTerm(text, 'QUICK BROWN', 16)).toEqual([50, 61])
    expect(findTerm(text, 'he quick', 0)).toBeNull()
    expect(findTerm(text, 'fox jumps', 0)).toBeNull()
  })

  it('anchors the start against the prefix and the suffix against the end', () => {
    expect(matchDirective(text, { prefix: 'the', textStart: 'quick brown' })).toEqual([4, 15])
    expect(
      matchDirective(text, { prefix: 'the', textStart: 'quick brown', suffix: 'cat' })
    ).toEqual([50, 61])
    expect(matchDirective(text, { prefix: 'over', textStart: 'quick brown' })).toBeNull()
    expect(matchDirective(text, { textStart: 'quick brown', suffix: 'dog' })).toBeNull()
  })

  it('finds a range from its start to the first end after it', () => {
    expect(matchDirective(text, { textStart: 'jumps', textEnd: 'dog' })).toEqual([20, 43])
    expect(matchDirective(text, { textStart: 'quick', textEnd: 'sleeps' })).toEqual([4, 72])
    expect(matchDirective(text, { textStart: 'sleeps', textEnd: 'quick' })).toBeNull()
  })
})

describe('generating', () => {
  it('uses the exact text when it is unique in the page', () => {
    const doc = page('<p>The quick brown fox jumps over the lazy dog.</p>')
    expect(roundTrip(doc, selectText(doc, 'brown fox'))).toEqual({ textStart: 'brown fox' })
  })

  it('grows to whole words around a partial selection', () => {
    const doc = page('<p>The quick brown fox jumps over the lazy dog.</p>')
    const range = selectText(doc, 'rown fo')
    const d = generateForRange(doc, range)
    expect(d).toEqual({ textStart: 'brown fox' })
  })

  it('adds prefix and suffix context, a word at a time, while an earlier passage matches', () => {
    const doc = page(
      '<p>The cat sat on the mat. The cat sat on the sofa. The cat sat on the mat again.</p>'
    )
    // One word each side ("The" / "on") still matches the first occurrence; two tell them apart.
    const second = roundTrip(doc, selectText(doc, 'cat sat', 1))
    expect(second).toEqual({ prefix: 'mat. The', textStart: 'cat sat', suffix: 'on the' })
    const third = roundTrip(doc, selectText(doc, 'cat sat', 2))
    expect(third).toEqual({ prefix: 'sofa. The', textStart: 'cat sat', suffix: 'on the' })
    // The first occurrence needs no context: the first match is the passage.
    expect(roundTrip(doc, selectText(doc, 'cat sat', 0))).toEqual({ textStart: 'cat sat' })
  })

  it('reports the spec’s prefix / suffix shape for an ambiguous passage at a block edge', () => {
    const doc = page('<p>Buy milk</p><p>Then buy milk again</p>')
    // "buy milk" alone finds the first paragraph; the second has context on both sides.
    expect(roundTrip(doc, selectText(doc, 'buy milk'))).toEqual({
      prefix: 'Then',
      textStart: 'buy milk',
      suffix: 'again'
    })
  })

  it('takes the context from the passage’s own block only', () => {
    const doc = page('<p>Intro words</p><p>repeat me</p><p>Other words</p><p>repeat me</p>')
    // No context is available inside the block; the second block cannot be singled out.
    expect(generateForRange(doc, selectText(doc, 'repeat me', 1))).toBeNull()
  })

  it('becomes a start,end range past the exact-text cap', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`)
    const doc = page(`<p>${words.join(' ')}</p>`)
    const range = selectText(doc, words.join(' '))
    expect(range.toString().length).toBeGreaterThan(EXACT_TEXT_MAX_CHARS)
    const d = roundTrip(doc, range)
    expect(d).toEqual({ textStart: 'word0 word1 word2', textEnd: 'word77 word78 word79' })
  })

  it('becomes a range when the selection crosses a block boundary', () => {
    const doc = page('<p>First paragraph ends here.</p><p>Second one starts now.</p>')
    const range = doc.createRange()
    const first = doc.body.firstChild!.firstChild as Text
    const second = doc.body.lastChild!.firstChild as Text
    range.setStart(first, first.data.indexOf('ends'))
    range.setEnd(second, second.data.indexOf('starts') + 'starts'.length)
    const d = generateForRange(doc, range)
    expect(d).toEqual({ textStart: 'ends here.', textEnd: 'Second one starts' })
    expect(findTextDirective(doc, d!)!.toString()).toBe(range.toString())
  })

  it('grows the range ends when the short ends are ambiguous', () => {
    const long = (tag: string): string =>
      Array.from({ length: 100 }, (_, i) => `${tag}${i}`).join(' ')
    const doc = page(`<p>${long('w')}</p><p>${long('w')}</p>`)
    expect(long('w').length).toBeGreaterThan(EXACT_TEXT_MAX_CHARS)
    // Both blocks read the same: no context and no range growth can single the second one out.
    expect(generateForRange(doc, selectText(doc, long('w'), 1))).toBeNull()
    // An earlier block sharing the first three words: the start term grows to the fourth.
    const headed = page(`<p>w0 w1 w2 x</p><p>${long('w')}</p>`)
    const d = roundTrip(headed, selectText(headed, long('w')))
    expect(d).toEqual({ textStart: 'w0 w1 w2 w3', textEnd: 'w96 w97 w98 w99' })
  })

  it('skips hidden text and scripts on both sides', () => {
    const doc = page(
      '<p>Visible <span hidden>secret words</span> passage</p><script>var secret = 1</script>'
    )
    const linear = linearize(doc.body)
    expect(linear.text).not.toContain('secret')
    expect(roundTrip(doc, selectText(doc, 'Visible'))).toEqual({ textStart: 'Visible' })
    expect(findTextDirective(doc, { textStart: 'secret words' })).toBeNull()
  })

  it('returns null for an empty or whitespace selection', () => {
    const doc = page('<p>Some   text</p>')
    const range = doc.createRange()
    const node = doc.body.firstChild!.firstChild as Text
    range.setStart(node, 4)
    range.setEnd(node, 6)
    expect(generateForRange(doc, range)).toBeNull()
    doc.getSelection()?.removeAllRanges()
    expect(generateForSelection(doc)).toBeNull()
  })

  it('produces the encoded directive for the document selection', () => {
    const doc = page('<p>Alpha beta gamma delta</p>')
    const range = selectText(doc, 'beta gamma')
    const selection = doc.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(generateForSelection(doc)).toBe('text=beta%20gamma')
  })

  it('keeps CJK characters as words of their own', () => {
    const text = '今日は良い天気です。\n今日は雨です。\n'
    expect(findTerm(text, '良い', 0)).toEqual([3, 5])
    expect(generateDirective({ text, segments: [] }, 3, 5)).toEqual({ textStart: '良い' })
  })
})
