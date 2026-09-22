import { describe, expect, it } from 'vitest'
import type { ExtensionInfo } from '@shared/types'
import type { MenuItemTemplate, PageContextParams } from '@core/platform'
import {
  type Harness,
  ID,
  backgroundUp,
  call,
  events,
  harness,
  hello,
  manifest,
  message,
  record
} from './runtimeHarness'

/** A long-press on a link (the Kotlin hit test's payload, filled in by `views.ts`). */
function longPress(over: Partial<PageContextParams> = {}): PageContextParams {
  return {
    x: 10,
    y: 10,
    linkURL: 'https://example.com/link',
    srcURL: '',
    mediaType: 'none',
    selectionText: '',
    isEditable: false,
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: false
    },
    ...over
  }
}

async function withMenus(
  h: Harness,
  overrides: Record<string, unknown> = {},
  ep = 'bg1'
): Promise<void> {
  await h.runtime.attach(
    record(h, {}, manifest({ permissions: ['contextMenus', 'activeTab', 'storage'], ...overrides }))
  )
  backgroundUp(h, ep, ['contextMenus.onClicked'])
}

function items(h: Harness, params = longPress()): MenuItemTemplate[] {
  const tab = h.tabs.t1
  return h.runtime.api.pageContextMenuItems(tab, params)
}

