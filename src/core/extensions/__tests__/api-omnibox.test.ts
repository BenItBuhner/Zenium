import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZenWindow } from '../../window'
import {
  ERROR_INVALID_DEFAULT,
  ERROR_INVALID_SUGGESTION,
  MAX_SUGGESTIONS,
  defaultDescription,
  dispositionFor,
  matchKeyword,
  normalizeDefaultSuggestion,
  normalizeSuggestResults,
  plainDescription,
  suggestionRows
} from '../api/omnibox'
import { OmniboxApi } from '../../../main/platform/extensionApi/omnibox'
import type {
  ApiContext,
  ApiHost,
  LoadedExtension
} from '../../../main/platform/extensionApi/types'

const EXT_A = 'a'.repeat(32)
const EXT_B = 'b'.repeat(32)

describe('omnibox pure parts', () => {
  it('turns Chrome description markup into plain text', () => {
    expect(plainDescription('<match>foo</match> <dim>bar</dim> <url>https://x.test</url>')).toBe(
      'foo bar https://x.test'
    )
    expect(plainDescription('a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos; &#65;&#x42;')).toBe(
      'a <b> & "c" \'d\' AB'
    )
    expect(plainDescription('<dim><match>nested</match></dim>')).toBe('nested')
  })

  it('matches a keyword only with whitespace after it', () => {
    const keywords = [
      { extensionId: EXT_A, keyword: 'go' },
      { extensionId: EXT_B, keyword: 'gopher' }
    ]
    expect(matchKeyword('go there', keywords)).toEqual({
      extensionId: EXT_A,
      keyword: 'go',
      text: 'there'
    })
    expect(matchKeyword('go ', keywords)).toEqual({ extensionId: EXT_A, keyword: 'go', text: '' })
    expect(matchKeyword('go', keywords)).toBeNull()
    expect(matchKeyword('gopher x', keywords)).toEqual({
      extensionId: EXT_B,
      keyword: 'gopher',
      text: 'x'
    })
    expect(matchKeyword('  go  spaced  ', keywords)).toEqual({
      extensionId: EXT_A,
      keyword: 'go',
      text: 'spaced  '
    })
    expect(matchKeyword('golf', keywords)).toBeNull()
  })

  it('fills %s into the default description, or names the extension', () => {
    expect(defaultDescription('Ext', { description: 'Search <match>%s</match>' }, 'cats')).toBe(
      'Search cats'
    )
    expect(defaultDescription('Ext', null, 'cats')).toBe('Run Ext command: cats')
    expect(defaultDescription('Ext', null, '')).toBe('Run Ext command')
  })

  it('checks the results and caps them', () => {
    expect(normalizeSuggestResults([{ content: 'a', description: 'A', deletable: true }])).toEqual([
      { content: 'a', description: 'A', deletable: true }
    ])
    expect(
      normalizeSuggestResults(
        Array.from({ length: 10 }, (_, i) => ({ content: String(i), description: 'd' }))
      )
    ).toHaveLength(MAX_SUGGESTIONS)
    expect(() => normalizeSuggestResults([{ content: 1, description: 'x' }])).toThrow(
      ERROR_INVALID_SUGGESTION
    )
    expect(() => normalizeSuggestResults('nope')).toThrow(ERROR_INVALID_SUGGESTION)
    expect(() => normalizeDefaultSuggestion({})).toThrow(ERROR_INVALID_DEFAULT)
  })

  it('builds rows whose fill carries the keyword and dedupes by content', () => {
    const rows = suggestionRows(
      { extensionId: EXT_A, extensionName: 'Ext', keyword: 'go', icon: null },
      [
        { content: 'one', description: '<match>One</match>' },
        { content: 'one', description: 'Again' },
        { content: 'two', description: '', deletable: true }
      ]
    )
    expect(rows.map((r) => [r.kind, r.title, r.fill, r.deletable ?? false])).toEqual([
      ['omnibox', 'One', 'go one', false],
      ['omnibox', 'two', 'go two', true]
    ])
  })

  it('names dispositions', () => {
    expect(dispositionFor(false, false)).toBe('currentTab')
    expect(dispositionFor(true, false)).toBe('newForegroundTab')
    expect(dispositionFor(true, true)).toBe('newBackgroundTab')
  })
})

interface Dispatched {
  extensionId: string
  event: string
  args: unknown[]
}

interface Harness {
  api: OmniboxApi
  out: Dispatched[]
  win: ZenWindow
  win2: ZenWindow
  load: (id: string, keyword: string | null) => void
  unload: (id: string) => void
  ctx: (id: string) => ApiContext
  /** Answer the latest `onInputChanged` of `id` through the shim's notify. */
  answer: (id: string, results: unknown) => void
}

