import { describe, expect, it } from 'vitest'
import { clipboardReadItemsFrom } from '../platform'

/*
 * Kotlin's `clipboard.read` reply (MW-38): a bare string – the text alone, as the verb answered
 * before the image and still does for the URL bar's row and paste-and-go – or `{ text, image? }`
 * when asked with `image: true` for a page's `navigator.clipboard.read()`. Additive: a host
 * answering text alone parses, and a malformed image field costs the image, never the text.
 */
describe('clipboardReadItemsFrom (Kotlin’s clipboard.read reply)', () => {
  it('reads a plain string as the text alone – the verb’s answer without image: true, and any older host’s', () => {
    expect(clipboardReadItemsFrom('copied words')).toEqual({ text: 'copied words' })
    expect(clipboardReadItemsFrom('')).toEqual({ text: '' })
  })

  it('reads {text, image} field by field, the image’s size when the host gave it', () => {
    expect(
      clipboardReadItemsFrom({
        text: 'caption',
        image: { png: 'iVBORw0KGgo=', width: 8, height: 8 }
      })
    ).toEqual({ text: 'caption', image: { png: 'iVBORw0KGgo=', width: 8, height: 8 } })
    expect(clipboardReadItemsFrom({ text: '', image: { png: 'iVBORw0KGgo=' } })).toEqual({
      text: '',
      image: { png: 'iVBORw0KGgo=' }
    })
    // A size that is not a finite number is left out; the bytes still count.
    expect(
      clipboardReadItemsFrom({ text: 't', image: { png: 'AA==', width: '8', height: Infinity } })
    ).toEqual({ text: 't', image: { png: 'AA==' } })
  })

  it('takes a missing or malformed image as no image, the text kept', () => {
    expect(clipboardReadItemsFrom({ text: 'words alone' })).toEqual({ text: 'words alone' })
    expect(clipboardReadItemsFrom({ text: 'words', image: null })).toEqual({ text: 'words' })
    expect(clipboardReadItemsFrom({ text: 'words', image: 'iVBORw0KGgo=' })).toEqual({
      text: 'words'
    })
    expect(clipboardReadItemsFrom({ text: 'words', image: { png: '' } })).toEqual({ text: 'words' })
    expect(clipboardReadItemsFrom({ text: 'words', image: { png: 12 } })).toEqual({ text: 'words' })
    expect(clipboardReadItemsFrom({ text: 'words', image: { width: 8 } })).toEqual({
      text: 'words'
    })
  })

  it('reads a reply that is neither a string nor an object, or one without a text string, as no text', () => {
    expect(clipboardReadItemsFrom(null)).toEqual({ text: '' })
    expect(clipboardReadItemsFrom(undefined)).toEqual({ text: '' })
    expect(clipboardReadItemsFrom(7)).toEqual({ text: '' })
    expect(clipboardReadItemsFrom({})).toEqual({ text: '' })
    expect(clipboardReadItemsFrom({ text: 9, image: { png: 'AA==' } })).toEqual({
      text: '',
      image: { png: 'AA==' }
    })
  })
})