describe('chrome.contextMenus on the long-press menu', () => {
  it('creates items through the shared registry and shows one matching item directly, with the icon', async () => {
    const h = harness()
    await withMenus(h)
    h.infos.push({ id: ID, icon: 'data:image/png;base64,AAAA' } as unknown as ExtensionInfo)
    const reply = await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'save', title: 'Save link with %s', contexts: ['link'] },
      'save'
    ])
    expect(reply.ok).toBe(true)
    expect(reply.result).toBe('save')
    const menu = items(h)
    expect(menu).toHaveLength(1)
    expect(menu[0].label).toBe('Save link with ')
    expect(menu[0].icon).toBe('data:image/png;base64,AAAA')
    expect(menu[0].type).toBe('normal')
    // A long-press on an image shows no link item.
    expect(
      items(h, longPress({ linkURL: '', srcURL: 'https://example.com/a.png', mediaType: 'image' }))
    ).toEqual([])
  })

  it('folds several matching items into a submenu titled with the extension name', async () => {
    const h = harness()
    await withMenus(h)
    await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'a', title: 'A', contexts: ['all'] },
      'a'
    ])
    await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'b', title: 'B', contexts: ['link'] },
      'b'
    ])
    await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'c', title: 'C', contexts: ['image'] },
      'c'
    ])
    const menu = items(h)
    expect(menu).toHaveLength(1)
    expect(menu[0].label).toBe('Runtime test')
    expect(menu[0].submenu?.map((i) => i.label)).toEqual(['A', 'B'])
  })

  it('a pick fires onClicked with Chrome OnClickData and the tab, toggles checkboxes, grants activeTab', async () => {
    const h = harness()
    await withMenus(h)
    await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'box', title: 'Box', type: 'checkbox', contexts: ['link'] },
      'box'
    ])
    const menu = items(h)
    expect(menu[0].checked).toBe(false)
    menu[0].click?.()
    const clicked = events(h, 'bg1', 'contextMenus.onClicked')
    expect(clicked).toHaveLength(1)
    const [info, tab] = clicked[0].args as [Record<string, unknown>, Record<string, unknown>]
    expect(info).toEqual({
      menuItemId: 'box',
      editable: false,
      linkUrl: 'https://example.com/link',
      pageUrl: 'https://example.com/',
      frameId: 0,
      wasChecked: false,
      checked: true
    })
    expect(tab.url).toBe('https://example.com/')
    expect(items(h)[0].checked).toBe(true)
    expect(h.runtime.api.activeTab.has(ID, 't1')).toBe(true)
    // The grant ends when the tab leaves the origin.
    h.runtime.onViewEvent('t1', 'navigated', {
      url: 'https://other.test/',
      title: '',
      canGoBack: true,
      canGoForward: false,
      inPage: false
    })
    expect(h.runtime.api.activeTab.has(ID, 't1')).toBe(false)
  })

  it('delivers onClicked to the context that created the item with onclick, listener or not', async () => {
    const h = harness()
    await h.runtime.attach(
      record(
        h,
        {},
        manifest({
          manifest_version: 2,
          permissions: ['contextMenus'],
          background: { scripts: ['bg.js'], persistent: true },
          browser_action: { default_popup: 'popup.html' },
          action: undefined
        })
      )
    )
    hello(h, 'bg1', 'background')
    message(h, 'bg1', { t: 'ready' })
    // The shim strips the function and flags it: `onclick: true`.
    const reply = await call(h, 'bg1', 'contextMenus', 'create', [
      { title: 'Handler', contexts: ['link'], onclick: true },
      1
    ])
    expect(reply.ok).toBe(true)
    items(h)[0].click?.()
    expect(events(h, 'bg1', 'contextMenus.onClicked')).toHaveLength(1)
  })

  it('rejects onclick from a worker, duplicate ids and unknown ids with Chrome messages', async () => {
    const h = harness()
    await withMenus(h)
    const onclick = await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'x', title: 'X', onclick: true },
      'x'
    ])
    expect(onclick.ok).toBe(false)
    expect(String(onclick.error)).toContain('cannot pass an onclick parameter')
    await call(h, 'bg1', 'contextMenus', 'create', [{ id: 'dup', title: 'Dup' }, 'dup'])
    const dup = await call(h, 'bg1', 'contextMenus', 'create', [{ id: 'dup', title: 'Dup' }, 'dup'])
    expect(String(dup.error)).toBe('Cannot create item with duplicate id dup')
    const missing = await call(h, 'bg1', 'contextMenus', 'update', ['nope', { title: 'N' }])
    expect(String(missing.error)).toBe('Cannot find menu item with id nope')
  })

  it('update, remove and removeAll change what the menu shows', async () => {
    const h = harness()
    await withMenus(h)
    await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'a', title: 'A', contexts: ['link'] },
      'a'
    ])
    await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'b', title: 'B', contexts: ['link'] },
      'b'
    ])
    await call(h, 'bg1', 'contextMenus', 'update', ['a', { title: 'A2', visible: false }])
    expect(items(h)[0].label).toBe('B')
    await call(h, 'bg1', 'contextMenus', 'update', ['a', { visible: true }])
    expect(items(h)[0].submenu?.map((i) => i.label)).toEqual(['A2', 'B'])
    await call(h, 'bg1', 'contextMenus', 'remove', ['a'])
    expect(items(h)[0].label).toBe('B')
    await call(h, 'bg1', 'contextMenus', 'removeAll', [])
    expect(items(h)).toEqual([])
  })

  it('keeps an extension not allowed in incognito out of a private tab menu', async () => {
    const h = harness()
    await withMenus(h)
    await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'a', title: 'A', contexts: ['all'] },
      'a'
    ])
    h.tabs.p1 = { ...h.tabs.t1, id: 'p1', containerId: 'private' }
    expect(h.runtime.api.pageContextMenuItems(h.tabs.p1, longPress())).toEqual([])
    expect(h.runtime.api.pageContextMenuItems(h.tabs.t1, longPress())).toHaveLength(1)
  })

  it('lists the action-context items for the toolbar button menu, six at most', async () => {
    const h = harness()
    await withMenus(h)
    for (let i = 0; i < 8; i++)
      await call(h, 'bg1', 'contextMenus', 'create', [
        { id: `i${i}`, title: `Item ${i}`, contexts: ['action'] },
        `i${i}`
      ])
    await call(h, 'bg1', 'contextMenus', 'create', [{ id: 'p', title: 'Page only' }, 'p'])
    const menu = h.runtime.api.actionContextMenuItems(ID)
    expect(menu.map((i) => i.label)).toEqual([0, 1, 2, 3, 4, 5].map((i) => `Item ${i}`))
    menu[0].click?.()
    const [info, tab] = events(h, 'bg1', 'contextMenus.onClicked')[0].args as [
      Record<string, unknown>,
      Record<string, unknown>
    ]
    expect(info.menuItemId).toBe('i0')
    expect(info.pageUrl).toBe('https://example.com/')
    // Chrome's `OnClickData` for the `action` context: no link, media, frame or selection under
    // the pointer – the button was pressed, over the active tab, which comes along as the tab.
    expect(info).toEqual({
      menuItemId: 'i0',
      editable: false,
      pageUrl: 'https://example.com/',
      frameId: 0
    })
    expect(tab.url).toBe('https://example.com/')
    expect(tab.active).toBe(true)
  })

  it('runs an action-context item against the active tab as the phone’s menu sheet picks it', async () => {
    // The sheet lists `extension.actionMenuItems` and reports the pick with the item's handle
    // (`extension.actionMenuClick`); the runtime's template click behind it is this one.
    const h = harness()
    await withMenus(h)
    await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'night', title: 'Night Mode', type: 'checkbox', checked: false, contexts: ['action'] },
      'night'
    ])
    const [item] = h.runtime.api.actionContextMenuItems(ID)
    expect(item.type).toBe('checkbox')
    expect(item.checked).toBe(false)
    item.click?.()
    const [info] = events(h, 'bg1', 'contextMenus.onClicked')[0].args as [Record<string, unknown>]
    expect(info.menuItemId).toBe('night')
    expect(info.wasChecked).toBe(false)
    expect(info.checked).toBe(true)
    // The pick toggled the item, as Chrome's MenuManager does; the next menu shows it checked.
    expect(h.runtime.api.actionContextMenuItems(ID)[0].checked).toBe(true)
  })

  it('forgets the items with the extension', async () => {
    const h = harness()
    await withMenus(h)
    await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'a', title: 'A', contexts: ['all'] },
      'a'
    ])
    await h.runtime.detach(ID)
    expect(h.runtime.api.contextMenus.size(ID)).toBe(0)
  })
})

