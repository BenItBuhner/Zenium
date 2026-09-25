import { describe, expect, it } from 'vitest'
import { createFolder, createSpace, emptyModel, folderTabs, type Model } from '../../model'
import { AGENTS_SPACE_ICON, AGENTS_SPACE_NAME, homeGroupName, legacyGroupOwner } from '../service'
import { fakeBrowser, textOf } from './fakeBrowser'

/**
 * The persisted mark on what agents make (S3 of the MCP program): every group an agent makes
 * and every space it makes carries `agent`, the shared Agents space is known by its mark and not
 * by its name, an agent's groups survive a restart as orphaned, adoptable groups wherever they
 * sit, the user's folders never become agents' by where they sit, and state written before the
 * marks existed is stamped once.
 */

function model(): Model {
  return emptyModel([{ id: 'default', name: 'Default', color: '#888' } as never])
}

describe('the mark on what agents make', () => {
  it("stamps the home group, the shared space, the agent's own spaces and its groups; the user's folders stay unmarked", async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const before = Date.now()
    await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    const agents = fake.service.findAgentsSpace()!
    expect(agents.name).toBe(AGENTS_SPACE_NAME)
    expect(agents.agent).toEqual({ kind: 'shared' })
    const home = fake.model.folders[A.homeGroupId!]
    expect(home.agent).toEqual({ name: 'A', createdAt: expect.any(Number) })
    expect(home.agent!.createdAt).toBeGreaterThanOrEqual(before)

    // A space of its own, and the group that opened it.
    const own = fake.createdGroup(
      await fake.call(A, 'zen_groups', { action: 'create', space: 'own', name: 'Reading' })
    )
    const ownFolder = fake.model.folders[own]
    const ownSpace = fake.model.spaces.find((sp) => sp.id === ownFolder.spaceId)!
    expect(ownSpace.name).toBe('A')
    expect(ownSpace.agent).toEqual({ kind: 'own', name: 'A', createdAt: expect.any(Number) })
    expect(ownFolder.agent).toEqual({ name: 'A', createdAt: expect.any(Number) })
    expect(fake.service.isAgentSpace(ownSpace.id)).toBe(true)

    // zen_spaces create marks the space the same way.
    const created = textOf(await fake.call(A, 'zen_spaces', { action: 'create', name: 'Lab' }))
    const lab = fake.model.spaces.find((sp) => sp.name === 'Lab')!
    expect(created).toContain(`Created space ${lab.id} "Lab"`)
    expect(lab.agent).toEqual({ kind: 'own', name: 'A', createdAt: expect.any(Number) })
    expect(fake.service.isAgentSpace(lab.id)).toBe(true)

    // A group in the user's space (allowForeign): the group is marked, the space is not.
    const foreign = fake.createdGroup(
      await fake.call(A, 'zen_groups', {
        action: 'create',
        space: fake.userSpace.id,
        allowForeign: true
      })
    )
    expect(fake.model.folders[foreign].agent).toEqual({ name: 'A', createdAt: expect.any(Number) })
    expect(fake.userSpace.agent).toBeUndefined()
    expect(fake.service.isAgentSpace(fake.userSpace.id)).toBe(false)

    // The user's folders carry no mark and are not agents' – not even one in the Agents space.
    const mine = createFolder(fake.model, fake.userSpace.id, 'Mine', '')
    const notes = createFolder(fake.model, agents.id, 'Notes', '')
    expect(mine.agent).toBeUndefined()
    expect(notes.agent).toBeUndefined()
    expect(fake.service.isOrphan(notes.id)).toBe(false)
    expect(fake.service.orphanWas(notes.id)).toBeNull()
    expect(
      fake.service
        .agentGroups()
        .map((g) => g.id)
        .sort()
    ).toEqual([home.id, own, foreign].sort())
    const all = textOf(await fake.call(A, 'zen_groups', { action: 'list', scope: 'all' }))
    expect(all).toContain('Agent groups (3):')
    expect(all).toContain("The user's folders (2; not yours to use):")
    expect(all).toContain(
      `Group "Notes" (${notes.id}) [the user's] in space "${AGENTS_SPACE_NAME}"`
    )
    expect(all).toContain(`Group "Mine" (${mine.id}) [the user's] in space "Work"`)
  })

  it("rename re-stamps the agent's live groups; adopt re-stamps with the adopter and keeps the group's createdAt", async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    const other = fake.createdGroup(
      await fake.call(A, 'zen_groups', { action: 'create', name: 'Sources' })
    )
    const home = fake.model.folders[A.homeGroupId!]
    const stamped = home.agent!.createdAt
    await fake.call(A, 'zen_session', { action: 'rename', name: 'Researcher' })
    expect(home.agent).toEqual({ name: 'Researcher', createdAt: stamped })
    expect(fake.model.folders[other].agent).toEqual({
      name: 'Researcher',
      createdAt: expect.any(Number)
    })
    expect(fake.service.orphanWas(home.id)).toBeNull() // not an orphan: A is live

    fake.service.close(A.id)
    expect(fake.service.isOrphan(home.id)).toBe(true)
    expect(fake.service.orphanWas(home.id)).toBe('Researcher')
    const B = await fake.connect('B')
    const adopted = textOf(await fake.call(B, 'zen_groups', { action: 'adopt', groupId: home.id }))
    expect(adopted).toContain(`(was "Researcher"'s)`)
    expect(home.agent).toEqual({ name: 'B', createdAt: stamped })
    expect(fake.service.isOrphan(home.id)).toBe(false)
    // The other orphaned group is still Researcher's, by its mark.
    expect(fake.service.isOrphan(other)).toBe(true)
    expect(fake.service.orphanWas(other)).toBe('Researcher')
  })
})

