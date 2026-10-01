// The agents' space around a restore, the quit question's count and a session's end (W8-F2;
// guards #573 / W7-F3). Two launches, each from a profile seeded as the MCP soak leaves one:
// a user space with the boot fixture's page(s), the shared Agents space (persisted through its
// `agent` mark) with no tabs, and the window's `activeSpaceId` on that empty agents' space –
// a foreground session that closed its tabs and quit. The first launch seeds the window's
// `lastUserSpaceId` (`agent-space-restore`), the second leaves it out as a profile written
// before it would (`agent-space-session`). Every assertion reads state: the core's through the
// chrome's `app.getState` bridge, the quit question through its DOM, the profile through its
// `state.json` – never a log line.
//
//   agent-space-restore   restored-on-user-space  the window comes up on the user space with
//                                                  its page tab active; the agents' space is
//                                                  there, marked `shared`, and empty – nothing
//                                                  seeded a `zen://newtab` into it.
//                         quit                    one user tab: the quit chord quits without a
//                                                  question (`quitGracefully` asserts that).
//                         state-after-quit        `state.json`: `cleanExit: true`, the window on
//                                                  the user space, the agents' space still empty.
//   agent-space-session   restored-on-user-space  two user tabs; the same reads.
//                         server-up               the local MCP server's endpoint (`agent.json`).
//                         agent-tab-in-background zen_mode background + browser_tabs new: the
//                                                  agent's tab lands in the seeded Agents space;
//                                                  the window stays on the user space.
//                         quit-prompt-count       the quit chord asks "Quit Zenium?" for "2 tabs"
//                                                  – the agents' tab not counted – and Cancel
//                                                  leaves the app running.
//                         screen-taken            zen_mode foreground takeScreen + a snapshot
//                                                  bring the agent's tab in front: the window
//                                                  moves to the agents' space.
//                         session-end             zen_session end closeTabs: the space empties
//                                                  and the window goes back to the user space,
//                                                  its tabs untouched, no `zen://newtab` seeded.
//                         quit                    two user tabs: "Quit Zenium?" for "2 tabs",
//                                                  Quit, exit 0.
//                         state-after-quit        as above.
//
// The session's end is exercised over the local MCP server (the soak's `HttpClient`, the same
// HTTP path `scripts/mcp-soak.mjs` uses), not a test-only command. `warnBeforeQuitting: false`
// is seeded so that a Mac's chord asks the question like the other hosts' (with it on, the
// Mac's hold is the confirmation and asks nothing – `quitChordHolds`). The agents' default mode
// is seeded `background`, so only the explicit `takeScreen` brings the tab in front.

import fs from 'node:fs'
import path from 'node:path'
import { HttpClient, openedTab, waitForEndpoint } from '../../scripts/mcp-soak.mjs'
import { agentSettings, freePort } from './mcp-scenario.mjs'

export const AGENT_SPACE_SCENARIO = 'agent-space-restore'
export const AGENT_SPACE_SESSION_SCENARIO = 'agent-space-session'

/** The ids the seeded document uses; the assertions look the spaces up by them. */
export const SEED = Object.freeze({
  userSpaceId: 'space_smoke_user',
  userSpaceName: 'Smoke',
  agentsSpaceId: 'space_smoke_agents',
  agentsSpaceName: 'Agents',
  agentsSpaceIcon: '🤖',
  windowId: 'window_main',
  containerId: 'default'
})

/** The pages a fresh tab of the chrome's own opens on – what `ensureFirstTab` would have seeded. */
export const FRESH_TAB_URLS = Object.freeze(['zen://newtab', 'zen://blank'])

const SERVER_UP_MS = 60_000
const STATE_WAIT_MS = 20_000
const PROMPT_WAIT_MS = 15_000

/**
 * The `state.json` the soak leaves: `pages` (`{ url, title }`, the first one the space's active
 * tab) in one user space, the shared Agents space empty, the model's and the window's
 * `activeSpaceId` on the agents' space, `cleanExit: true` (the soak quit gracefully). With
 * `lastUserSpace` the window remembers the user space it left; without it the key is absent,
 * as a profile written before W7-F3 has it. `settings` go in whole (the harness's on top of the
 * scenario's; the state's sanitisers fill in the rest).
 */
