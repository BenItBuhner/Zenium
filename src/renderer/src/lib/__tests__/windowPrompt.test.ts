import { describe, expect, it } from 'vitest'
import type { WindowPrompt } from '@shared/types'
import { downloadsSentence, windowPromptText } from '../windowPrompt'

/*
 * The words of the window prompt (lib/windowPrompt.ts; v2 draft §9.23; downloads-35): the tabs
 * warning as it was, the download sentence – singular and plural – as the title block's second
 * description paragraph under it, or standing alone as the description when nothing about the
 * tabs is asked. The sentence says what the answer does (§9.1: quit, the verb's word): quitting
 * interrupts the downloads; closing the last private window cancels the private ones.
 */

function prompt(patch: Partial<WindowPrompt>): WindowPrompt {
  return { id: 'prompt_1', kind: 'quit', count: 0, downloads: null, ...patch }
}

describe('the download sentence', () => {
  it('says what quitting does, singular and plural, in the verb’s own word', () => {
    expect(downloadsSentence({ count: 1, end: 'quit' })).toBe(
      '1 download is in progress; quitting interrupts it.'
    )
    expect(downloadsSentence({ count: 2, end: 'quit' })).toBe(
      '2 downloads are in progress; quitting interrupts them.'
    )
  })

  it('says what closing the last private window does: its downloads are cancelled, since they cannot resume', () => {
    expect(downloadsSentence({ count: 1, end: 'private-window' })).toBe(
      '1 download is in progress; closing this window cancels it.'
    )
    expect(downloadsSentence({ count: 3, end: 'private-window' })).toBe(
      '3 downloads are in progress; closing this window cancels them.'
    )
  })

  it('never says exit, or cancel where the download only pauses', () => {
    for (const downloads of [
      { count: 1, end: 'quit' as const },
      { count: 2, end: 'quit' as const },
      { count: 2, end: 'private-window' as const }
    ]) {
      const sentence = downloadsSentence(downloads)
      expect(sentence).not.toMatch(/exit/i)
      if (downloads.end === 'quit') expect(sentence).not.toMatch(/cancel/i)
    }
  })
})

describe('the prompt as it was', () => {
  it('quit and close with the tabs warning alone read as before', () => {
    expect(windowPromptText(prompt({ kind: 'quit', count: 3 }))).toEqual({
      title: 'Quit Zenium?',
      description: 'You are about to quit with 3 tabs open.',
      downloadDescription: null,
      verb: 'Quit',
      tabsWarning: true
    })
    expect(windowPromptText(prompt({ kind: 'close-tabs', count: 2 }))).toEqual({
      title: 'Close 2 tabs?',
      description: 'You are about to close this window and its 2 tabs.',
      downloadDescription: null,
      verb: 'Close tabs',
      tabsWarning: true
    })
  })
})

describe('with downloads in progress', () => {
  it('the tabs warning keeps its title and description; the download sentence is the second description', () => {
    const text = windowPromptText(
      prompt({ kind: 'quit', count: 3, downloads: { count: 2, end: 'quit' } })
    )
    expect(text).toEqual({
      title: 'Quit Zenium?',
      description: 'You are about to quit with 3 tabs open.',
      downloadDescription: '2 downloads are in progress; quitting interrupts them.',
      verb: 'Quit',
      tabsWarning: true
    })
    // The last window closing on Linux or Windows: the close's words, the quit's download line.
    const closing = windowPromptText(
      prompt({ kind: 'close-tabs', count: 2, downloads: { count: 1, end: 'quit' } })
    )
    expect(closing.title).toBe('Close 2 tabs?')
    expect(closing.downloadDescription).toBe('1 download is in progress; quitting interrupts it.')
    expect(closing.verb).toBe('Close tabs')
  })

  it('alone, the download sentence is the description, no checkbox, and a quitting close says Quit', () => {
    expect(
      windowPromptText(prompt({ kind: 'quit', count: 0, downloads: { count: 1, end: 'quit' } }))
    ).toEqual({
      title: 'Quit Zenium?',
      description: '1 download is in progress; quitting interrupts it.',
      downloadDescription: null,
      verb: 'Quit',
      tabsWarning: false
    })
    expect(
      windowPromptText(
        prompt({ kind: 'close-tabs', count: 0, downloads: { count: 2, end: 'quit' } })
      )
    ).toMatchObject({ title: 'Quit Zenium?', verb: 'Quit', tabsWarning: false })
    expect(
      windowPromptText(
        prompt({ kind: 'close-tabs', count: 0, downloads: { count: 1, end: 'private-window' } })
      )
    ).toEqual({
      title: 'Close private window?',
      description: '1 download is in progress; closing this window cancels it.',
      downloadDescription: null,
      verb: 'Close window',
      tabsWarning: false
    })
  })
})