describe('a restart', () => {
  it("keeps an agent's groups its own wherever they sit: orphaned, listed with the maker, adoptable", async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    // The home group in the shared space, a group in a space of A's own, and one in the
    // user's space because the user asked.
    const homeTab = fake.openedTab(
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/home' })
    )
    const home = A.homeGroupId!
    const own = fake.createdGroup(
      await fake.call(A, 'zen_groups', { action: 'create', space: 'own', name: 'Reading' })
    )
    const ownTab = fake.openedTab(
      await fake.call(A, 'browser_tabs', {
        action: 'new',
        groupId: own,
        url: 'https://a.example/own'
      })
    )
    const foreign = fake.createdGroup(
      await fake.call(A, 'zen_groups', {
        action: 'create',
        space: fake.userSpace.id,
        name: 'For the user',
        allowForeign: true
      })
    )
    const foreignTab = fake.openedTab(
      await fake.call(A, 'browser_tabs', {
        action: 'new',
        groupId: foreign,
        url: 'https://a.example/foreign'
      })
    )
    const ownSpaceId = fake.model.folders[own].spaceId
    // The user's own folder, in their space, next to the agent's.
    const mine = createFolder(fake.model, fake.userSpace.id, 'Mine', '')

    const next = fake.restart()
    try {
      expect(next.model).not.toBe(fake.model)
      expect(next.service.list()).toEqual([])
      expect(next.commits).toBe(0) // nothing to upgrade: the marks were there
      // Nothing was touched by the boot: the marks are as they were written.
      expect(next.model.spaces.find((sp) => sp.id === ownSpaceId)?.agent).toEqual({
        kind: 'own',
        name: 'A',
        createdAt: expect.any(Number)
      })
      expect(next.model.folders[mine.id].agent).toBeUndefined()
      // Every group of A's is an orphan of A's, wherever it sits.
      for (const id of [home, own, foreign]) {
        expect(next.model.folders[id]).toBeDefined()
        expect(next.service.groupOwner(id)).toBeUndefined()
        expect(next.service.isOrphan(id)).toBe(true)
        expect(next.service.orphanWas(id)).toBe('A')
      }
      expect(next.service.isOrphan(mine.id)).toBe(false)
      expect(next.service.isAgentSpace(ownSpaceId)).toBe(true)
      expect(next.service.isAgentSpace(next.userSpace.id)).toBe(false)
      expect(next.service.findAgentsSpace()?.id).toBe(fake.service.findAgentsSpace()!.id)
      // The tabs kept their groups.
      expect(folderTabs(next.model, home).map((t) => t.id)).toEqual([homeTab])
      expect(folderTabs(next.model, own).map((t) => t.id)).toEqual([ownTab])
      expect(folderTabs(next.model, foreign).map((t) => t.id)).toEqual([foreignTab])

      const B = await next.connect('B')
      const groups = textOf(await next.call(B, 'zen_groups', { action: 'list', scope: 'all' }))
      expect(groups).toContain('Agent groups (3):')
      expect(groups).toContain(`Group "${homeGroupName(A)}" (${home}) [orphaned, was "A"]`)
      expect(groups).toContain(`Group "Reading" (${own}) [orphaned, was "A"] in space "A"`)
      expect(groups).toContain(
        `Group "For the user" (${foreign}) [orphaned, was "A"] in space "Work"`
      )
      expect(groups).toContain(`Group "Mine" (${mine.id}) [the user's] in space "Work"`)
      const tabs = textOf(await next.call(B, 'browser_tabs', { action: 'list', scope: 'all' }))
      for (const id of [homeTab, ownTab, foreignTab])
        expect(tabs).toMatch(new RegExp(`- ${id} .*\\[.*orphaned, was "A"`))
      expect(next.service.tabJson(B, next.model.tabs[foreignTab]).owner).toEqual({
        kind: 'orphaned',
        was: 'A'
      })
      // Orphaned tabs are refused without allowForeign and point at adopt…
      const refused = await next.call(B, 'browser_snapshot', { tabId: ownTab })
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toContain(`(was "A"'s)`)
      expect(textOf(refused)).toContain(`zen_groups {"action":"adopt","groupId":"${own}"}`)
      // …and adopting takes the group over, tabs and all, with the maker named.
      const adopted = textOf(await next.call(B, 'zen_groups', { action: 'adopt', groupId: own }))
      expect(adopted).toContain(`Adopted group ${own} "Reading" (was "A"'s) with 1 tab`)
      expect(B.groupIds.has(own)).toBe(true)
      expect(next.model.folders[own].agent).toEqual({ name: 'B', createdAt: expect.any(Number) })
      expect(next.service.isOrphan(own)).toBe(false)
      expect(textOf(await next.call(B, 'browser_snapshot', { tabId: ownTab }))).toContain(
        `- Tab: ${ownTab} (yours`
      )
      // The group in the user's space is adopted the same way; the user's folder never is.
      const byName = textOf(
        await next.call(B, 'zen_groups', { action: 'adopt', groupId: 'For the user' })
      )
      expect(byName).toContain(`Adopted group ${foreign} "For the user" (was "A"'s) with 1 tab`)
      const users = await next.call(B, 'zen_groups', { action: 'adopt', groupId: mine.id })
      expect(users.isError).toBe(true)
      expect(textOf(users)).toContain("is the user's folder, not an orphaned agent group")
    } finally {
      await next.stop()
    }
  })

  it('a second restart still knows the groups, the marks having travelled through the model whole', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    const home = A.homeGroupId!
    const once = fake.restart()
    const twice = once.restart()
    try {
      expect(twice.service.isOrphan(home)).toBe(true)
      expect(twice.service.orphanWas(home)).toBe('A')
      expect(twice.model.spaces.filter((sp) => sp.name === AGENTS_SPACE_NAME)).toHaveLength(1)
    } finally {
      await once.stop()
      await twice.stop()
    }
  })
})

