import { describe, expect, it } from 'vitest'
import { fakeBrowser, textOf } from './fakeBrowser'

/**
 * `TabView.setAgentDriven` (MCP B): a session working a tab off screen tells the host's view so
 * with `prepare` – a host whose hidden pages have no layout viewport lays the page out and
 * paints it out of the user's sight – and takes the word back when the tab comes in front of
 * the user or the session lets the tab go. A tab the user is looking at never gets it.
 */

/** The calls a tab's view heard, with a run of the same word folded to one: on/off flips. */
const flips = (calls: boolean[] | undefined): boolean[] =>
  (calls ?? []).filter((on, i, all) => i === 0 || all[i - 1] !== on)

describe('a session driving a hidden tab tells the host', () => {
  it('turns it on with the first action on a tab opened in the background, keeps it on across actions, and off when the session ends', async () => {
    const fake = fakeBrowser({ defaultMode: 'background' })
    const user = fake.user.openTab('https://user.example/home')
    const A = await fake.connect('A')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    expect(fake.win.activations).not.toContain(a1)
    expect(fake.agentDriven.get(a1)).toEqual([true])
    await fake.call(A, 'browser_snapshot', { tabId: a1 })
    await fake.call(A, 'browser_click', { tabId: a1, target: 'text=Go' })
    expect(flips(fake.agentDriven.get(a1))).toEqual([true])
    // The user's own tab, in front all along, heard nothing.
    expect(fake.agentDriven.get(user.id) ?? []).toEqual([])
    // Ended without closeTabs: the tab stays open, orphaned, and is no agent's to drive.
    await fake.call(A, 'zen_session', { action: 'end' })
    expect(fake.model.tabs[a1]).toBeDefined()
    expect(flips(fake.agentDriven.get(a1))).toEqual([true, false])
  })

  it('turns it off before the tab closes with `end closeTabs`, and when the user takes the tab back', async () => {
    const fake = fakeBrowser({ defaultMode: 'background' })
    fake.user.openTab('https://user.example/home')
    const A = await fake.connect('A')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    const a2 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/2' })
    )
    expect(flips(fake.agentDriven.get(a1))).toEqual([true])
    expect(flips(fake.agentDriven.get(a2))).toEqual([true])
    // The user takes a2 back from the badge: theirs now, driven by nobody.
    fake.service.releaseTab(a2)
    expect(flips(fake.agentDriven.get(a2))).toEqual([true, false])
    const ended = await fake.call(A, 'zen_session', { action: 'end', closeTabs: true })
    expect(textOf(ended)).toContain('closed')
    expect(fake.model.tabs[a1]).toBeUndefined()
    expect(flips(fake.agentDriven.get(a1))).toEqual([true, false])
  })

  it('turns it off when the tab comes in front of the user – foreground with the screen – and on again when the agent goes back to the background', async () => {
    const fake = fakeBrowser({ defaultMode: 'background' })
    fake.user.openTab('https://user.example/home')
    const A = await fake.connect('A')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    expect(flips(fake.agentDriven.get(a1))).toEqual([true])
    // Foreground without the screen: the tab stays off screen, so it stays the agent's to drive.
    await fake.call(A, 'zen_mode', { mode: 'foreground' })
    const degraded = textOf(await fake.call(A, 'browser_click', { tabId: a1, target: 'text=Go' }))
    expect(degraded).toContain('acted in background')
    expect(flips(fake.agentDriven.get(a1))).toEqual([true])
    // With the screen the action brings the tab in front: the layout's again.
    await fake.call(A, 'zen_mode', { mode: 'foreground', takeScreen: true })
    await fake.call(A, 'browser_click', { tabId: a1, target: 'text=Go' })
    expect(fake.win.activations).toContain(a1)
    expect(flips(fake.agentDriven.get(a1))).toEqual([true, false])
    // The user moves on and the agent works in the background again: on again.
    fake.user.openTab('https://user.example/two')
    await fake.call(A, 'zen_mode', { mode: 'background' })
    await fake.call(A, 'browser_snapshot', { tabId: a1 })
    expect(flips(fake.agentDriven.get(a1))).toEqual([true, false, true])
  })

  it('never gives it to a tab the user is looking at: a foreground tab of the agent’s own, or the user’s active tab worked with allowForeign', async () => {
    const fake = fakeBrowser()
    const user = fake.user.openTab('https://user.example/home')
    const A = await fake.connect('A')
    expect(A.mode).toBe('foreground')
    // The user's foreground default hands the agent the screen: the new tab comes in front.
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    expect(fake.win.activations).toContain(a1)
    await fake.call(A, 'browser_click', { tabId: a1, target: 'text=Go' })
    expect(fake.agentDriven.get(a1)).not.toContain(true)
    // A background agent reading the tab the user has in front: the layout shows it already.
    const B = await fake.connect('B', { mode: 'background' })
    fake.user.activate(user.id)
    await fake.call(B, 'browser_snapshot', { tabId: user.id, allowForeign: true })
    expect(fake.agentDriven.get(user.id)).not.toContain(true)
  })
})
