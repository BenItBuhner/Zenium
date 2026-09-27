import { describe, expect, it } from 'vitest'
import {
  FRESH_TAB_URLS,
  SEED,
  agentTabVerdict,
  promptVerdict,
  restoreVerdict,
  seedDocument,
  stateFileVerdict,
  tabList
} from './agent-space-scenario.mjs'

const first = { url: 'http://127.0.0.1:4321/first.html', title: 'Smoke fixture: first page' }
const second = { url: 'http://127.0.0.1:4321/second.html', title: 'Smoke fixture: second page' }
const settings = { shortcutPreset: 'chrome', warnBeforeQuitting: false }

/** The state the chrome's bridge reports for a restored window (`tabs` a record), from a seed. */
function restoredState(doc, changes = {}) {
  const spaces = doc.spaces.map((s) => ({ ...s, tabIds: [...s.tabIds] }))
  return {
    activeSpaceId: SEED.userSpaceId,
    spaces,
    tabs: Object.fromEntries(doc.tabs.map((t) => [t.id, { ...t }])),
    window: { prompt: null },
    ...changes
  }
}

/** The state with an agent's tab in the agents' space, the window on `windowOn`. */
function agentState(doc, windowOn, agentTabId = 'tab_agent_1') {
  const state = restoredState(doc, { activeSpaceId: windowOn })
  const agents = state.spaces.find((s) => s.id === SEED.agentsSpaceId)
  agents.tabIds = [agentTabId]
  agents.activeTabId = agentTabId
  state.tabs[agentTabId] = {
    id: agentTabId,
    spaceId: SEED.agentsSpaceId,
    url: 'http://127.0.0.1:4321/handoff.html'
  }
  return state
}

describe('seedDocument', () => {
  const doc = seedDocument({ pages: [first, second], lastUserSpace: true, settings })

  it('is the current version with the settings handed in, cleanly exited', () => {
    expect(doc.version).toBe(6)
    expect(doc.settings).toBe(settings)
    expect(doc.cleanExit).toBe(true)
    expect(doc.containers).toEqual([])
    expect(doc.essentialTabIds).toEqual([])
  })

  it('puts every page in the user space, the first one active, and leaves the agents space empty and marked', () => {
    const [user, agents] = doc.spaces
    expect(user.id).toBe(SEED.userSpaceId)
    expect(user.tabIds).toEqual(['tab_smoke_1', 'tab_smoke_2'])
    expect(user.activeTabId).toBe('tab_smoke_1')
    expect(user.agent).toBeUndefined()
    expect(agents.id).toBe(SEED.agentsSpaceId)
    expect(agents.agent).toEqual({ kind: 'shared' })
    expect(agents.tabIds).toEqual([])
    expect(agents.activeTabId).toBeNull()
    expect(doc.tabs.map((t) => [t.spaceId, t.url, t.title])).toEqual([
      [SEED.userSpaceId, first.url, first.title],
      [SEED.userSpaceId, second.url, second.title]
    ])
  })

  it("leaves the model and the one window standing on the agents' space, as the soak did", () => {
    expect(doc.activeSpaceId).toBe(SEED.agentsSpaceId)
    expect(doc.windows).toHaveLength(1)
    expect(doc.windows[0].id).toBe(SEED.windowId)
    expect(doc.windows[0].activeSpaceId).toBe(SEED.agentsSpaceId)
    expect(doc.windows[0].selection).toEqual({})
  })

  it('remembers the user space the window left in the one variant and has no such key in the other', () => {
    expect(doc.windows[0].lastUserSpaceId).toBe(SEED.userSpaceId)
    const before = seedDocument({ pages: [first], lastUserSpace: false, settings })
    expect('lastUserSpaceId' in before.windows[0]).toBe(false)
  })

  it('refuses to seed without a page', () => {
    expect(() => seedDocument({ pages: [], lastUserSpace: true, settings })).toThrow(/needs a page/)
  })
})

