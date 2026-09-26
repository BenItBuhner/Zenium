// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  anchorReferrerPolicy,
  documentMetaPolicy,
  installReferrerPolicyReporter,
  navigatingAnchorOf,
  parseReferrerPolicy,
  type ReferrerPolicyWord
} from '../referrerPolicy'

/*
 * The page's own referrer policy, read in the page's world for the navigation the view holds
 * (W6-S9): the meta's tokens and legacy keywords, the anchor over the document, the observer's
 * processing order and the words sent up the bridge.
 */

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function meta(content: string, name = 'referrer'): HTMLMetaElement {
  const el = document.createElement('meta')
  el.setAttribute('name', name)
  el.setAttribute('content', content)
  return el
}

function anchor(attributes: Record<string, string>): HTMLAnchorElement {
  const a = document.createElement('a')
  for (const [key, value] of Object.entries(attributes)) a.setAttribute(key, value)
  document.body.appendChild(a)
  return a
}

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('parseReferrerPolicy', () => {
  it('takes the eight tokens ASCII case-insensitively and nothing else', () => {
    expect(parseReferrerPolicy('no-referrer')).toBe('no-referrer')
    expect(parseReferrerPolicy(' Strict-Origin-When-Cross-Origin ')).toBe(
      'strict-origin-when-cross-origin'
    )
    expect(parseReferrerPolicy('UNSAFE-URL')).toBe('unsafe-url')
    expect(parseReferrerPolicy('')).toBe('')
    expect(parseReferrerPolicy('bogus')).toBeNull()
    expect(parseReferrerPolicy(null)).toBeNull()
    expect(parseReferrerPolicy(undefined)).toBeNull()
    // The legacy meta keywords are the meta's alone.
    expect(parseReferrerPolicy('never')).toBeNull()
    expect(parseReferrerPolicy('never', true)).toBe('no-referrer')
    expect(parseReferrerPolicy('Always', true)).toBe('unsafe-url')
    expect(parseReferrerPolicy('origin-when-crossorigin', true)).toBe('origin-when-cross-origin')
    // `default` is the browser's default policy, which the empty word stands for.
    expect(parseReferrerPolicy('default', true)).toBe('')
  })
})

describe('documentMetaPolicy', () => {
  it('reads the last valid meta and leaves an invalid one to the one before it', () => {
    expect(documentMetaPolicy(document)).toBe('')
    document.head.appendChild(meta('no-referrer'))
    expect(documentMetaPolicy(document)).toBe('no-referrer')
    document.head.appendChild(meta('same-origin', 'Referrer'))
    expect(documentMetaPolicy(document)).toBe('same-origin')
    document.head.appendChild(meta('nonsense'))
    expect(documentMetaPolicy(document)).toBe('same-origin')
    // Another meta's content is not a policy; a legacy keyword is.
    document.head.appendChild(meta('no-referrer', 'description'))
    expect(documentMetaPolicy(document)).toBe('same-origin')
    document.head.appendChild(meta('never'))
    expect(documentMetaPolicy(document)).toBe('no-referrer')
  })
})

describe('anchorReferrerPolicy', () => {
  it('puts rel=noreferrer over the attribute over the document, and an unknown attribute defers', () => {
    expect(anchorReferrerPolicy(anchor({ href: '#a' }), 'same-origin')).toBe('same-origin')
    expect(anchorReferrerPolicy(anchor({ href: '#a', referrerpolicy: 'Origin' }), 'same-origin')).toBe(
      'origin'
    )
    expect(
      anchorReferrerPolicy(anchor({ href: '#a', referrerpolicy: 'unsafe-url', rel: 'nofollow NoReferrer' }), '')
    ).toBe('no-referrer')
    expect(anchorReferrerPolicy(anchor({ href: '#a', referrerpolicy: 'bogus' }), 'strict-origin')).toBe(
      'strict-origin'
    )
    expect(anchorReferrerPolicy(anchor({ href: '#a', referrerpolicy: '' }), 'no-referrer')).toBe(
      'no-referrer'
    )
    // The legacy keywords are not the attribute's.
    expect(anchorReferrerPolicy(anchor({ href: '#a', referrerpolicy: 'never' }), '')).toBe('')
    // `noreferrer` is a whole token of `rel`.
    expect(anchorReferrerPolicy(anchor({ href: '#a', rel: 'noreferrerx' }), '')).toBe('')
  })
})

