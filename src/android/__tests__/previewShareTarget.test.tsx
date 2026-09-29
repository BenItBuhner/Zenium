// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PinnedWebApp } from '@shared/webApp'
import { parseShareTarget } from '@shared/webApp'
import { ANDROID, harness, type Harness } from '@core/__tests__/menusFixture'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { viewportStore } from '@renderer/lib/formFactor'
import { ShareChooserLayer } from '@renderer/components/share/ShareChooserSheet'
import { PREVIEW_SHARE_APPS, PREVIEW_SHARED_LINK, PREVIEW_SHARED_TEXT } from '../preview'

/*
 * The preview host's `shareTarget=link|text` states (MW-63): its two apps declaring share
 * targets stand installed, then the share it sends as the host's `intent` event goes to the
 * core, and the state is reached once the chooser stands in the browser state
 * (`UIState.shareChooser`) – the field the layer draws from. This suite runs that path end to
 * end without the host: the preview's own apps and shares, through the real core into the
 * window's snapshot, then the snapshot into the store and the real layer drawn from it. The
 * cold start the preview cannot show – the intent in before the chrome mounts – is the shape
 * here too: the snapshot first, the layer mounted after.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The preview's apps as the store records them once their pins land, with the targets their manifests declare. */
function installed(): PinnedWebApp[] {
  return PREVIEW_SHARE_APPS.map((app) => {
    const m = app.manifest
    const field = (name: string): string => {
      const value = m[name]
      if (typeof value !== 'string') throw new Error(`${app.manifestUrl}: no ${name}`)
      return value
    }
    const scope = new URL(field('scope'), app.manifestUrl).href
    const shareTarget = parseShareTarget(m.share_target, app.manifestUrl, scope)
    if (!shareTarget) throw new Error(`${field('name')} declares no target the browser takes`)
    return {
      id: new URL(field('id'), app.manifestUrl).href,
      name: field('name'),
      startUrl: new URL(field('start_url'), app.manifestUrl).href,
      scope,
      pinnedAt: 1,
      icon: null,
      shareTarget
    }
  })
}

let h: Harness
let root: Root | null = null
let mount: HTMLElement | null = null

/** The window's snapshot as the core hands the chrome, into the store the layer reads. */
function carry(): void {
  act(() => browserStore.set({ state: h.browser.state.snapshot(h.win) }))
}

const rows = (): string[] =>
  Array.from(document.querySelectorAll('button.zen-sheet-item')).map(
    (row) => row.querySelector('.flex-1')?.textContent ?? ''
  )

beforeEach(() => {
  h = harness(ANDROID, {
    formFactor: 'phone',
    files: {
      'webapps.json': JSON.stringify({ version: 1, pinned: installed(), engagement: {} })
    }
  })
  // The chrome's commands reach the core as the host relays them, and the snapshot follows.
  Object.assign(window, {
    zen: {
      invoke: async (channel: string, args: unknown) => {
        const result = h.browser.handleCommand(h.win, channel, args)
        carry()
        return result
      },
      on: () => () => undefined
    }
  })
  // A mouse's chooser (the dialog): the rows are the same, and it needs no layout to stand in.
  viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
  browserStore.set({ state: null })
  uiStore.set({ snapshot: null, snapshotTabId: null })
})

function render(): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<ShareChooserLayer />))
}

describe("the preview's share-target states through the state field", () => {
  it('shareTarget=link: the shared link stands in the snapshot for both apps, and the layer mounted after draws it', () => {
    h.browser.openSharedIntent(PREVIEW_SHARED_LINK, h.win)
    const chooser = h.browser.state.snapshot(h.win).shareChooser
    expect(chooser).toMatchObject({
      kind: 'url',
      link: {
        url: 'https://example.com/journal/long-walk',
        title: 'The quiet art of the long walk'
      },
      text: null
    })
    expect(chooser!.apps.map((a) => a.name)).toEqual(['Sketch Studio', 'Field Notes'])

    carry()
    render()
    expect(rows()).toEqual(['Open in a new tab', 'Sketch Studio', 'Field Notes'])
    expect(document.querySelector('.zen-menu-link-url')?.textContent).toBe(
      'https://example.com/journal/long-walk'
    )
  })

  it("shareTarget=text: the note's text stands in the snapshot with Search as the house row; a pick goes to the core, which clears the field and launches the app's target", () => {
    h.browser.openSharedIntent(PREVIEW_SHARED_TEXT, h.win)
    const chooser = h.browser.state.snapshot(h.win).shareChooser
    expect(chooser).toMatchObject({ kind: 'text', link: null })
    expect(chooser!.text).toBe(PREVIEW_SHARED_TEXT.text)

    carry()
    render()
    expect(rows()).toEqual(['Search', 'Sketch Studio', 'Field Notes'])

    // Field Notes' target is a POST: the pick posts the note under the app's own field name,
    // the core clears the chooser, and the layer – drawn from the state – goes with it.
    const notes = Array.from(document.querySelectorAll<HTMLButtonElement>('button.zen-sheet-item'))
    act(() => notes[2].click())
    expect(h.browser.state.snapshot(h.win).shareChooser).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    const post = h.viewCalls.find((c) => c.startsWith('postURL('))
    expect(post).toBeDefined()
    expect(post).toContain('"https://example.com/notes/new"')
    expect(post).toContain(`{"name":"body","value":${JSON.stringify(PREVIEW_SHARED_TEXT.text)}}`)
  })
})