describe('a space the user named Agents', () => {
  it("is theirs whatever its icon: not the shared space, its folders not agents', left alone across a restart", async () => {
    const m = model()
    const work = createSpace('Work', '')
    m.spaces.push(work)
    m.activeSpaceId = work.id
    const theirs = createSpace(AGENTS_SPACE_NAME, '')
    m.spaces.push(theirs)
    const reading = createFolder(m, theirs.id, 'Reading list', '')
    const fake = fakeBrowser({}, { model: m })
    fake.service.start()
    try {
      expect(theirs.agent).toBeUndefined()
      expect(reading.agent).toBeUndefined()
      expect(fake.service.findAgentsSpace()).toBeUndefined()
      expect(fake.service.isAgentSpace(theirs.id)).toBe(false)
      expect(fake.service.isOrphan(reading.id)).toBe(false)
      expect(fake.service.agentGroups()).toEqual([])

      const A = await fake.connect('A')
      // A group "in Agents" goes to the shared space, made now next to the user's namesake.
      await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
      const shared = fake.service.findAgentsSpace()!
      expect(shared.id).not.toBe(theirs.id)
      expect(shared.agent).toEqual({ kind: 'shared' })
      expect(shared.icon).toBe(AGENTS_SPACE_ICON)
      expect(fake.model.spaces.filter((sp) => sp.name === AGENTS_SPACE_NAME)).toHaveLength(2)
      expect(fake.model.folders[A.homeGroupId!].spaceId).toBe(shared.id)
      // The user's namesake is the user's: a group there is a foreign act.
      const refused = await fake.call(A, 'zen_groups', { action: 'create', space: theirs.id })
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toContain(
        `Space ${theirs.id} "${AGENTS_SPACE_NAME}" is the user's: a group there is a foreign act`
      )
      expect(theirs.agent).toBeUndefined()
      const all = textOf(await fake.call(A, 'zen_groups', { action: 'list', scope: 'all' }))
      expect(all).toContain(
        `Group "Reading list" (${reading.id}) [the user's] in space "${AGENTS_SPACE_NAME}"`
      )

      const next = fake.restart()
      try {
        const again = next.model.spaces.find((sp) => sp.id === theirs.id)!
        expect(again.agent).toBeUndefined()
        expect(next.model.folders[reading.id].agent).toBeUndefined()
        expect(next.service.isOrphan(reading.id)).toBe(false)
        expect(next.service.findAgentsSpace()?.id).toBe(shared.id)
      } finally {
        await next.stop()
      }
    } finally {
      await fake.stop()
    }
  })

  it('an unmarked one under another icon is never taken for S1 state, even without a marked space', () => {
    const m = model()
    const work = createSpace('Work', '')
    m.spaces.push(work)
    m.activeSpaceId = work.id
    const theirs = createSpace(AGENTS_SPACE_NAME, '')
    m.spaces.push(theirs)
    const folder = createFolder(m, theirs.id, 'A · 3f9a', '')
    const fake = fakeBrowser({}, { model: m })
    fake.service.start()
    expect(theirs.agent).toBeUndefined()
    expect(folder.agent).toBeUndefined()
    expect(fake.service.isOrphan(folder.id)).toBe(false)
    expect(fake.service.findAgentsSpace()).toBeUndefined()
    return fake.stop()
  })
})