describe('chrome.contextMenus persistence (Chrome MenuManager semantics)', () => {
  it('restores a worker extension’s onInstalled items at the next start, before the worker runs', async () => {
    const h = harness()
    await withMenus(h)
    await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'translate', title: 'Translate with DeepL', contexts: ['selection'] },
      'translate'
    ])
    await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'child', title: 'To German', parentId: 'translate', contexts: ['selection'] },
      'child'
    ])
    const saved = h.saved('extensions-runtime.json')
    const persisted = (saved.contextMenus as Record<string, Array<Record<string, unknown>>>)[ID]
    expect(persisted.map((item) => item.id)).toEqual(['translate', 'child'])
    expect(persisted[1].parentId).toBe('translate')

    // Next session, same files: the items are there before any worker context exists.
    const next = harness({ files: h.files })
    await next.runtime.attach(record(next, {}, manifest({ permissions: ['contextMenus'] })))
    expect(next.runtime.api.contextMenus.size(ID)).toBe(2)
    backgroundUp(next, 'bgA', ['contextMenus.onClicked'])
    // DeepL's onStartup path: an update of the onInstalled item finds it now.
    const updated = await call(next, 'bgA', 'contextMenus', 'update', [
      'translate',
      { title: 'Translate selection with DeepL' }
    ])
    expect(updated.ok).toBe(true)
    // A create of the same id is the duplicate it is in Chrome.
    const dup = await call(next, 'bgA', 'contextMenus', 'create', [
      { id: 'translate', title: 'Again', contexts: ['selection'] },
      'translate'
    ])
    expect(String(dup.error)).toBe('Cannot create item with duplicate id translate')
    const shown = next.runtime.api.pageContextMenuItems(
      next.tabs.t1,
      longPress({ linkURL: '', selectionText: 'Hallo' })
    )
    expect(shown.map((item) => item.label)).toEqual(['Translate selection with DeepL'])
  })

  it('keeps items across a detach and drops them only when the extension removes them or is uninstalled', async () => {
    const h = harness()
    await withMenus(h)
    await call(h, 'bg1', 'contextMenus', 'create', [
      { id: 'box', title: 'Box', type: 'checkbox', contexts: ['all'] },
      'box'
    ])
    await h.runtime.detach(ID)
    expect(h.runtime.api.contextMenus.size(ID)).toBe(0)
    expect(Object.keys(h.saved('extensions-runtime.json').contextMenus as object)).toEqual([ID])

    await h.runtime.attach(record(h, {}, manifest({ permissions: ['contextMenus'] })))
    expect(h.runtime.api.contextMenus.size(ID)).toBe(1)
    backgroundUp(h, 'bg2', ['contextMenus.onClicked'])
    // A toggle is state Chrome writes: the next session restores the checked box.
    const [box] = items(h)
    box.click?.()
    const written = (
      h.saved('extensions-runtime.json').contextMenus as Record<
        string,
        Array<Record<string, unknown>>
      >
    )[ID]
    expect(written[0].checked).toBe(true)

    await call(h, 'bg2', 'contextMenus', 'removeAll', [])
    expect(h.saved('extensions-runtime.json').contextMenus).toEqual({})

    await call(h, 'bg2', 'contextMenus', 'create', [{ id: 'again', title: 'Again' }, 'again'])
    expect(Object.keys(h.saved('extensions-runtime.json').contextMenus as object)).toEqual([ID])
    await h.runtime.forget(ID)
    expect(h.saved('extensions-runtime.json').contextMenus).toEqual({})
  })

  it('persists nothing for a persistent background page, which recreates its items itself', async () => {
    const h = harness()
    await withMenus(h, {
      manifest_version: 2,
      background: { scripts: ['bg.js'], persistent: true },
      browser_action: { default_popup: 'popup.html' },
      action: undefined
    })
    await call(h, 'bg1', 'contextMenus', 'create', [{ title: 'Numbered' }, 7])
    expect(h.runtime.api.contextMenus.size(ID)).toBe(1)
    expect(h.saved('extensions-runtime.json').contextMenus ?? {}).toEqual({})
  })
})
