import { describe, expect, it } from 'vitest'
import { folderTabs } from '../../model'
import type { ToolDefinition } from '../protocol'
import {
  AGENTS_SPACE_NAME,
  FOREGROUND_LEASE_MS,
  homeGroupName,
  withUnknownArgsNote
} from '../service'
import { AGENT_TOOLS } from '../tools'
import { fakeBrowser, textOf } from './fakeBrowser'

/**
 * Two agents and the user in one browser: sessions own tab groups, every page tool names its
 * tab, foreign tabs need `allowForeign`, another live agent's tabs are never reachable, calls
 * of one session run one at a time, notices report what happened to a session's tabs, ended
 * sessions leave orphaned groups to adopt, and the screen is a lease.
 */

const def = (name: string): ToolDefinition =>
  AGENT_TOOLS.find((t) => t.definition.name === name)!.definition

describe('sessions own tab groups', () => {
  it('the first new tab makes the home group in the shared Agents space, owned from that tick', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    expect(fake.model.spaces.map((sp) => sp.name)).toEqual(['Work'])
    const opened = await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    const a1 = fake.openedTab(opened)
    const agents = fake.model.spaces.find((sp) => sp.name === AGENTS_SPACE_NAME)!
    expect(agents).toBeDefined()
    expect(A.groupIds.size).toBe(1)
    const home = fake.model.folders[A.homeGroupId!]
    expect(home.name).toBe(homeGroupName(A))
    expect(home.name).toBe(`A · ${A.id.slice(-4)}`)
    expect(home.spaceId).toBe(agents.id)
    expect(fake.model.tabs[a1].folderId).toBe(home.id)
    expect(fake.service.ownedTabs(A).map((t) => t.id)).toEqual([a1])
    expect(textOf(opened)).toContain(`Pass tabId: "${a1}" to page tools`)
    expect(textOf(opened)).toContain(`in your home group "${home.name}"`)
    // The user's own space was left alone, and the window still shows it.
    expect(fake.userSpace.tabIds).toEqual([])
    expect(fake.win.activeSpaceId).toBe(agents.id) // foreground: the agent's tab came in front
    // A second new tab joins the same group (idempotent home group).
    const a2 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/2' })
    )
    expect(A.groupIds.size).toBe(1)
    expect(folderTabs(fake.model, home.id).map((t) => t.id)).toEqual([a1, a2])
  })

  it('two sessions interleave: each in its own group, neither can address the other', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const B = await fake.connect('B')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    const b1 = fake.openedTab(
      await fake.call(B, 'browser_tabs', { action: 'new', url: 'https://b.example/1' })
    )
    const a2 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/2' })
    )
    expect(fake.service.ownedTabs(A).map((t) => t.id)).toEqual([a1, a2])
    expect(fake.service.ownedTabs(B).map((t) => t.id)).toEqual([b1])
    expect(A.homeGroupId).not.toBe(B.homeGroupId)

    // A cannot snapshot, close or navigate B's tab – not even with allowForeign while B lives.
    for (const args of [{ tabId: b1 }, { tabId: b1, allowForeign: true }]) {
      const r = await fake.call(A, 'browser_snapshot', args)
      expect(r.isError).toBe(true)
      expect(textOf(r)).toMatch(/owned by agent "B"/)
      expect(textOf(r)).toContain('not even with allowForeign')
      expect(textOf(r)).toContain(`Your tabs: ${a1}`)
    }
    const close = await fake.call(A, 'browser_tabs', {
      action: 'close',
      tabId: b1,
      allowForeign: true
    })
    expect(close.isError).toBe(true)
    expect(fake.model.tabs[b1]).toBeDefined()
    const nav = await fake.call(A, 'browser_navigate', { url: 'https://evil.example', tabId: b1 })
    expect(nav.isError).toBe(true)
    expect(fake.model.tabs[b1].url).toBe('https://b.example/1')

    // Positions are refused with the reason; ids and unique prefixes resolve within scope.
    const pos = await fake.call(A, 'browser_snapshot', { tabId: 1 })
    expect(pos.isError).toBe(true)
    expect(textOf(pos)).toMatch(/not a list position \(1\)/)
    expect(textOf(pos)).toContain('positions shift')
    expect(textOf(await fake.call(A, 'browser_snapshot', { tabId: '2' }))).toMatch(/list position/)
    const byPrefix = await fake.call(A, 'browser_snapshot', { tabId: a2.slice(0, 12) })
    expect(byPrefix.isError).toBeUndefined()
    expect(textOf(byPrefix)).toContain(`- Tab: ${a2} (yours; foreground mode)`)
    // A prefix that names B's tab is B's, whatever the session passes.
    const foreignPrefix = await fake.call(A, 'browser_snapshot', { tabId: b1.slice(0, 12) })
    expect(textOf(foreignPrefix)).toMatch(/owned by agent "B"/)
    // An ambiguous prefix among the session's own tabs asks for more of the id.
    const ambiguous = await fake.call(A, 'browser_snapshot', { tabId: 'tab_' })
    expect(textOf(ambiguous)).toMatch(/matches 2 of your tabs/)
    // B owns one tab: "tab_" is unique within its scope.
    expect(textOf(await fake.call(B, 'browser_snapshot', { tabId: 'tab_' }))).toContain(
      `- Tab: ${b1} (yours`
    )

    // list shows only the caller's tabs; scope "all" shows everything with owners.
    const own = textOf(await fake.call(A, 'browser_tabs', { action: 'list' }))
    expect(own).toContain(a1)
    expect(own).toContain(a2)
    expect(own).not.toContain(b1)
    expect(own).toContain(`Group "${homeGroupName(A)}" (${A.homeGroupId}) [home]`)
    const user = fake.user.openTab('https://user.example/home')
    const all = textOf(await fake.call(A, 'browser_tabs', { action: 'list', scope: 'all' }))
    expect(all).toMatch(new RegExp(`- ${a1} .*\\[.*yours`))
    expect(all).toMatch(new RegExp(`- ${b1} .*\\[.*owned by "B"`))
    expect(all).toMatch(new RegExp(`- ${user.id} .*\\[user's active tab\\]`))
    expect(all).toContain(`Space "${AGENTS_SPACE_NAME}"`)
    // zen_status: you, your groups, the others by name and mode only, no user tabs.
    const status = textOf(await fake.call(A, 'zen_status'))
    expect(status).toContain(`You are "A" (session ${A.id}`)
    expect(status).toContain('- "B" – foreground, 1 group')
    expect(status).toContain(a1)
    expect(status).not.toContain(user.id)
    expect(status).not.toContain(b1)
  })

  it("the user's tabs need allowForeign, and their Essentials are never closed", async () => {
    const fake = fakeBrowser()
    const B = await fake.connect('B')
    const user = fake.user.openTab('https://user.example/page')
    const ess = fake.user.openTab('https://mail.example', { essential: true })
    const refused = await fake.call(B, 'browser_snapshot', { tabId: user.id })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(/is not one of yours \(it is the user's\)/)
    expect(textOf(refused)).toContain('pass allowForeign: true')
    const allowed = await fake.call(B, 'browser_snapshot', { tabId: user.id, allowForeign: true })
    expect(allowed.isError).toBeUndefined()
    expect(textOf(allowed)).toContain(`- Tab: ${user.id} (the user's, with allowForeign`)
    // allowForeign never transfers ownership.
    expect(fake.service.ownedTabs(B)).toEqual([])
    expect(B.groupIds.size).toBe(0)
    const closeEss = await fake.call(B, 'browser_tabs', {
      action: 'close',
      tabId: ess.id,
      allowForeign: true
    })
    expect(closeEss.isError).toBe(true)
    expect(textOf(closeEss)).toMatch(/an Essential of the user's/)
    expect(fake.model.tabs[ess.id]).toBeDefined()
    // A regular tab of the user's closes with allowForeign when they asked for it.
    const closed = await fake.call(B, 'browser_tabs', {
      action: 'close',
      tabId: user.id,
      allowForeign: true
    })
    expect(closed.isError).toBeUndefined()
    expect(textOf(closed)).toContain("(a tab of the user's, with allowForeign)")
    expect(fake.model.tabs[user.id]).toBeUndefined()
    // The resource form of the same rule.
    const own = fake.openedTab(
      await fake.call(B, 'browser_tabs', { action: 'new', url: 'https://b.example/1' })
    )
    const second = fake.user.openTab('https://user.example/two')
    await expect(fake.service.readResource(B, `zenium://tab/${second.id}/text`)).rejects.toThrow(
      /not one of yours/
    )
    const mine = await fake.service.readResource(B, `zenium://tabs`)
    expect(JSON.parse(mine[0].text!).map((t: { id: string }) => t.id)).toEqual([own])
    const everything = await fake.service.readResource(B, `zenium://tabs?scope=all`)
    const ids = JSON.parse(everything[0].text!).map((t: { id: string }) => t.id)
    expect(ids).toContain(second.id)
    expect(ids).toContain(own)
  })

  it("opening in the user's space is a foreign act; own spaces and groups are the agent's", async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const refused = await fake.call(A, 'browser_tabs', {
      action: 'new',
      url: 'https://a.example',
      spaceId: fake.userSpace.id
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(/foreign act/)
    expect(fake.userSpace.tabIds).toEqual([])
    const allowed = await fake.call(A, 'browser_tabs', {
      action: 'new',
      url: 'https://a.example',
      spaceId: fake.userSpace.id,
      allowForeign: true
    })
    const loose = fake.openedTab(allowed)
    expect(fake.model.tabs[loose].spaceId).toBe(fake.userSpace.id)
    expect(textOf(allowed)).toContain('not in one of your groups')
    expect(fake.service.ownedTabs(A)).toEqual([])

    const created = await fake.call(A, 'zen_groups', {
      action: 'create',
      name: 'Research',
      space: 'own'
    })
    const gid = fake.createdGroup(created)
    const group = fake.model.folders[gid]
    const ownSpace = fake.model.spaces.find((sp) => sp.id === group.spaceId)!
    expect(ownSpace.name).toBe('A')
    expect(fake.service.isAgentSpace(ownSpace.id)).toBe(true)
    expect(fake.win.activeSpaceId).toBe(fake.userSpace.id) // not switched
    const inGroup = fake.openedTab(
      await fake.call(A, 'browser_tabs', {
        action: 'new',
        url: 'https://a.example/r',
        groupId: gid
      })
    )
    expect(fake.model.tabs[inGroup].folderId).toBe(gid)
    expect(fake.model.tabs[inGroup].spaceId).toBe(ownSpace.id)
    // Aliases: "folder" for groupId, the group's name instead of its id.
    const alias = fake.openedTab(
      await fake.call(A, 'browser_tabs', {
        action: 'new',
        url: 'https://a.example/s',
        folder: 'research'
      })
    )
    expect(fake.model.tabs[alias].folderId).toBe(gid)
    const renamed = await fake.call(A, 'zen_groups', {
      action: 'rename',
      groupId: gid,
      name: 'Sources'
    })
    expect(textOf(renamed)).toContain('to "Sources"')
    expect(group.name).toBe('Sources')
    const listed = textOf(await fake.call(A, 'zen_groups', { action: 'list' }))
    expect(listed).toContain(`Group "Sources" (${gid})`)
    const closed = await fake.call(A, 'zen_groups', { action: 'close', groupId: gid })
    expect(textOf(closed)).toContain('and its 2 tabs')
    expect(fake.model.folders[gid]).toBeUndefined()
    expect(fake.model.tabs[inGroup]).toBeUndefined()
    expect(A.groupIds.has(gid)).toBe(false)
    // A group of the user's space needs allowForeign too.
    const foreignGroup = await fake.call(A, 'zen_groups', {
      action: 'create',
      space: fake.userSpace.id
    })
    expect(foreignGroup.isError).toBe(true)
    expect(textOf(foreignGroup)).toMatch(/foreign act/)
  })
})

describe('per-session queue', () => {
  it('serialises one session while another runs in between', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const B = await fake.connect('B')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    await fake.call(B, 'browser_tabs', { action: 'new', url: 'https://b.example/1' })
    const gate = fake.hold(a1)
    const order: string[] = []
    const a1Snapshot = fake.call(A, 'browser_snapshot', { tabId: a1 }).then((r) => {
      order.push('A1')
      return r
    })
    const a2List = fake.call(A, 'browser_tabs', { action: 'list' }).then((r) => {
      order.push('A2')
      return r
    })
    const b1List = fake.call(B, 'browser_tabs', { action: 'list' }).then((r) => {
      order.push('B1')
      return r
    })
    await b1List
    // B's call finished while A's first call is still held and its second waits behind it.
    expect(order).toEqual(['B1'])
    gate.release()
    await Promise.all([a1Snapshot, a2List])
    expect(order).toEqual(['B1', 'A1', 'A2'])
    expect(textOf(await a1Snapshot)).toContain('Snapshot taken.')
  })

  it('a failing call does not block the next one of the session', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const bad = await fake.call(A, 'browser_snapshot', { tabId: 'tab_nope' })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toMatch(/Unknown tab "tab_nope"/)
    const ok = await fake.call(A, 'browser_tabs', { action: 'list' })
    expect(ok.isError).toBeUndefined()
  })
})