describe('the one-time upgrade of S1 state', () => {
  /** What S1 left in `state.json`: the Agents space by construction, unmarked, with groups in it. */
  function s1(): {
    m: Model
    agents: ReturnType<typeof createSpace>
    home: ReturnType<typeof createFolder>
    second: ReturnType<typeof createFolder>
    named: ReturnType<typeof createFolder>
    mine: ReturnType<typeof createFolder>
  } {
    const m = model()
    const work = createSpace('Work', '')
    m.spaces.push(work)
    m.activeSpaceId = work.id
    const agents = createSpace(AGENTS_SPACE_NAME, AGENTS_SPACE_ICON)
    m.spaces.push(agents)
    const home = createFolder(m, agents.id, 'A · 3f9a', '')
    const second = createFolder(m, agents.id, 'B · 0c1d · 2', '')
    const named = createFolder(m, agents.id, 'Research', '')
    const mine = createFolder(m, work.id, 'Mine', '')
    return { m, agents, home, second, named, mine }
  }

  it('stamps the shared space and every group in it once, with the maker read off the group name', async () => {
    const { m, agents, home, second, named, mine } = s1()
    const fake = fakeBrowser({}, { model: m })
    fake.service.start()
    try {
      expect(agents.agent).toEqual({ kind: 'shared' })
      expect(home.agent).toEqual({ name: 'A', createdAt: expect.any(Number) })
      expect(second.agent).toEqual({ name: 'B', createdAt: expect.any(Number) })
      expect(named.agent).toEqual({ name: '', createdAt: expect.any(Number) })
      expect(mine.agent).toBeUndefined()
      expect(fake.commits).toBe(1) // persisted once, by the upgrade
      expect(fake.service.findAgentsSpace()).toBe(agents)
      for (const f of [home, second, named]) expect(fake.service.isOrphan(f.id)).toBe(true)
      expect(fake.service.orphanWas(home.id)).toBe('A')
      expect(fake.service.orphanWas(second.id)).toBe('B')
      expect(fake.service.orphanWas(named.id)).toBeNull()
      expect(fake.service.isOrphan(mine.id)).toBe(false)

      const C = await fake.connect('C')
      const all = textOf(await fake.call(C, 'zen_groups', { action: 'list', scope: 'all' }))
      expect(all).toContain(`Group "A · 3f9a" (${home.id}) [orphaned, was "A"]`)
      expect(all).toContain(`Group "B · 0c1d · 2" (${second.id}) [orphaned, was "B"]`)
      expect(all).toContain(`Group "Research" (${named.id}) [orphaned] in space`)
      expect(all).toContain(`Group "Mine" (${mine.id}) [the user's] in space "Work"`)
      // A group whose maker is unknown adopts without a former owner named.
      const adopted = textOf(
        await fake.call(C, 'zen_groups', { action: 'adopt', groupId: named.id })
      )
      expect(adopted).toContain(`Adopted group ${named.id} "Research" with 0 tabs`)
      expect(adopted).not.toContain('(was')
      expect(named.agent).toEqual({ name: 'C', createdAt: expect.any(Number) })
    } finally {
      await fake.stop()
    }
  })

  it('is idempotent: the next start finds nothing to do and changes nothing', async () => {
    const { m, agents, home, named } = s1()
    const fake = fakeBrowser({}, { model: m })
    fake.service.start()
    expect(fake.commits).toBe(1)
    const stamped = {
      space: { ...agents.agent },
      home: { ...home.agent },
      named: { ...named.agent }
    }
    // A user's folder made in the shared space after the upgrade is the user's.
    const later = createFolder(m, agents.id, 'Later', '')
    const next = fake.restart()
    try {
      expect(next.commits).toBe(0)
      expect(next.model.spaces.find((sp) => sp.id === agents.id)?.agent).toEqual(stamped.space)
      expect(next.model.folders[home.id].agent).toEqual(stamped.home)
      expect(next.model.folders[named.id].agent).toEqual(stamped.named)
      expect(next.model.folders[later.id].agent).toBeUndefined()
      expect(next.service.isOrphan(later.id)).toBe(false)
      expect(next.service.isOrphan(home.id)).toBe(true)
      expect(next.service.orphanWas(home.id)).toBe('A')
    } finally {
      await next.stop()
      await fake.stop()
    }
  })

  it('finds nothing to do on a fresh profile or once a shared space is marked', () => {
    const fresh = fakeBrowser()
    fresh.service.start()
    expect(fresh.commits).toBe(0)
    expect(fresh.model.spaces.map((sp) => sp.name)).toEqual(['Work'])
    // A marked shared space next to an unmarked namesake under the robot icon: the namesake
    // is left alone – there is nothing left to upgrade.
    const m = model()
    const work = createSpace('Work', '')
    m.spaces.push(work)
    m.activeSpaceId = work.id
    const shared = createSpace(AGENTS_SPACE_NAME, AGENTS_SPACE_ICON)
    shared.agent = { kind: 'shared' }
    const twin = createSpace(AGENTS_SPACE_NAME, AGENTS_SPACE_ICON)
    m.spaces.push(shared, twin)
    const inTwin = createFolder(m, twin.id, 'A · 3f9a', '')
    const fake = fakeBrowser({}, { model: m })
    fake.service.start()
    expect(fake.commits).toBe(0)
    expect(twin.agent).toBeUndefined()
    expect(inTwin.agent).toBeUndefined()
    expect(fake.service.isOrphan(inTwin.id)).toBe(false)
    expect(fake.service.findAgentsSpace()).toBe(shared)
    return Promise.all([fresh.stop(), fake.stop()])
  })

  it('legacyGroupOwner reads the agent off the two shapes S1 wrote and nothing else', () => {
    expect(legacyGroupOwner('A · 3f9a')).toBe('A')
    expect(legacyGroupOwner('Research bot · 0c1d · 2')).toBe('Research bot')
    expect(legacyGroupOwner('Claude Code · abcd · 12')).toBe('Claude Code')
    expect(legacyGroupOwner('Research')).toBe('')
    expect(legacyGroupOwner('A · 3f9')).toBe('')
    expect(legacyGroupOwner('A · zzzz')).toBe('')
    expect(legacyGroupOwner('A · 3f9a · x')).toBe('')
    expect(legacyGroupOwner('')).toBe('')
  })
})