export function seedDocument({ pages, lastUserSpace, settings }) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('seedDocument needs a page')
  const tabs = pages.map((page, i) => ({
    id: `tab_smoke_${i + 1}`,
    spaceId: SEED.userSpaceId,
    containerId: SEED.containerId,
    url: page.url,
    title: page.title
  }))
  const window = {
    id: SEED.windowId,
    bounds: null,
    maximized: false,
    activeSpaceId: SEED.agentsSpaceId,
    selection: {},
    compact: false
  }
  if (lastUserSpace) window.lastUserSpaceId = SEED.userSpaceId
  return {
    version: 6,
    spaces: [
      {
        id: SEED.userSpaceId,
        name: SEED.userSpaceName,
        icon: '',
        containerId: SEED.containerId,
        theme: null,
        tabIds: tabs.map((t) => t.id),
        activeTabId: tabs[0].id,
        pinnedCollapsed: false
      },
      {
        id: SEED.agentsSpaceId,
        name: SEED.agentsSpaceName,
        icon: SEED.agentsSpaceIcon,
        containerId: SEED.containerId,
        theme: null,
        tabIds: [],
        activeTabId: null,
        pinnedCollapsed: false,
        agent: { kind: 'shared' }
      }
    ],
    tabs,
    essentialTabIds: [],
    activeSpaceId: SEED.agentsSpaceId,
    containers: [],
    folders: [],
    splitGroups: [],
    settings,
    shortcutOverrides: {},
    windows: [window],
    cleanExit: true
  }
}

/** The tabs of `state` (a `UIState` or a `state.json` document) as a list, whichever shape holds them. */
export function tabList(state) {
  const tabs = state?.tabs
  if (Array.isArray(tabs)) return tabs.filter((t) => t && typeof t === 'object')
  if (tabs && typeof tabs === 'object') return Object.values(tabs)
  return []
}

/**
 * The restored window as the core reports it (`app.getState`: `activeSpaceId` is the window's):
 * on the user space, that space's active tab on `activeUrl`, `userTabs` tabs in it and none
 * anywhere else; the agents' space present, marked `shared` and empty; no fresh tab of the
 * chrome's own anywhere. Null when it all holds, else what does not.
 */
export function restoreVerdict(state, { activeUrl, userTabs }) {
  if (!state || !Array.isArray(state.spaces)) return 'no state'
  const user = state.spaces.find((s) => s.id === SEED.userSpaceId)
  const agents = state.spaces.find((s) => s.id === SEED.agentsSpaceId)
  if (!user) return `the user space ${SEED.userSpaceId} is gone: ${spaceNames(state)}`
  if (!agents) return `the agents' space ${SEED.agentsSpaceId} is gone: ${spaceNames(state)}`
  if (state.activeSpaceId !== SEED.userSpaceId)
    return `the window is on ${describeSpace(state, state.activeSpaceId)}, not the user space`
  if (agents.agent?.kind !== 'shared')
    return `the agents' space lost its mark: ${JSON.stringify(agents.agent ?? null)}`
  if (agents.tabIds.length !== 0)
    return `the agents' space has ${agents.tabIds.length} tab(s): ${urlsOf(state, agents.tabIds)}`
  const fresh = tabList(state).filter((t) => FRESH_TAB_URLS.some((u) => t.url?.startsWith(u)))
  if (fresh.length)
    return `a fresh tab was seeded: ${fresh.map((t) => `${t.id} ${t.url}`).join(', ')}`
  if (user.tabIds.length !== userTabs)
    return `the user space has ${user.tabIds.length} tab(s), not ${userTabs}: ${urlsOf(state, user.tabIds)}`
  const total = tabList(state).length
  if (total !== userTabs) return `${total} tabs in all, not ${userTabs}: ${urlsOf(state)}`
  const active = tabList(state).find((t) => t.id === user.activeTabId)
  if (!active) return `the user space's active tab ${user.activeTabId} is not a tab`
  if (!active.url?.startsWith(activeUrl))
    return `the user space's active tab is on ${active.url}, not ${activeUrl}`
  return null
}

/**
 * While an agent works: its one tab is in the agents' space (`agentTabId` when known), the
 * window on `windowOn`, the user space's `userTabs` tabs still there with `activeUrl` active.
 */