describe('tabList', () => {
  it('reads the record the bridge reports and the list the file holds alike', () => {
    const doc = seedDocument({ pages: [first], lastUserSpace: true, settings })
    expect(tabList(doc).map((t) => t.id)).toEqual(['tab_smoke_1'])
    expect(tabList(restoredState(doc)).map((t) => t.id)).toEqual(['tab_smoke_1'])
    expect(tabList(null)).toEqual([])
    expect(tabList({ tabs: 3 })).toEqual([])
  })
})

describe('restoreVerdict', () => {
  const doc = seedDocument({ pages: [first, second], lastUserSpace: false, settings })
  const want = { activeUrl: first.url, userTabs: 2 }

  it('accepts the window on the user space with its page active and the agents space empty', () => {
    expect(restoreVerdict(restoredState(doc), want)).toBeNull()
  })

  it('names a window left on the agents space', () => {
    expect(restoreVerdict(restoredState(doc, { activeSpaceId: SEED.agentsSpaceId }), want)).toMatch(
      /the window is on space_smoke_agents \(Agents\), not the user space/
    )
  })

  it('names a fresh tab seeded into the agents space – what ensureFirstTab must not do', () => {
    for (const url of FRESH_TAB_URLS) {
      const state = restoredState(doc)
      const agents = state.spaces.find((s) => s.id === SEED.agentsSpaceId)
      agents.tabIds = ['tab_fresh']
      state.tabs.tab_fresh = { id: 'tab_fresh', spaceId: SEED.agentsSpaceId, url }
      expect(restoreVerdict(state, want)).toMatch(
        /the agents' space has 1 tab\(s\): tab_fresh zen:\/\//
      )
    }
  })

  it('names a fresh tab anywhere, a lost mark, a lost space, a different active tab and a different count', () => {
    let state = restoredState(doc)
    state.tabs.tab_fresh = { id: 'tab_fresh', spaceId: null, url: 'zen://newtab' }
    expect(restoreVerdict(state, want)).toMatch(/a fresh tab was seeded: tab_fresh zen:\/\/newtab/)

    state = restoredState(doc)
    state.spaces.find((s) => s.id === SEED.agentsSpaceId).agent = null
    expect(restoreVerdict(state, want)).toMatch(/lost its mark: null/)

    state = restoredState(doc)
    state.spaces = state.spaces.filter((s) => s.id !== SEED.agentsSpaceId)
    expect(restoreVerdict(state, want)).toMatch(/the agents' space space_smoke_agents is gone/)

    state = restoredState(doc)
    state.spaces.find((s) => s.id === SEED.userSpaceId).activeTabId = 'tab_smoke_2'
    expect(restoreVerdict(state, want)).toMatch(
      /active tab is on .*second\.html, not .*first\.html/
    )

    expect(restoreVerdict(restoredState(doc), { ...want, userTabs: 1 })).toMatch(
      /the user space has 2 tab\(s\), not 1/
    )
    expect(restoreVerdict(null, want)).toBe('no state')
  })
})

describe('agentTabVerdict', () => {
  const doc = seedDocument({ pages: [first, second], lastUserSpace: false, settings })
  const base = { agentTabId: 'tab_agent_1', activeUrl: first.url, userTabs: 2 }

  it('accepts the agent working in the background: its tab in the agents space, the window on the user space', () => {
    expect(
      agentTabVerdict(agentState(doc, SEED.userSpaceId), { ...base, windowOn: SEED.userSpaceId })
    ).toBeNull()
  })

  it('accepts the screen taken: the window on the agents space showing the agent tab', () => {
    expect(
      agentTabVerdict(agentState(doc, SEED.agentsSpaceId), {
        ...base,
        windowOn: SEED.agentsSpaceId
      })
    ).toBeNull()
  })

  it('names the window on the wrong space, a different tab, and an agents space not showing the agent tab', () => {
    expect(
      agentTabVerdict(agentState(doc, SEED.agentsSpaceId), { ...base, windowOn: SEED.userSpaceId })
    ).toMatch(/the window is on space_smoke_agents \(Agents\), not space_smoke_user \(Smoke\)/)
    expect(
      agentTabVerdict(agentState(doc, SEED.userSpaceId, 'tab_other'), {
        ...base,
        windowOn: SEED.userSpaceId
      })
    ).toMatch(/holds tab_other, not the agent's tab tab_agent_1/)
    const state = agentState(doc, SEED.agentsSpaceId)
    state.spaces.find((s) => s.id === SEED.agentsSpaceId).activeTabId = null
    expect(agentTabVerdict(state, { ...base, windowOn: SEED.agentsSpaceId })).toMatch(
      /the agents' space shows null, not the agent's tab tab_agent_1/
    )
    expect(agentTabVerdict(restoredState(doc), { ...base, windowOn: SEED.userSpaceId })).toMatch(
      /the agents' space has 0 tab\(s\), not the agent's one/
    )
  })
})

describe('promptVerdict', () => {
  const asked = {
    kind: 'quit',
    heading: 'Quit Zenium?',
    text: 'Quit Zenium? 2 tabs will close Cancel Quit'
  }

  it('accepts the quit question that counts the tabs asked for', () => {
    expect(promptVerdict(asked, 2)).toBeNull()
  })

  it('names no prompt, another prompt, another heading and another count', () => {
    expect(promptVerdict(null, 2)).toBe('no window prompt is up')
    expect(promptVerdict({ ...asked, kind: 'downloads' }, 2)).toMatch(
      /is downloads, not the quit question/
    )
    expect(promptVerdict({ ...asked, heading: 'Close window?' }, 2)).toMatch(
      /reads "Close window\?"/
    )
    expect(promptVerdict(asked, 3)).toMatch(/counts differently from 3 tabs: "Quit Zenium\? 2 tabs/)
  })
})

describe('stateFileVerdict', () => {
  /** The file a graceful quit writes after the restore moved the window: on the user space, marked. */
  function afterQuit(doc, changes = {}) {
    return {
      ...structuredClone(doc),
      windows: [{ ...doc.windows[0], activeSpaceId: SEED.userSpaceId, lastUserSpaceId: null }],
      cleanExit: true,
      ...changes
    }
  }
  const doc = seedDocument({ pages: [first], lastUserSpace: true, settings })

  it('accepts the marker, one window on the user space, the agents space kept empty', () => {
    expect(stateFileVerdict(afterQuit(doc), { userTabs: 1 })).toBeNull()
  })

  it('names a missing marker, a window remembered on the agents space, a lost mark and a fresh tab', () => {
    expect(stateFileVerdict(afterQuit(doc, { cleanExit: false }), { userTabs: 1 })).toMatch(
      /cleanExit is false, not true/
    )
    expect(stateFileVerdict(afterQuit(doc, { cleanExit: undefined }), { userTabs: 1 })).toMatch(
      /cleanExit is undefined, not true/
    )
    expect(stateFileVerdict(doc, { userTabs: 1 })).toMatch(
      /remembered on space_smoke_agents \(Agents\), not the user space/
    )
    const unmarked = afterQuit(doc)
    unmarked.spaces[1].agent = undefined
    expect(stateFileVerdict(unmarked, { userTabs: 1 })).toMatch(/lost its mark: null/)
    const seeded = afterQuit(doc)
    seeded.spaces[1].tabIds = ['tab_fresh']
    seeded.tabs.push({ id: 'tab_fresh', spaceId: SEED.agentsSpaceId, url: 'zen://newtab' })
    expect(stateFileVerdict(seeded, { userTabs: 1 })).toMatch(
      /remembered with 1 tab\(s\): tab_fresh zen:\/\/newtab/
    )
    expect(stateFileVerdict(afterQuit(doc, { windows: [] }), { userTabs: 1 })).toMatch(
      /0 windows remembered, not one/
    )
    expect(stateFileVerdict(null, { userTabs: 1 })).toBe('no state.json document')
  })
})
