import { describe, expect, it } from 'vitest'
import type { WindowPrompt } from '@shared/types'
import { downloadsSentence, windowPromptText } from '../windowPrompt'

/*
 * The words of the window prompt (lib/windowPrompt.ts; v2 draft §9.23; downloads-35): the tabs
 * warning as it was, the download sentence – singular and plural – as the title block's second
 * description paragraph under it, or standing alone as the description when nothing about the
 * tabs is asked. What "and …" names is what ends the downloads: quitting, or closing the private
 * window.
 */

function prompt(patch: Partial<WindowPrompt>): WindowPrompt {
  return { id: 'prompt_1', kind: 'quit', count: 0, downloads: null, ...patch }
}

describe('the download sentence', () => {
  it("is Chrome's, singular and plural, naming what ends the downloads", () => {
    expect(downloadsSentence({ count: 1, end: 'quit' })).toBe(
      'A download is currently in progress. Do you want to cancel the download and exit Zenium?'
    )
    expect(downloadsSentence({ count: 2, end: 'quit' })).toBe(
      '2 downloads are currently in progress. Do you want to cancel the downloads and exit Zenium?'
    )
    expect(downloadsSentence({ count: 1, end: 'private-window' })).toBe(
      'A download is currently in progress. Do you want to cancel the download and close the private window?'
    )
    expect(downloadsSentence({ count: 3, end: 'private-window' })).toBe(
      '3 downloads are currently in progress. Do you want to cancel the downloads and close the private window?'
    )
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
      downloadDescription:
        '2 downloads are currently in progress. Do you want to cancel the downloads and exit Zenium?',
      verb: 'Quit',
      tabsWarning: true
    })
    // The last window closing on Linux or Windows: the close's words, the quit's download line.
    const closing = windowPromptText(
      prompt({ kind: 'close-tabs', count: 2, downloads: { count: 1, end: 'quit' } })
    )
    expect(closing.title).toBe('Close 2 tabs?')
    expect(closing.downloadDescription).toBe(
      'A download is currently in progress. Do you want to cancel the download and exit Zenium?'
    )
    expect(closing.verb).toBe('Close tabs')
  })

  it('alone, the download sentence is the description, no checkbox, and a quitting close says Quit', () => {
    expect(
      windowPromptText(prompt({ kind: 'quit', count: 0, downloads: { count: 1, end: 'quit' } }))
    ).toEqual({
      title: 'Quit Zenium?',
      description:
        'A download is currently in progress. Do you want to cancel the download and exit Zenium?',
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
      description:
        'A download is currently in progress. Do you want to cancel the download and close the private window?',
      downloadDescription: null,
      verb: 'Close window',
      tabsWarning: false
    })
  })
})