export function agentTabVerdict(state, { agentTabId, windowOn, activeUrl, userTabs }) {
  if (!state || !Array.isArray(state.spaces)) return 'no state'
  const user = state.spaces.find((s) => s.id === SEED.userSpaceId)
  const agents = state.spaces.find((s) => s.id === SEED.agentsSpaceId)
  if (!user || !agents) return `a seeded space is gone: ${spaceNames(state)}`
  if (agents.tabIds.length !== 1)
    return `the agents' space has ${agents.tabIds.length} tab(s), not the agent's one: ${urlsOf(state, agents.tabIds)}`
  if (agentTabId && agents.tabIds[0] !== agentTabId)
    return `the agents' space holds ${agents.tabIds[0]}, not the agent's tab ${agentTabId}`
  if (state.activeSpaceId !== windowOn)
    return `the window is on ${describeSpace(state, state.activeSpaceId)}, not ${describeSpace(state, windowOn)}`
  if (user.tabIds.length !== userTabs)
    return `the user space has ${user.tabIds.length} tab(s), not ${userTabs}: ${urlsOf(state, user.tabIds)}`
  const active = tabList(state).find((t) => t.id === user.activeTabId)
  if (!active?.url?.startsWith(activeUrl))
    return `the user space's active tab is on ${active?.url ?? null}, not ${activeUrl}`
  if (windowOn === SEED.agentsSpaceId && agents.activeTabId !== agents.tabIds[0])
    return `the agents' space shows ${agents.activeTabId}, not the agent's tab ${agents.tabIds[0]}`
  return null
}

/** The quit question for `tabs` open: "Quit Zenium?" naming that many tabs. Null when it does. */
export function promptVerdict(prompt, tabs) {
  if (!prompt) return 'no window prompt is up'
  if (prompt.kind !== 'quit') return `the prompt up is ${prompt.kind}, not the quit question`
  if (prompt.heading !== 'Quit Zenium?') return `the question reads "${prompt.heading}"`
  if (!prompt.text.includes(`${tabs} tabs`))
    return `the question counts differently from ${tabs} tabs: "${prompt.text}"`
  return null
}

/**
 * The profile after a graceful quit, from `state.json` itself: the marker set, one window and
 * it on the user space, the agents' space kept (with its mark) and empty, `userTabs` tabs in the
 * user space and no fresh tab anywhere. Null when it all holds.
 */
export function stateFileVerdict(doc, { userTabs }) {
  if (!doc || typeof doc !== 'object') return 'no state.json document'
  if (doc.cleanExit !== true) return `cleanExit is ${JSON.stringify(doc.cleanExit)}, not true`
  const windows = Array.isArray(doc.windows) ? doc.windows : []
  if (windows.length !== 1) return `${windows.length} windows remembered, not one`
  if (windows[0].activeSpaceId !== SEED.userSpaceId)
    return `the window was remembered on ${describeSpace(doc, windows[0].activeSpaceId)}, not the user space`
  const spaces = Array.isArray(doc.spaces) ? doc.spaces : []
  const agents = spaces.find((s) => s.id === SEED.agentsSpaceId)
  const user = spaces.find((s) => s.id === SEED.userSpaceId)
  if (!user) return `the user space is gone: ${spaceNames(doc)}`
  if (!agents) return `the agents' space is gone: ${spaceNames(doc)}`
  if (agents.agent?.kind !== 'shared')
    return `the agents' space lost its mark: ${JSON.stringify(agents.agent ?? null)}`
  if ((agents.tabIds ?? []).length !== 0)
    return `the agents' space was remembered with ${agents.tabIds.length} tab(s): ${urlsOf(doc, agents.tabIds)}`
  if ((user.tabIds ?? []).length !== userTabs)
    return `the user space was remembered with ${user.tabIds.length} tab(s), not ${userTabs}: ${urlsOf(doc, user.tabIds)}`
  const fresh = tabList(doc).filter((t) => FRESH_TAB_URLS.some((u) => t.url?.startsWith(u)))
  if (fresh.length) return `a fresh tab was remembered: ${fresh.map((t) => t.url).join(', ')}`
  return null
}

function spaceNames(state) {
  return (state?.spaces ?? []).map((s) => `${s.id} (${s.name})`).join(', ') || 'no spaces'
}

function describeSpace(state, id) {
  const space = (state?.spaces ?? []).find((s) => s.id === id)
  return space ? `${space.id} (${space.name})` : `${id} (no such space)`
}

function urlsOf(state, ids = null) {
  const tabs = tabList(state).filter((t) => !ids || ids.includes(t.id))
  return tabs.map((t) => `${t.id} ${t.url}`).join(', ') || 'none'
}