describe('notices', () => {
  it('the user closing a tab of the session shows up once, atop the next result', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    const a2 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/2' })
    )
    fake.user.closeTab(a1)
    const next = textOf(await fake.call(A, 'browser_tabs', { action: 'list' }))
    expect(
      next.startsWith(`Notice: tab ${a1} "Page a.example/1" was closed by the user.\n\n`)
    ).toBe(true)
    expect(next).toContain(a2)
    expect(next).not.toMatch(new RegExp(`- ${a1} `))
    const after = textOf(await fake.call(A, 'browser_tabs', { action: 'list' }))
    expect(after).not.toContain('Notice:')
    // A tab moved out of the group by the user is reported, and is not the session's any more.
    fake.user.moveToFolder(a2, null)
    const moved = textOf(await fake.call(A, 'browser_tabs', { action: 'list' }))
    expect(moved).toMatch(
      new RegExp(`^Notice: tab ${a2} "Page a.example/2" was moved out of your group`)
    )
    expect(fake.service.ownedTabs(A)).toEqual([])
  })

  it('releasing a tab from Settings and removing the group are reported too', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    fake.service.releaseTab(a1)
    expect(fake.model.tabs[a1].folderId).toBeNull()
    const released = textOf(await fake.call(A, 'zen_status'))
    expect(released).toMatch(new RegExp(`^Notice: tab ${a1} .* was released by the user`))
    expect(released).toContain('allowForeign: true')
    const home = A.homeGroupId!
    fake.user.deleteFolder(home, true)
    const gone = textOf(await fake.call(A, 'zen_status'))
    expect(gone).toMatch(/Notice: your group ".*" \(folder_[\w-]+\) was removed by the user/)
    expect(gone).toContain('your next browser_tabs new makes a new home group')
    expect(A.groupIds.size).toBe(0)
    expect(A.homeGroupId).toBeNull()
    const again = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/3' })
    )
    expect(A.homeGroupId).not.toBe(home)
    expect(fake.model.tabs[again].folderId).toBe(A.homeGroupId)
  })

  it('a session closing all tabs of its own group gets no notice about it', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    await fake.call(A, 'browser_tabs', { action: 'close', tabId: a1 })
    expect(textOf(await fake.call(A, 'browser_tabs', { action: 'list' }))).not.toContain('Notice:')
  })
})