describe('navigatingAnchorOf', () => {
  it('finds the link the click follows in this document, and not one that opens elsewhere', () => {
    const plain = anchor({ href: '#a' })
    const inner = document.createElement('span')
    plain.appendChild(inner)
    const click = (target: Element): Event => {
      let seen: Event | null = null
      const listen = (event: Event): void => {
        seen = event
        // The environment would follow the link otherwise; the question is what is read.
        event.preventDefault()
      }
      window.addEventListener('click', listen, true)
      target.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
      )
      window.removeEventListener('click', listen, true)
      if (seen === null) throw new Error('the click did not reach the window')
      return seen
    }
    expect(navigatingAnchorOf(click(inner), document)).toBe(plain)
    expect(navigatingAnchorOf(click(anchor({ href: '#b', target: '_SELF' })), document)).not.toBeNull()
    expect(navigatingAnchorOf(click(anchor({ href: '#b', target: '_top' })), document)).not.toBeNull()
    expect(navigatingAnchorOf(click(anchor({ href: '#b', target: '_blank' })), document)).toBeNull()
    expect(navigatingAnchorOf(click(anchor({ href: '#b', target: 'sidebar' })), document)).toBeNull()
    expect(navigatingAnchorOf(click(anchor({ href: '#b', download: '' })), document)).toBeNull()
    expect(navigatingAnchorOf(click(anchor({ name: 'no-href' })), document)).toBeNull()
    const button = document.createElement('button')
    document.body.appendChild(button)
    expect(navigatingAnchorOf(click(button), document)).toBeNull()
  })
})

describe('installReferrerPolicyReporter', () => {
  it('tells the document’s word at once and at every meta the observer processes, in order', async () => {
    const words: ReferrerPolicyWord[] = []
    installReferrerPolicyReporter(window, (word) => words.push(word))
    const origin = window.location.origin
    expect(words).toEqual([{ document: '', origin }])
    const first = meta('no-referrer')
    document.head.appendChild(first)
    await flush()
    expect(words.at(-1)).toEqual({ document: 'no-referrer', origin })
    // An invalid value leaves the policy; a removal changes nothing (the spec's processing model).
    document.head.appendChild(meta('nonsense'))
    first.remove()
    await flush()
    expect(words).toHaveLength(2)
    // A changed content is processed; the same value again is not told twice.
    const second = meta('origin')
    document.head.appendChild(second)
    await flush()
    expect(words.at(-1)).toEqual({ document: 'origin', origin })
    second.setAttribute('content', 'origin')
    second.setAttribute('content', 'same-origin')
    await flush()
    expect(words.at(-1)).toEqual({ document: 'same-origin', origin })
    expect(words).toHaveLength(4)
    // A meta whose name becomes `referrer` is processed then; a legacy keyword through the meta.
    const renamed = meta('never', 'other')
    document.head.appendChild(renamed)
    await flush()
    expect(words).toHaveLength(4)
    renamed.setAttribute('name', 'referrer')
    await flush()
    expect(words.at(-1)).toEqual({ document: 'no-referrer', origin })
  })

  it('reads the metas already there for a script that arrived late', () => {
    document.head.appendChild(meta('same-origin'))
    const words: ReferrerPolicyWord[] = []
    installReferrerPolicyReporter(window, (word) => words.push(word))
    expect(words).toEqual([{ document: 'same-origin', origin: window.location.origin }])
  })

  it('tells the next navigation’s word at the capture phase of a click on a link of this document', async () => {
    const words: ReferrerPolicyWord[] = []
    installReferrerPolicyReporter(window, (word) => words.push(word))
    document.head.appendChild(meta('same-origin'))
    await flush()
    words.length = 0
    // The link's own policy, then rel=noreferrer over it, then the document's for a plain link.
    const own = anchor({ href: '#a', referrerpolicy: 'unsafe-url' })
    const seenAt: string[] = []
    own.addEventListener('click', (event) => {
      seenAt.push(`page:${words.length}`)
      event.preventDefault()
    })
    own.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    // The word left before the page's own listener ran; the prevented click is told again as the document's.
    expect(seenAt).toEqual(['page:1'])
    expect(words).toEqual([{ next: 'unsafe-url' }, { next: 'same-origin' }])
    words.length = 0
    anchor({ href: '#b', rel: 'noreferrer' }).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    anchor({ href: '#c' }).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(words).toEqual([{ next: 'no-referrer' }, { next: 'same-origin' }])
    words.length = 0
    // Enter on a focused link and a middle-button auxclick are told; a secondary-button auxclick is not.
    const focused = anchor({ href: '#d', referrerpolicy: 'origin' })
    focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    focused.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }))
    focused.dispatchEvent(new MouseEvent('auxclick', { button: 2, bubbles: true }))
    expect(words).toEqual([{ next: 'origin' }, { next: 'origin' }])
    words.length = 0
    // A click that is not a link's says nothing.
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(words).toEqual([])
  })

  it('leaves a link that opens elsewhere unsaid', () => {
    const send = vi.fn()
    installReferrerPolicyReporter(window, send)
    send.mockClear()
    for (const link of [
      anchor({ href: '#a', target: '_blank', rel: 'noreferrer' }),
      anchor({ href: '#b', download: 'file.bin' })
    ]) {
      // Prevented at the target so the environment does not follow it; the reporter's own
      // bubble-phase listener finds no link of this document's to speak for either way.
      link.addEventListener('click', (event) => event.preventDefault())
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    }
    expect(send).not.toHaveBeenCalled()
  })
})
