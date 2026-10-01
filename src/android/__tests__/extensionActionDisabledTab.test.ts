import { describe, expect, it } from 'vitest'
import { backgroundUp, call, events, harness, ID, manifest, record } from './runtimeHarness'

/**
 * An action disabled for one tab, as Super Simple Highlighter leaves it on a page without
 * highlights once its defaults are granted (`action.setPopup({popup: 'popup.html'})` for every
 * tab, then `action.disable(tabId)` for the page's; compat round 25): `chrome.action.isEnabled`
 * takes Chrome's tab id and answers that tab's own state, and the toolbar tap on that tab opens
 * nothing – Chrome's click on a disabled action opens no popup and raises no `onClicked`.
 */
describe('chrome.action on a tab the extension disabled it for', () => {
  const highlighter = (): Record<string, unknown> =>
    manifest({ action: { default_title: 'Super Simple Highlighter' }, content_scripts: [] })

  it('isEnabled(tabId) is the tab’s own answer, isEnabled() the global one, and the popup set stays set', async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, highlighter()))
    backgroundUp(h, 'bg1')
    const t1 = h.runtime.api.tabs.chromeIdFor('t1')
    expect((await call(h, 'bg1', 'action', 'getPopup', [{}])).result).toBe('')
    expect((await call(h, 'bg1', 'action', 'setPopup', [{ popup: 'popup.html' }])).error).toBe(
      undefined
    )
    expect((await call(h, 'bg1', 'action', 'disable', [t1])).error).toBeUndefined()
    expect((await call(h, 'bg1', 'action', 'isEnabled', [t1])).result).toBe(false)
    expect((await call(h, 'bg1', 'action', 'isEnabled', [])).result).toBe(true)
    expect((await call(h, 'bg1', 'action', 'getPopup', [{}])).result).toBe(
      `https://${ID}.ext.zenium.invalid/popup.html`
    )
    // Chrome's signature: the id itself, not a details object; anything else is refused.
    const wrong = await call(h, 'bg1', 'action', 'isEnabled', [{ tabId: t1 }])
    expect(wrong.ok).toBe(false)
    expect(wrong.error).toBe('Invalid tab id')
  })

  it('the toolbar tap on that tab opens no popup and raises no onClicked; enabled again, the popup opens', async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, highlighter()))
    backgroundUp(h, 'bg1', ['action.onClicked'])
    const t1 = h.runtime.api.tabs.chromeIdFor('t1')
    await call(h, 'bg1', 'action', 'setPopup', [{ popup: 'popup.html' }])
    await call(h, 'bg1', 'action', 'disable', [t1])
    h.runtime.openPopup(ID)
    expect(h.kt.calledWith('ext.popup.open')).toEqual([])
    expect(events(h, 'bg1', 'action.onClicked')).toEqual([])
    await call(h, 'bg1', 'action', 'enable', [t1])
    h.runtime.openPopup(ID)
    expect(h.kt.calledWith('ext.popup.open')).toEqual([
      {
        id: ID,
        url: `https://${ID}.ext.zenium.invalid/popup.html`,
        context: 'popup',
        title: 'Runtime test'
      }
    ])
  })
})