/** The seeded document written over the fresh profile's `state.json` (the harness settings kept). */
function seedProfile(freshProfile, name, { pages, lastUserSpace, settings }) {
  const userData = freshProfile(name, { onboardingDone: true, settings })
  const file = path.join(userData, 'zen', 'state.json')
  const fresh = JSON.parse(fs.readFileSync(file, 'utf8'))
  const doc = seedDocument({ pages, lastUserSpace, settings: fresh.settings })
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
  return userData
}

function readStateFile(userData) {
  return JSON.parse(fs.readFileSync(path.join(userData, 'zen', 'state.json'), 'utf8'))
}

/** A tool call that must not fail: its text when it went through, else the error named. */
async function must(client, name, args) {
  const r = await client.call(name, args)
  if (r.isError) throw new Error(`${name} ${JSON.stringify(args)} failed: ${r.text}`)
  return r
}

export async function scenarioAgentSpace(h) {
  const { freshProfile, runScenario, waitFor, log, fixture, quitCombo } = h
  const port = await freePort()
  log(`${AGENT_SPACE_SCENARIO}: the agents' server on port ${port}; pages ${fixture.origin}`)
  const settings = {
    warnBeforeQuitting: false,
    startup: { mode: 'continue', pages: [] },
    agents: { ...agentSettings(port), defaultMode: 'background' }
  }
  const settled = (s, expect, what) =>
    waitFor(
      async () => {
        const state = await s.appState()
        const problem = expect(state)
        return problem ? false : { state }
      },
      STATE_WAIT_MS,
      what
    ).catch(async (e) => {
      // The last reading's verdict names what is wrong, not only that the wait ran out.
      const state = await s.appState().catch(() => null)
      throw new Error(`${what}: ${expect(state) ?? e.message}`)
    })
  const restored = (s, activeUrl, userTabs) =>
    s.step(
      'restored-on-user-space',
      async () => {
        const { state } = await settled(
          s,
          (state) => restoreVerdict(state, { activeUrl, userTabs }),
          'the window restored on the user space'
        )
        return {
          windowOn: state.activeSpaceId,
          userTabs: state.spaces.find((sp) => sp.id === SEED.userSpaceId).tabIds,
          agentsTabs: state.spaces.find((sp) => sp.id === SEED.agentsSpaceId).tabIds,
          activeTab:
            state.tabs[state.spaces.find((sp) => sp.id === SEED.userSpaceId).activeTabId]?.url
        }
      },
      { fatal: true }
    )
  const stateAfterQuit = (s, userData, userTabs) =>
    s.step('state-after-quit', async () => {
      const doc = readStateFile(userData)
      const problem = stateFileVerdict(doc, { userTabs })
      if (problem) throw new Error(`state.json after the quit: ${problem}`)
      return {
        cleanExit: doc.cleanExit,
        windowOn: doc.windows[0].activeSpaceId,
        lastUserSpaceId: doc.windows[0].lastUserSpaceId ?? null,
        tabs: tabList(doc).map((t) => t.url)
      }
    })

  // Launch A: `lastUserSpaceId` set, one user tab – the chord quits without a question.
  const profileA = seedProfile(freshProfile, `profile-${AGENT_SPACE_SCENARIO}`, {
    pages: [fixture.first],
    lastUserSpace: true,
    settings
  })
  const first = await runScenario(AGENT_SPACE_SCENARIO, profileA, {}, async (s, out) => {
    out.seed = { lastUserSpaceId: 'set', userTabs: 1 }
    await restored(s, fixture.first.url, 1)
    await s.step('quit', () => s.quitGracefully())
    await stateAfterQuit(s, profileA, 1)
  })
  if (first.fatal) return first

  // Launch B: `lastUserSpaceId` absent, two user tabs, an agent's session over the MCP server.
  const profileB = seedProfile(freshProfile, `profile-${AGENT_SPACE_SESSION_SCENARIO}`, {
    pages: [fixture.first, fixture.second],
    lastUserSpace: false,
    settings
  })
  let client = null
  try {
    return await runScenario(AGENT_SPACE_SESSION_SCENARIO, profileB, {}, async (s, out) => {
      out.seed = { lastUserSpaceId: 'unset', userTabs: 2 }
      out.port = port
      await restored(s, fixture.first.url, 2)
      let endpoint = null
      // As the mcp scenario's: the wait gives up at SERVER_UP_MS naming its phase; the step's
      // guard sits past that so the wait's report, not a bare timeout, is what fails the step.
      await s.step(
        'server-up',
        async () => {
          endpoint = await waitForEndpoint(profileB, SERVER_UP_MS, {
            log: (line) => log(`${AGENT_SPACE_SESSION_SCENARIO}: ${line}`)
          })
          return { url: endpoint.url, port }
        },
        { fatal: true, timeoutMs: SERVER_UP_MS + 5_000 }
      )
      let agentTabId = null
      await s.step(
        'agent-tab-in-background',
        async () => {
          client = new HttpClient({ ...endpoint, name: 'smoke-agent-space', leg: 'agent-space' })
          await client.initialize()
          await must(client, 'zen_session', {
            action: 'start',
            name: 'Smoke agent space: background tab'
          })
          await must(client, 'zen_mode', { mode: 'background' })
          const opened = await must(client, 'browser_tabs', {
            action: 'new',
            url: fixture.handoff.url
          })
          agentTabId = openedTab(opened.text)
          if (!agentTabId) throw new Error(`browser_tabs new named no tab: ${opened.text}`)
          const { state } = await settled(
            s,
            (state) =>
              agentTabVerdict(state, {
                agentTabId,
                windowOn: SEED.userSpaceId,
                activeUrl: fixture.first.url,
                userTabs: 2
              }),
            "the agent's tab in the agents' space, the window on the user space"
          )
          return {
            agentTabId,
            agentTabUrl: state.tabs[agentTabId]?.url,
            windowOn: state.activeSpaceId
          }
        },
        { fatal: true }
      )
      await s.step('quit-prompt-count', async () => {
        const sidebar = await s.sidebarTabCount()
        await s.press(quitCombo)
        const prompt = s.chrome.locator('[data-window-prompt="quit"]').first()
        await prompt.waitFor({ state: 'visible', timeout: PROMPT_WAIT_MS })
        const asked = await s.windowPrompt()
        const problem = promptVerdict(asked, 2)
        if (problem) throw new Error(`with 2 user tabs and the agent's: ${problem}`)
        await prompt.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 5000 })
        await prompt.waitFor({ state: 'hidden', timeout: PROMPT_WAIT_MS })
        // Cancel left the app where it was: the state still answers, no prompt, nothing closed.
        const state = await s.appState()
        if (state.window?.prompt)
          throw new Error(`a prompt is still up: ${JSON.stringify(state.window.prompt)}`)
        const after = agentTabVerdict(state, {
          agentTabId,
          windowOn: SEED.userSpaceId,
          activeUrl: fixture.first.url,
          userTabs: 2
        })
        if (after) throw new Error(`after Cancel: ${after}`)
        return { sidebarTabs: sidebar, prompt: asked }
      })
      await s.step('screen-taken', async () => {
        await must(client, 'zen_mode', { mode: 'foreground', takeScreen: true })
        const snap = await must(client, 'browser_snapshot', { tabId: agentTabId })
        const { state } = await settled(
          s,
          (state) =>
            agentTabVerdict(state, {
              agentTabId,
              windowOn: SEED.agentsSpaceId,
              activeUrl: fixture.first.url,
              userTabs: 2
            }),
          "the window on the agents' space with the agent's tab in front"
        )
        return { windowOn: state.activeSpaceId, snapshot: snap.text.split('\n')[0] }
      })
      await s.step('session-end', async () => {
        const ended = await must(client, 'zen_session', { action: 'end', closeTabs: true })
        const { state } = await settled(
          s,
          (state) => restoreVerdict(state, { activeUrl: fixture.first.url, userTabs: 2 }),
          "the window back on the user space, the agents' space empty"
        )
        const closed = await client.close().catch((e) => ({ error: String(e?.message ?? e) }))
        client = null
        return {
          ended: ended.text.split('\n')[0],
          windowOn: state.activeSpaceId,
          agentsTabs: state.spaces.find((sp) => sp.id === SEED.agentsSpaceId).tabIds,
          closed
        }
      })
      await s.step('quit', () => s.quitGracefully())
      await stateAfterQuit(s, profileB, 2)
    })
  } finally {
    // A step that failed mid-session leaves the client open: the DELETE ends the session so the
    // quit (or the force-close) finds nothing held. The fixture's server is the harness's.
    if (client) await client.close().catch(() => undefined)
  }
}
