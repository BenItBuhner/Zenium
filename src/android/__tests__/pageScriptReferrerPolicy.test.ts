// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * The Android page script's word on the page's own referrer policy (W6-S9): the document's
 * `<meta name=referrer>` and the tapped anchor's `rel=noreferrer` / `referrerpolicy`, sent up
 * the page bridge as `referrerPolicy` messages carrying the session token, from the top document
 * – before the navigation the click starts reaches `TabWebView`'s hook, which holds it for the
 * core's content-settings answer and re-issues it under that policy (`ReferrerPolicyWord`).
 * The script is an IIFE that installs on import, so each document is a fresh evaluation.
 */

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

type Preamble = Window & {
  __zenPageBridge?: Bridge
  __zenPageInstalled?: boolean
}

interface Word {
  type?: string
  token?: string
  next?: string
  document?: string
  origin?: string
}

const w = window as unknown as Preamble

/** Kotlin's preamble, then the script, as a new document evaluates them; the words it posts. */
async function evaluateScript(): Promise<Word[]> {
  vi.resetModules()
  delete w.__zenPageInstalled
  const posted: Word[] = []
  w.__zenPageBridge = {
    postMessage: (message) => {
      const parsed = JSON.parse(message) as Word
      if (parsed.type === 'referrerPolicy') posted.push(parsed)
    },
    onmessage: null
  }
  await import('../pageScript')
  return posted
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('the Android page script and the page’s referrer policy', () => {
  it('tells the document’s word at start, with the token, and follows the meta', async () => {
    const posted = await evaluateScript()
    const origin = window.location.origin
    expect(posted).toEqual([
      { type: 'referrerPolicy', document: '', origin, token: '__ZEN_TOKEN__' }
    ])
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'referrer')
    meta.setAttribute('content', 'no-referrer')
    document.head.appendChild(meta)
    await flush()
    expect(posted.at(-1)).toEqual({
      type: 'referrerPolicy',
      document: 'no-referrer',
      origin,
      token: '__ZEN_TOKEN__'
    })
  })

  it('tells the tapped link’s word before the page’s own listeners run', async () => {
    const posted = await evaluateScript()
    posted.length = 0
    const link = document.createElement('a')
    link.setAttribute('href', 'https://other.example/')
    link.setAttribute('rel', 'noreferrer')
    document.body.appendChild(link)
    let wordsAtPageListener = -1
    link.addEventListener('click', (event) => {
      wordsAtPageListener = posted.length
      event.preventDefault()
    })
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(wordsAtPageListener).toBe(1)
    expect(posted[0]).toEqual({ type: 'referrerPolicy', next: 'no-referrer', token: '__ZEN_TOKEN__' })
    // The page prevented it: the document's word stands for whatever the page navigates to next.
    expect(posted[1]).toEqual({ type: 'referrerPolicy', next: '', token: '__ZEN_TOKEN__' })
  })
})