function harness(waitMs = 50): Harness {
  const loaded = new Map<string, LoadedExtension>()
  const out: Dispatched[] = []
  const win = { id: 'w1' } as unknown as ZenWindow
  const win2 = { id: 'w2' } as unknown as ZenWindow
  const host = {
    browser: {
      extensions: {
        list: () =>
          [...loaded.values()].map((ext) => ({
            id: ext.id,
            name: `Name ${ext.id.slice(0, 1)}`,
            icon: null
          }))
      }
    },
    loaded: (id: string) => loaded.get(id),
    dispatch(extensionId: string, namespace: string, event: string, args: unknown[]): void {
      out.push({ extensionId, event: `${namespace}.${event}`, args })
    }
  }
  const api = new OmniboxApi(host as unknown as ApiHost, waitMs)
  const ctx = (id: string): ApiContext =>
    ({ extensionId: id, extension: loaded.get(id)! }) as unknown as ApiContext
  return {
    api,
    out,
    win,
    win2,
    load: (id, keyword) => {
      const ext = {
        id,
        manifest: keyword ? { omnibox: { keyword } } : {},
        extension: { name: `Ext ${id.slice(0, 1)}` },
        sessions: [{}]
      } as unknown as LoadedExtension
      loaded.set(id, ext)
      api.load(ext)
    },
    unload: (id) => {
      loaded.delete(id)
      api.unload(id)
    },
    ctx,
    answer: (id, results) => {
      const changed = [...out]
        .reverse()
        .find((d) => d.extensionId === id && d.event === 'omnibox.onInputChanged')
      if (!changed) throw new Error('no onInputChanged')
      api.suggested(ctx(id), { token: changed.args[1], results })
    }
  }
}

const events = (h: Harness): string[] => h.out.map((d) => `${d.extensionId.slice(0, 1)}:${d.event}`)