describe('end of session and orphaned groups', () => {
  it('a closed session leaves its group orphaned for another session to adopt', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const B = await fake.connect('B')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    const home = A.homeGroupId!
    fake.service.close(A.id) // DELETE / idle sweep
    expect(fake.service.session(A.id)).toBeUndefined()
    expect(fake.model.folders[home]).toBeDefined()
    expect(fake.model.tabs[a1]).toBeDefined()
    const all = textOf(await fake.call(B, 'zen_groups', { action: 'list', scope: 'all' }))
    expect(all).toContain(`Group "${homeGroupName(A)}" (${home}) [orphaned, was "A"]`)
    const tabs = textOf(await fake.call(B, 'browser_tabs', { action: 'list', scope: 'all' }))
    expect(tabs).toMatch(new RegExp(`- ${a1} .*\\[.*orphaned, was "A"`))
    const refused = await fake.call(B, 'browser_snapshot', { tabId: a1 })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('orphaned agent group')
    expect(textOf(refused)).toContain(`zen_groups {"action":"adopt","groupId":"${home}"}`)
    // With allowForeign an orphaned tab can be read (the control session's case)…
    const read = await fake.call(B, 'browser_snapshot', { tabId: a1, allowForeign: true })
    expect(read.isError).toBeUndefined()
    expect(textOf(read)).toContain(`- Tab: ${a1} (orphaned, was "A";`)
    // …and adopting the group makes it, and its tabs, B's.
    const adopted = await fake.call(B, 'zen_groups', { action: 'adopt', groupId: home })
    expect(adopted.isError).toBeUndefined()
    expect(textOf(adopted)).toContain(
      `Adopted group ${home} "${homeGroupName(A)}" (was "A"'s) with 1 tab; it is your home group now`
    )
    expect(B.groupIds.has(home)).toBe(true)
    expect(fake.service.ownedTabs(B).map((t) => t.id)).toEqual([a1])
    expect(textOf(await fake.call(B, 'browser_snapshot', { tabId: a1 }))).toContain(
      `- Tab: ${a1} (yours`
    )
    // Adopting again, or adopting a live agent's or the user's group, is refused with the reason.
    expect(textOf(await fake.call(B, 'zen_groups', { action: 'adopt', groupId: home }))).toMatch(
      /already yours/
    )
    const C = await fake.connect('C')
    expect(textOf(await fake.call(C, 'zen_groups', { action: 'adopt', groupId: home }))).toMatch(
      /belongs to agent "B", which is still connected/
    )
    expect(
      textOf(await fake.call(C, 'zen_groups', { action: 'adopt', groupId: 'folder_x' }))
    ).toMatch(/Unknown group "folder_x"/)
  })

  it('a control session may close an orphaned tab with allowForeign; nothing closes it by itself', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    fake.service.close(A.id)
    const C = await fake.connect('control')
    const refused = await fake.call(C, 'browser_tabs', { action: 'close', tabId: a1 })
    expect(refused.isError).toBe(true)
    expect(fake.model.tabs[a1]).toBeDefined()
    const closed = await fake.call(C, 'browser_tabs', {
      action: 'close',
      tabId: a1,
      allowForeign: true
    })
    expect(closed.isError).toBeUndefined()
    expect(textOf(closed)).toContain('(a tab of an orphaned agent group, with allowForeign)')
    expect(fake.model.tabs[a1]).toBeUndefined()
  })

  it('zen_session end closes the groups only when asked; rename relabels the home group', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    const home = A.homeGroupId!
    const renamed = await fake.call(A, 'zen_session', { action: 'rename', name: 'Researcher' })
    expect(textOf(renamed)).toContain('You are "Researcher" now (was "A"')
    expect(A.name).toBe('Researcher')
    expect(fake.model.folders[home].name).toBe(`Researcher · ${A.id.slice(-4)}`)
    const kept = await fake.call(A, 'zen_session', { action: 'end' })
    expect(textOf(kept)).toContain('stay open as orphaned groups')
    expect(textOf(kept)).toContain('Your connection stays open')
    // The MCP session is the transport's, not the agent's to destroy: the record stays, empty.
    expect(fake.service.session(A.id)).toBe(A)
    expect(A.groupIds.size).toBe(0)
    expect(A.homeGroupId).toBeNull()
    expect(fake.model.tabs[a1]).toBeDefined()
    expect(fake.service.isOrphan(home)).toBe(true)
    expect(fake.service.orphanWas(home)).toBe('Researcher')
    // The next call is answered and starts over: a new home group, the old one still orphaned.
    const again = await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/2' })
    expect(again.isError).toBeUndefined()
    expect(A.homeGroupId).not.toBeNull()
    expect(A.homeGroupId).not.toBe(home)
    expect(fake.service.isOrphan(home)).toBe(true)
    expect(fake.service.diagnosticsSnapshot().sessions.ended).toBe(1)

    const B = await fake.connect('B')
    const b1 = fake.openedTab(
      await fake.call(B, 'browser_tabs', { action: 'new', url: 'https://b.example/1' })
    )
    const bHome = B.homeGroupId!
    const ended = await fake.call(B, 'zen_session', { action: 'end', closeTabs: true })
    expect(textOf(ended)).toContain('your 1 group and 1 tab were closed')
    expect(fake.model.tabs[b1]).toBeUndefined()
    expect(fake.model.folders[bHome]).toBeUndefined()
    expect(fake.service.session(B.id)).toBe(B)
    expect(B.groupIds.size).toBe(0)
    // A's orphaned group is still there: nothing closes orphans by itself.
    expect(fake.model.folders[home]).toBeDefined()
  })

  it('an idle session is parked, not lost: its next call is answered and its groups come back', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    const home = A.homeGroupId!
    // Idle past the limit: the sweeper runs (as its minute timer would).
    A.lastActiveAt = Date.now() - 31 * 60 * 1000
    ;(fake.service as unknown as { sweep(): void }).sweep()
    expect(fake.service.session(A.id)).toBe(A)
    expect(A.parked).toBe(true)
    expect(fake.service.isOrphan(home)).toBe(true)
    expect(fake.service.list().map((a) => a.id)).not.toContain(A.id)
    // The transport touches the session on the client's next request: it is back, groups and all.
    fake.service.touch(A)
    expect(A.parked).toBe(false)
    expect(A.groupIds.has(home)).toBe(true)
    expect(fake.service.isOrphan(home)).toBe(false)
    const status = await fake.call(A, 'zen_status')
    expect(textOf(status)).toContain('parked; it is back, and your 1 group')
    expect(textOf(status)).toContain(a1)
    const d = fake.service.diagnosticsSnapshot()
    expect(d.sessions.parkedTotal).toBe(1)
    expect(d.sessions.resumed).toBe(1)
    expect(d.sessions.live).toBe(1)

    // Parked long enough with nobody coming back, the record goes for good.
    A.lastActiveAt = Date.now() - 31 * 60 * 1000
    ;(fake.service as unknown as { sweep(): void }).sweep()
    A.lastActiveAt = Date.now() - 25 * 60 * 60 * 1000
    ;(fake.service as unknown as { sweep(): void }).sweep()
    expect(fake.service.session(A.id)).toBeUndefined()
    expect(fake.service.isOrphan(home)).toBe(true)
  })

  it('a session id nothing answers is resumed for a client with the token, and a 404 without', async () => {
    const fake = fakeBrowser()
    const token = fake.service.serverStatus().token
    const A = await fake.connect('A')
    await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    const home = A.homeGroupId!
    // The browser "restarts": the record is gone, the client still holds the id.
    fake.service.close(A.id)
    expect(fake.service.session(A.id)).toBeUndefined()
    const post = (
      body: unknown,
      headers: Record<string, string>
    ): ReturnType<typeof fake.service.handleHttp> =>
      fake.service.handleHttp({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json', 'user-agent': 'test', ...headers },
        body: JSON.stringify(body),
        remoteAddress: '127.0.0.1'
      })
    const call = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'zen_status' } }
    const refused = await post(call, { 'mcp-session-id': A.id })
    expect(refused.status).toBe(404)
    expect(fake.service.diagnosticsSnapshot().sessions.unknown).toBe(1)

    const resumed = await post(call, {
      'mcp-session-id': A.id,
      'mcp-protocol-version': '2025-06-18',
      authorization: `Bearer ${token}`
    })
    expect(resumed.status).toBe(200)
    const body = JSON.parse(resumed.body) as { result: { content: { text: string }[] } }
    const text = body.result.content[0].text
    expect(text).toContain('your connection was resumed without an initialize')
    expect(text).toContain('You are "A"') // the name the client last introduced itself with
    const again = fake.service.session(A.id)!
    expect(again.protocolVersion).toBe('2025-06-18')
    expect(again.approved).toBe(true)
    expect(fake.service.isOrphan(home)).toBe(true)
    expect(fake.service.diagnosticsSnapshot().sessions.resurrected).toBe(1)
    // A second call on the resumed session carries no notice any more.
    const second = await post(
      { ...call, id: 8 },
      { 'mcp-session-id': A.id, authorization: `Bearer ${token}` }
    )
    expect(second.status).toBe(200)
    expect(
      (JSON.parse(second.body) as { result: { content: { text: string }[] } }).result.content[0]
        .text
    ).not.toContain('Notice: your connection was resumed')
  })
})