describe('chrome.omnibox', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves ordinary input alone', async () => {
    const h = harness()
    h.load(EXT_A, 'go')
    await expect(h.api.suggest('github', h.win)).resolves.toBeNull()
    expect(h.api.submit('github', false, false, h.win)).toBe(false)
    expect(h.out).toEqual([])
  })

  it('starts a session on the keyword, asks for rows and shows them after the default row', async () => {
    const h = harness()
    h.load(EXT_A, 'go')
    h.api.handlers.setDefaultSuggestion(h.ctx(EXT_A), { description: 'Go to <match>%s</match>' })
    const pending = h.api.suggest('go docs', h.win)
    expect(events(h)).toEqual(['a:omnibox.onInputStarted', 'a:omnibox.onInputChanged'])
    expect(h.out[1].args[0]).toBe('docs')
    h.answer(EXT_A, [
      { content: 'https://docs.test/', description: '<url>docs.test</url> <dim>Docs</dim>' }
    ])
    const rows = await pending
    expect(rows?.map((r) => [r.title, r.fill, r.subtitle])).toEqual([
      ['Go to docs', 'go docs', 'Name a'],
      ['docs.test Docs', 'go https://docs.test/', 'Name a']
    ])
    expect(h.api.sessionOf(h.win)).toBe(EXT_A)
  })

  it('a second change in the same session fires onInputChanged only', async () => {
    const h = harness()
    h.load(EXT_A, 'go')
    const first = h.api.suggest('go d', h.win)
    h.answer(EXT_A, [])
    await first
    const second = h.api.suggest('go do', h.win)
    h.answer(EXT_A, [])
    await second
    expect(events(h)).toEqual([
      'a:omnibox.onInputStarted',
      'a:omnibox.onInputChanged',
      'a:omnibox.onInputChanged'
    ])
  })

  it('shows what it has when the extension is slow, and uses a late answer next time', async () => {
    const h = harness(50)
    h.load(EXT_A, 'go')
    const pending = h.api.suggest('go slow', h.win)
    await vi.advanceTimersByTimeAsync(60)
    const rows = await pending
    expect(rows?.map((r) => r.title)).toEqual(['Run Name a command: slow'])
    h.answer(EXT_A, [{ content: 'late', description: 'Late' }])
    const again = await h.api.suggest('go slow', h.win)
    expect(again?.map((r) => r.title)).toEqual(['Run Name a command: slow', 'Late'])
    // Consumed once: the next query asks again.
    const third = h.api.suggest('go slow', h.win)
    expect(h.out.filter((d) => d.event === 'omnibox.onInputChanged')).toHaveLength(2)
    h.answer(EXT_A, [])
    await third
  })

  it('ignores answers with a stale token or from another extension', async () => {
    const h = harness()
    h.load(EXT_A, 'go')
    h.load(EXT_B, 'bee')
    const pending = h.api.suggest('go x', h.win)
    const token = h.out[1].args[1]
    h.api.suggested(h.ctx(EXT_B), { token, results: [{ content: 'b', description: 'B' }] })
    h.api.suggested(h.ctx(EXT_A), { token: 999, results: [{ content: 'z', description: 'Z' }] })
    h.api.suggested(h.ctx(EXT_A), { token, results: 'garbage' })
    h.answer(EXT_A, [{ content: 'a', description: 'A' }])
    const rows = await pending
    expect(rows?.map((r) => r.title)).toEqual(['Run Name a command: x', 'A'])
  })

  it('entering hands the text and disposition over and ends the session', async () => {
    const h = harness()
    h.load(EXT_A, 'go')
    const pending = h.api.suggest('go docs', h.win)
    h.answer(EXT_A, [])
    await pending
    expect(h.api.submit('go docs', true, false, h.win)).toBe(true)
    expect(h.out.at(-1)).toEqual({
      extensionId: EXT_A,
      event: 'omnibox.onInputEntered',
      args: ['docs', 'newForegroundTab']
    })
    expect(h.api.sessionOf(h.win)).toBeNull()
    // Entering straight away (a row picked without a query) works too.
    expect(h.api.submit('go https://docs.test/', false, true, h.win)).toBe(true)
    expect(h.out.at(-1)?.args).toEqual(['https://docs.test/', 'newBackgroundTab'])
  })

  it('leaving the keyword, closing the bar, or another keyword cancels the session', async () => {
    const h = harness()
    h.load(EXT_A, 'go')
    h.load(EXT_B, 'bee')
    let pending = h.api.suggest('go x', h.win)
    h.answer(EXT_A, [])
    await pending
    await h.api.suggest('gox', h.win)
    expect(h.out.at(-1)?.event).toBe('omnibox.onInputCancelled')
    expect(h.api.sessionOf(h.win)).toBeNull()

    pending = h.api.suggest('go x', h.win)
    h.answer(EXT_A, [])
    await pending
    h.api.cancel(h.win)
    expect(h.out.at(-1)).toEqual({
      extensionId: EXT_A,
      event: 'omnibox.onInputCancelled',
      args: []
    })
    h.api.cancel(h.win)
    expect(h.out.filter((d) => d.event === 'omnibox.onInputCancelled')).toHaveLength(2)

    pending = h.api.suggest('go y', h.win)
    h.answer(EXT_A, [])
    await pending
    pending = h.api.suggest('bee z', h.win)
    expect(events(h).slice(-3)).toEqual([
      'a:omnibox.onInputCancelled',
      'b:omnibox.onInputStarted',
      'b:omnibox.onInputChanged'
    ])
    h.answer(EXT_B, [])
    await pending
  })

  it('sessions are per window', async () => {
    const h = harness()
    h.load(EXT_A, 'go')
    const p1 = h.api.suggest('go one', h.win)
    h.answer(EXT_A, [])
    await p1
    const p2 = h.api.suggest('go two', h.win2)
    h.answer(EXT_A, [])
    await p2
    expect(events(h).filter((e) => e.endsWith('onInputStarted'))).toHaveLength(2)
    h.api.cancel(h.win)
    expect(h.api.sessionOf(h.win2)).toBe(EXT_A)
  })

  it('reports a deleted row', () => {
    const h = harness()
    h.load(EXT_A, 'go')
    h.api.deleteSuggestion('go gone')
    expect(h.out.at(-1)).toEqual({
      extensionId: EXT_A,
      event: 'omnibox.onDeleteSuggestion',
      args: ['gone']
    })
    h.api.deleteSuggestion('go ')
    expect(h.out).toHaveLength(1)
  })

  it('setDefaultSuggestion needs a keyword; unloading drops everything', async () => {
    const h = harness()
    h.load(EXT_B, null)
    expect(() => h.api.handlers.setDefaultSuggestion(h.ctx(EXT_B), { description: 'x' })).toThrow(
      /no omnibox keyword/
    )
    h.load(EXT_A, 'go')
    const pending = h.api.suggest('go x', h.win)
    h.unload(EXT_A)
    const rows = await pending
    // The registry no longer lists it: the engine's name stands in.
    expect(rows?.map((r) => r.title)).toEqual(['Run Ext a command: x'])
    expect(h.api.keywordOf(EXT_A)).toBeNull()
    expect(h.api.sessionOf(h.win)).toBeNull()
    await expect(h.api.suggest('go x', h.win)).resolves.toBeNull()
  })
})