describe('foreground lease', () => {
  it('a second foreground agent acts in the background while the holder is active', async () => {
    const fake = fakeBrowser()
    let now = 1_000_000
    fake.service.clock = () => now
    const A = await fake.connect('A')
    const B = await fake.connect('B')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    expect(fake.win.activations).toContain(a1)
    expect(fake.service.leaseHolder(fake.win)?.id).toBe(A.id)
    now += 5_000
    const opened = await fake.call(B, 'browser_tabs', { action: 'new', url: 'https://b.example/1' })
    const b1 = fake.openedTab(opened)
    expect(
      textOf(opened).startsWith(
        'foreground: another agent, "A", holds the screen – acted in background\n\n'
      )
    ).toBe(true)
    expect(fake.win.activations).not.toContain(b1)
    expect(fake.service.leaseHolder(fake.win)?.id).toBe(A.id)
    const snap = textOf(await fake.call(B, 'browser_snapshot', { tabId: b1 }))
    expect(snap).toContain('acted in background')
    expect(snap).toContain(
      `- Tab: ${b1} (yours; foreground mode, acted in background – another agent holds the screen)`
    )
    // B cannot switch the space the user sees while A holds the lease.
    const sw = await fake.call(B, 'zen_spaces', { action: 'switch', spaceId: fake.userSpace.id })
    expect(sw.isError).toBe(true)
    expect(textOf(sw)).toMatch(/needs the screen lease, and agent "A" holds it/)
    expect(textOf(await fake.call(B, 'zen_status'))).toContain(
      'Agent "A" holds the screen: your foreground actions run in the background'
    )
    // Once A has been quiet for the lease time, B takes the screen.
    now += FOREGROUND_LEASE_MS + 1
    const taken = await fake.call(B, 'browser_snapshot', { tabId: b1 })
    expect(textOf(taken)).not.toContain('acted in background')
    expect(fake.win.activations).toContain(b1)
    expect(fake.service.leaseHolder(fake.win)?.id).toBe(B.id)
    expect(textOf(await fake.call(A, 'zen_status'))).toContain('Agent "B" holds the screen')
    expect(textOf(await fake.call(B, 'zen_status'))).toContain('You hold the screen.')
    // A background agent never takes the lease, and switching needs foreground mode.
    A.mode = 'background'
    now += 1
    await fake.call(A, 'browser_snapshot', { tabId: a1 })
    expect(fake.service.leaseHolder(fake.win)?.id).toBe(B.id)
    const bg = await fake.call(A, 'zen_spaces', { action: 'switch', spaceId: fake.userSpace.id })
    expect(textOf(bg)).toMatch(/you are in background mode/)
    // zen_mode reports the lease instead of activating a tab.
    const mode = textOf(await fake.call(A, 'zen_mode', { mode: 'fg' }))
    expect(mode).toContain('You are now in foreground mode.')
    expect(mode).toContain('Agent "B" holds the screen')
    // The lease decides the input path: a degraded call routes synthetic input and says so.
    now += 1
    const clicked = textOf(await fake.call(A, 'browser_click', { tabId: a1, target: 'text=Go' }))
    expect(clicked).toContain('input: synthetic – another agent holds the screen')
    expect(fake.input.get(a1)).toEqual([])
  })
})

describe('compatibility paths', () => {
  it('omitted tabId resolves only while the session owns exactly one tab', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const none = await fake.call(A, 'browser_snapshot', {})
    expect(none.isError).toBe(true)
    expect(textOf(none)).toContain('You have no tab yet')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    const one = await fake.call(A, 'browser_snapshot', {})
    expect(one.isError).toBeUndefined()
    expect(textOf(one)).toContain(`- Tab: ${a1} (yours; foreground mode)`)
    const a2 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/2' })
    )
    const two = await fake.call(A, 'browser_snapshot', {})
    expect(two.isError).toBe(true)
    expect(textOf(two)).toContain('tabId is required: you own 2 tabs and there is no current tab')
    expect(textOf(two)).toContain(a1)
    expect(textOf(two)).toContain(a2)
  })

  it('browser_navigate opens a tab in the home group when the session owns none', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const r = await fake.call(A, 'browser_navigate', { url: 'https://a.example/start' })
    const tab = fake.openedTab(r)
    expect(textOf(r)).toMatch(/^Navigated to https:\/\/a\.example\/start\. Opened tab tab_/)
    expect(fake.model.tabs[tab].folderId).toBe(A.homeGroupId)
    expect(fake.model.tabs[tab].url).toBe('https://a.example/start')
    // With one tab it is the implicit one; search words become a search URL.
    await fake.call(A, 'browser_navigate', { url: 'zen browser' })
    expect(fake.model.tabs[tab].url).toBe('https://search.example/?q=zen%20browser')
    expect(fake.service.ownedTabs(A)).toHaveLength(1)
  })

  it('select is a deprecated alias of browser_snapshot that sets no current tab', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/2' })
    const selected = await fake.call(A, 'browser_tabs', { action: 'switch', tabId: a1 })
    expect(textOf(selected)).toMatch(/^Deprecated: there is no current tab any more/)
    expect(textOf(selected)).toContain('Snapshot')
    expect(textOf(selected)).toContain(`- Tab: ${a1} (yours`)
    const bare = await fake.call(A, 'browser_snapshot', {})
    expect(bare.isError).toBe(true) // still two tabs, still no current one
    const noTab = await fake.call(A, 'browser_tabs', { action: 'select' })
    expect(textOf(noTab)).toMatch(/select needs tabId/)
  })

  it('group and ungroup work on own tabs only, through the own groups', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const B = await fake.connect('B')
    const a1 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    )
    const a2 = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/2' })
    )
    const b1 = fake.openedTab(
      await fake.call(B, 'browser_tabs', { action: 'new', url: 'https://b.example/1' })
    )
    const home = A.homeGroupId!
    const grouped = await fake.call(A, 'browser_tabs', {
      action: 'group',
      tabIds: [a1, a2],
      name: 'Research'
    })
    expect(grouped.isError).toBeUndefined()
    expect(textOf(grouped)).toMatch(/^Created group "Research" \(folder_[\w-]+\) with 2 tabs/)
    const research = fake.service.groupsOf(A).find((g) => g.name === 'Research')!
    expect(A.groupIds.has(research.id)).toBe(true)
    expect(fake.model.tabs[a1].folderId).toBe(research.id)
    expect(fake.model.tabs[a2].folderId).toBe(research.id)
    expect(
      fake.service
        .ownedTabs(A)
        .map((t) => t.id)
        .sort()
    ).toEqual([a1, a2].sort())
    // B's tab cannot be grouped by A, nor can the user's.
    const foreign = await fake.call(A, 'browser_tabs', {
      action: 'group',
      tabIds: [a1, b1],
      name: 'X'
    })
    expect(foreign.isError).toBe(true)
    expect(fake.model.tabs[b1].folderId).toBe(B.homeGroupId)
    const user = fake.user.openTab('https://user.example')
    const users = await fake.call(A, 'browser_tabs', {
      action: 'group',
      tabIds: [user.id],
      name: 'X',
      allowForeign: true
    })
    expect(users.isError).toBe(true)
    expect(fake.model.tabs[user.id].folderId).toBeNull()
    // ungroup moves the tab back to the home group: a tab of the agent's always has a group.
    const ungrouped = await fake.call(A, 'browser_tabs', { action: 'ungroup', tabId: a2 })
    expect(textOf(ungrouped)).toContain('to your home group')
    expect(fake.model.tabs[a2].folderId).toBe(home)
    // move: between own groups, and to a slot.
    const moved = await fake.call(A, 'browser_tabs', {
      action: 'move',
      tabId: a1,
      groupId: 'home',
      index: 1
    })
    expect(moved.isError).toBeUndefined()
    expect(fake.model.tabs[a1].folderId).toBe(home)
    expect(folderTabs(fake.model, home).map((t) => t.id)).toEqual([a1, a2])
    const moveForeign = await fake.call(A, 'browser_tabs', {
      action: 'move',
      tabId: b1,
      groupId: 'home'
    })
    expect(moveForeign.isError).toBe(true)
    expect(textOf(moveForeign)).toMatch(/owned by agent "B"/)
    // The user's tab is not movable either, allowForeign or not: it would become the agent's.
    const moveUsers = await fake.call(A, 'browser_tabs', {
      action: 'move',
      tabId: user.id,
      groupId: 'home',
      allowForeign: true
    })
    expect(moveUsers.isError).toBe(true)
    expect(textOf(moveUsers)).toMatch(
      /is not one of yours \(the user's\) – browser_tabs move works on your own tabs only, with or without allowForeign/
    )
    expect(fake.model.tabs[user.id].folderId).toBeNull()
    // Moving into B's group is refused too.
    const intoB = await fake.call(A, 'browser_tabs', {
      action: 'move',
      tabId: a1,
      groupId: B.homeGroupId!
    })
    expect(intoB.isError).toBe(true)
    expect(textOf(intoB)).toMatch(/belongs to agent "B"/)
  })

  it('browser_tabs names its actions and the arguments each needs', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    expect(textOf(await fake.call(A, 'browser_tabs', { action: 'explode' }))).toMatch(
      /Unknown action "explode" – use one of "list", "new", "close", "move", "select", "group", "ungroup"/
    )
    expect(textOf(await fake.call(A, 'browser_tabs', { action: 'reorder' }))).toMatch(
      /move needs tabId/
    )
    expect(textOf(await fake.call(A, 'browser_tabs', { action: 'group' }))).toMatch(
      /group needs tabIds/
    )
    expect(textOf(await fake.call(A, 'browser_tabs', { action: 'close' }))).toMatch(
      /close needs tabId/
    )
    // Nothing at all lists; a bare url opens.
    expect(textOf(await fake.call(A, 'browser_tabs', {}))).toContain('no groups yet')
    const opened = await fake.call(A, 'browser_tabs', { url: 'https://a.example' })
    expect(textOf(opened)).toMatch(/^Opened tab tab_/)
    expect(textOf(await fake.call(A, 'zen_groups', { action: 'explode' }))).toMatch(
      /use one of "list", "create", "rename", "close", "adopt"/
    )
    expect(textOf(await fake.call(A, 'zen_session', { action: 'explode' }))).toMatch(
      /use one of "status", "end", "rename"/
    )
  })

  it('zen_mode accepts short forms and rejects other values', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const r = await fake.call(A, 'zen_mode', { mode: 'bg' })
    expect(A.mode).toBe('background')
    expect(textOf(r)).toContain('You are now in background mode.')
    expect(textOf(await fake.call(A, 'zen_mode', { mode: 'sideways' }))).toMatch(
      /"foreground" or "background"/
    )
  })
})

describe('unknown-argument note with the new arguments', () => {
  it('knows the groupId and allowForeign aliases and still flags typos', () => {
    const result = withUnknownArgsNote(
      def('browser_tabs'),
      { action: 'new', folder: 'home', outside: true, bogus: 1 },
      { content: [{ type: 'text', text: 'Opened.' }] }
    )
    const text = textOf(result)
    expect(text).toContain('Opened.')
    expect(text).toContain('"bogus"')
    expect(text).not.toContain('"folder"')
    expect(text).not.toContain('"outside"')
    expect(text).toContain('browser_tabs accepts: action, scope, url, tabId')
    const page = withUnknownArgsNote(
      def('browser_click'),
      { ref: 'e1', tab: 'tab_1', allow_foreign: true },
      { content: [{ type: 'text', text: 'Clicked.' }] }
    )
    expect(textOf(page)).toBe('Clicked.')
  })
})
