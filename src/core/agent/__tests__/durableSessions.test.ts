import { afterEach, describe, expect, it } from 'vitest'
import type { AgentDialogAnswer, AgentDialogRuleScope, AgentSettings } from '../../../shared/types'
import { PageDialogService } from '../../pageDialogs'
import type { ZenWindow } from '../../window'
import { AgentService, type AgentSession } from '../service'
import { CLAIMS_FILE } from '../claims'
import { AGENT_TOOLS } from '../tools'
import { fakeBrowser, textOf, type FakeBrowser, type FakeBrowserOptions } from './fakeBrowser'

/** The client name a harness introduces itself with – shared by every agent it runs. */
const CLIENT = 'cursor-vscode'

const live: FakeBrowser[] = []
afterEach(async () => {
  for (const f of live.splice(0)) await f.stop()
})

function browser(
  options: FakeBrowserOptions = {},
  settings: Partial<AgentSettings> = {}
): FakeBrowser {
  const fake = fakeBrowser(settings, { requireName: true, ...options })
  live.push(fake)
  return fake
}

function keyOf(text: string): string {
  const m = /zk_[0-9a-f]+/.exec(text)
  if (!m) throw new Error(`no session key in: ${text}`)
  return m[0]
}

/** An agent of `CLIENT` that connected and named itself; its key from the answer. */
async function named(
  fake: FakeBrowser,
  name: string,
  mode: 'foreground' | 'background' = 'background'
): Promise<{ s: AgentSession; key: string }> {
  const s = await fake.connect(CLIENT, { mode })
  const res = await fake.call(s, 'zen_session', { action: 'start', name })
  expect(res.isError, textOf(res)).toBeFalsy()
  return { s, key: keyOf(textOf(res)) }
}

/** A fresh transport session of the same client: what a reconnect or a restarted shim makes. */
async function reconnect(
  fake: FakeBrowser,
  mode: 'foreground' | 'background' = 'background'
): Promise<AgentSession> {
  return fake.connect(CLIENT, { mode })
}

async function openTab(fake: FakeBrowser, s: AgentSession, url: string): Promise<string> {
  return fake.openedTab(await fake.call(s, 'browser_tabs', { action: 'new', url }))
}

const sweep = (fake: FakeBrowser): void => (fake.service as unknown as { sweep(): void }).sweep()

const settle = <T>(p: Promise<T>, ms: number): Promise<T | 'HUNG'> =>
  Promise.race([p, new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), ms))])

describe('an agent names itself before it acts', () => {
  it('refuses every tool but zen_status and zen_session until the session is started', async () => {
    const fake = browser()
    const s = await fake.connect(CLIENT)
    const refused = await fake.call(s, 'browser_tabs', { action: 'new', url: 'https://a.test' })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('Start your session first')
    expect(textOf(await fake.call(s, 'zen_status'))).toContain(
      'You have not started your session yet'
    )
    expect(Object.keys(fake.model.tabs)).toHaveLength(0)
  })

  it('refuses generic names and the client name, and says what a good name looks like', async () => {
    const fake = browser()
    const s = await fake.connect(CLIENT)
    for (const name of ['Agent', 'Claude', CLIENT, 'Cursor agent 2', '']) {
      const res = await fake.call(s, 'zen_session', { action: 'start', name })
      expect(res.isError, name).toBe(true)
      expect(textOf(res), name).toContain('Invoice reconciliation')
    }
    expect(fake.service.claimOf(s)).toBeUndefined()
  })

  it('a descriptive name starts a durable session: the key is given once, the name shows everywhere', async () => {
    const fake = browser()
    const { s, key } = await named(fake, 'Invoice reconciliation')
    expect(s.name).toBe('Invoice reconciliation')
    expect(key).toMatch(/^zk_[0-9a-f]{48}$/)
    const tab = await openTab(fake, s, 'https://billing.test')
    const group = fake.model.folders[fake.model.tabs[tab].folderId!]
    expect(group.agent?.name).toBe('Invoice reconciliation')
    const status = textOf(await fake.call(s, 'zen_status'))
    expect(status).toContain('Your session "Invoice reconciliation" is durable')
    expect(status).toContain(key)
    // The key lives in the profile's claims file, never in the synced model.
    expect(JSON.stringify(fake.model)).not.toContain(key)
    await fake.service.flushClaims()
    expect(fake.files.get(CLAIMS_FILE)).toContain(key)
  })

  it('two agents cannot go by the same name, and a rename follows the same rules', async () => {
    const fake = browser()
    const { s: a } = await named(fake, 'Price watch')
    const b = await fake.connect(CLIENT)
    const dup = await fake.call(b, 'zen_session', { action: 'start', name: 'price WATCH' })
    expect(dup.isError).toBe(true)
    expect(textOf(dup)).toContain('another agent already goes by')
    expect(
      textOf(await fake.call(a, 'zen_session', { action: 'rename', name: 'Claude' }))
    ).toContain('Refused')
    const ok = await fake.call(a, 'zen_session', { action: 'rename', name: 'Price watch: shoes' })
    expect(ok.isError).toBeFalsy()
    expect(fake.service.claimOf(a)?.name).toBe('Price watch: shoes')
  })
})

describe('a named agent owns its groups until it ends its session', () => {
  it('a dropped connection keeps the groups: no other agent can adopt, force or address them', async () => {
    const fake = browser()
    const { s: a, key } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    const home = a.homeGroupId!
    fake.service.close(a.id)

    const { s: b } = await named(fake, 'Flight search Lisbon')
    expect(fake.service.isOrphan(home)).toBe(false)
    expect(fake.service.heldBy(home)?.name).toBe('Invoice reconciliation')
    for (const args of [
      { action: 'adopt', groupId: home },
      { action: 'adopt', groupId: home, force: true },
      { action: 'adopt' }
    ]) {
      const res = await fake.call(b, 'zen_groups', args)
      expect(res.isError, JSON.stringify(args)).toBe(true)
    }
    const forced = await fake.call(b, 'zen_groups', { action: 'adopt', groupId: home, force: true })
    expect(textOf(forced)).toContain('no other agent can adopt or force it')
    const foreign = await fake.call(b, 'browser_snapshot', { tabId: tab, allowForeign: true })
    expect(foreign.isError).toBe(true)
    expect(textOf(foreign)).toContain('is away and keeps its groups')
    const closeIt = await fake.call(b, 'browser_tabs', {
      action: 'close',
      tabId: tab,
      allowForeign: true
    })
    expect(closeIt.isError).toBe(true)
    expect(fake.model.tabs[tab]).toBeDefined()
    expect(textOf(await fake.call(b, 'zen_groups', { action: 'list', scope: 'all' }))).toContain(
      'owned by "Invoice reconciliation", away – kept for it'
    )

    // The agent comes back on a new connection with its key: everything is where it was.
    const a2 = await reconnect(fake)
    const res = await fake.call(a2, 'zen_session', { action: 'resume', key })
    expect(textOf(res)).toContain('Resumed your session "Invoice reconciliation"')
    expect(a2.name).toBe('Invoice reconciliation')
    expect(a2.homeGroupId).toBe(home)
    expect(fake.service.ownedTabs(a2).map((t) => t.id)).toEqual([tab])
    expect((await fake.call(a2, 'browser_snapshot', { tabId: tab })).isError).toBeFalsy()
  })

  it('a named agent that goes quiet is never a ghost, connected or not', async () => {
    const fake = browser()
    const { s: a } = await named(fake, 'Invoice reconciliation')
    await openTab(fake, a, 'https://billing.test')
    a.lastActiveAt = Date.now() - 6 * 60 * 60 * 1000
    expect(fake.service.isGhost(a)).toBe(false)
    const { s: b } = await named(fake, 'Flight search Lisbon')
    const res = await fake.call(b, 'zen_groups', {
      action: 'adopt',
      groupId: a.homeGroupId,
      force: true
    })
    expect(res.isError).toBe(true)
    expect(fake.service.groupOwner(a.homeGroupId!)).toBe(a)
  })

  it('idling into the park and out of it costs nothing; the parked limit only lets go of the connection', async () => {
    const fake = browser()
    const { s: a, key } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    const home = a.homeGroupId!
    a.lastActiveAt = Date.now() - 31 * 60 * 1000
    sweep(fake)
    expect(a.parked).toBe(true)
    expect(fake.service.isOrphan(home)).toBe(false)
    fake.service.touch(a)
    expect(a.parked).toBe(false)
    expect(fake.service.ownedTabs(a).map((t) => t.id)).toEqual([tab])

    a.lastActiveAt = Date.now() - 31 * 60 * 1000
    sweep(fake)
    a.lastActiveAt = Date.now() - 25 * 60 * 60 * 1000
    sweep(fake)
    expect(fake.service.get(a.id)).toBeUndefined()
    expect(fake.service.heldBy(home)?.name).toBe('Invoice reconciliation')
    const a2 = await reconnect(fake)
    await fake.call(a2, 'zen_session', { action: 'resume', key })
    expect(fake.service.ownedTabs(a2).map((t) => t.id)).toEqual([tab])
  })

  it('survives a browser restart: the same session id is re-bound by itself, or the key brings it back', async () => {
    const fake = browser()
    const { s: a, key } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    const { s: c, key: cKey } = await named(fake, 'PR 741 review')
    const cTab = await openTab(fake, c, 'https://github.test/pr/741')
    await fake.service.flushClaims()

    const next = fake.restart()
    live.push(next)
    const init = {
      transport: 'http' as const,
      token: next.service.serverStatus().token,
      remoteAddress: '127.0.0.1',
      userAgent: 'test'
    }
    // The client keeps sending its old session id (with the token): it is resurrected and bound.
    const a2 = next.service.resurrect(a.id, init, null)!
    expect(a2.name).toBe('Invoice reconciliation')
    expect(next.service.ownedTabs(a2).map((t) => t.id)).toEqual([tab])
    expect(textOf(await next.call(a2, 'zen_status'))).toContain(
      'Your session "Invoice reconciliation" is back with its groups and tabs'
    )
    // A client that initialized afresh resumes with its key.
    const c2 = await next.connect(CLIENT)
    expect(next.service.heldBy(next.model.tabs[cTab].folderId!)?.name).toBe('PR 741 review')
    await next.call(c2, 'zen_session', { action: 'resume', key: cKey })
    expect(next.service.ownedTabs(c2).map((t) => t.id)).toEqual([cTab])
    void key
  })

  it("the stdio relay's renewal carries the session over by naming the lost id – with the token only", async () => {
    const fake = browser()
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    const lost = a.id
    fake.service.close(lost)

    const stranger = fake.service.create({
      transport: 'http',
      token: null,
      remoteAddress: '127.0.0.1',
      userAgent: 'zenium-mcp-stdio',
      resumeFrom: lost
    })
    stranger.approved = true
    await fake.service.onInitialize(stranger, { name: CLIENT, version: '1' })
    expect(fake.service.claimOf(stranger)).toBeUndefined()

    const renewed = fake.service.create({
      transport: 'http',
      token: fake.service.serverStatus().token,
      remoteAddress: '127.0.0.1',
      userAgent: 'zenium-mcp-stdio',
      resumeFrom: lost
    })
    await fake.service.onInitialize(renewed, { name: CLIENT, version: '1' })
    expect(renewed.name).toBe('Invoice reconciliation')
    expect(fake.service.ownedTabs(renewed).map((t) => t.id)).toEqual([tab])
    expect(textOf(await fake.call(renewed, 'zen_status'))).toContain('your connection was renewed')
  })

  it('resuming on a second connection takes the session from the stale one, which is told', async () => {
    const fake = browser()
    const { s: a, key } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    const a2 = await reconnect(fake)
    await fake.call(a2, 'zen_session', { action: 'resume', key })
    expect(fake.service.ownedTabs(a2).map((t) => t.id)).toEqual([tab])
    expect(fake.service.ownedTabs(a)).toEqual([])
    const stale = await fake.call(a, 'zen_status')
    expect(textOf(stale)).toContain('resumed on another connection with its key')
    expect((await fake.call(a, 'browser_snapshot', { tabId: tab })).isError).toBe(true)
  })

  it('only the agent ends it: end orphans or closes the groups and the key stops working', async () => {
    const fake = browser()
    const { s: a, key } = await named(fake, 'Invoice reconciliation')
    await openTab(fake, a, 'https://billing.test')
    const home = a.homeGroupId!
    await fake.call(a, 'zen_session', { action: 'end' })
    expect(fake.service.claimOf(a)).toBeUndefined()
    expect(fake.service.isOrphan(home)).toBe(true)
    const again = await fake.call(a, 'zen_session', { action: 'resume', key })
    expect(again.isError).toBe(true)
    const { s: b } = await named(fake, 'Invoice follow-up')
    expect(
      (await fake.call(b, 'zen_groups', { action: 'adopt', groupId: home })).isError
    ).toBeFalsy()
  })

  it("the user's word releases a session: Disconnect, or releasing an away agent's claim", async () => {
    const fake = browser()
    const { s: a } = await named(fake, 'Invoice reconciliation')
    await openTab(fake, a, 'https://billing.test')
    const aHome = a.homeGroupId!
    fake.service.disconnect(a.id)
    expect(fake.service.isOrphan(aHome)).toBe(true)

    const { s: b } = await named(fake, 'PR 741 review')
    await openTab(fake, b, 'https://github.test')
    const bHome = b.homeGroupId!
    const claim = fake.service.claimOf(b)!
    fake.service.close(b.id)
    expect(fake.service.heldBy(bHome)).toBeDefined()
    fake.service.releaseClaim(claim.id)
    expect(fake.service.isOrphan(bHome)).toBe(true)
  })

  it('the user sees away agents with their groups and can release them, never a connected one', async () => {
    const fake = browser()
    const { s: a, key } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    const home = a.homeGroupId!
    const claim = fake.service.claimOf(a)!
    expect(fake.service.away()).toEqual([])
    fake.service.releaseAway(claim.id)
    expect(fake.service.claimOf(a)).toBeDefined()
    expect(fake.service.isOrphan(home)).toBe(false)

    fake.service.close(a.id)
    const [away, ...rest] = fake.service.away()
    expect(rest).toEqual([])
    expect(away).toMatchObject({
      claimId: claim.id,
      name: 'Invoice reconciliation',
      groupIds: [home],
      tabIds: [tab]
    })
    expect(away!.lastSeenAt).toBeGreaterThan(0)

    fake.service.releaseAway(claim.id)
    expect(fake.service.away()).toEqual([])
    expect(fake.service.isOrphan(home)).toBe(true)
    expect(fake.model.tabs[tab]).toBeDefined()
    const a2 = await reconnect(fake)
    expect((await fake.call(a2, 'zen_session', { action: 'resume', key })).isError).toBe(true)
    fake.service.releaseAway(claim.id)
  })

  it('what the user does around the agent never changes what it owns', async () => {
    const fake = browser()
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const t1 = await openTab(fake, a, 'https://billing.test/1')
    const t2 = await openTab(fake, a, 'https://billing.test/2')
    const home = a.homeGroupId!
    // The user browses: opens, activates (even the agent's tab), switches spaces, closes their own.
    const mine = fake.user.openTab('https://news.test')
    fake.user.activate(t1)
    fake.user.activate(mine.id)
    fake.browser.tabs.switchSpace(fake.userSpace.id)
    fake.user.closeTab(mine.id)
    expect(fake.service.groupOwner(home)).toBe(a)
    expect(fake.service.ownedTabs(a).map((t) => t.id)).toEqual([t1, t2])
    // The user closes one of the agent's tabs: the agent is told and keeps the rest.
    fake.user.closeTab(t2)
    const res = await fake.call(a, 'zen_status')
    expect(textOf(res)).toContain(t2)
    expect(fake.service.ownedTabs(a).map((t) => t.id)).toEqual([t1])
    // The user deletes the whole group: the claim forgets it rather than holding a ghost.
    fake.user.deleteFolder(home, false)
    await fake.call(a, 'zen_status')
    expect(fake.service.claimOf(a)?.groupIds).toEqual([])
  })

  it('a claim with no groups and no client for a week is forgotten; one with groups is kept', async () => {
    const fake = browser()
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const { s: b } = await named(fake, 'PR 741 review')
    await openTab(fake, b, 'https://github.test')
    const aClaim = fake.service.claimOf(a)!
    const bClaim = fake.service.claimOf(b)!
    fake.service.close(a.id)
    fake.service.close(b.id)
    aClaim.lastSeenAt = Date.now() - 8 * 24 * 60 * 60 * 1000
    bClaim.lastSeenAt = Date.now() - 8 * 24 * 60 * 60 * 1000
    sweep(fake)
    expect(fake.service.claimOf({ claimId: aClaim.id } as AgentSession)).toBeUndefined()
    expect(fake.service.claimOf({ claimId: bClaim.id } as AgentSession)).toBeDefined()
  })
})

describe('every call is bounded', () => {
  it('a page that stops answering costs one call, not the session', async () => {
    const fake = browser()
    fake.service.callDeadlineMs = 150
    fake.service.pageProbeMs = 50
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    fake.hold(tab)
    const stuck = await settle(fake.call(a, 'browser_snapshot', { tabId: tab }), 2000)
    expect(stuck).not.toBe('HUNG')
    if (stuck === 'HUNG') return
    expect(stuck.isError).toBe(true)
    expect(textOf(stuck)).toContain('did not finish within')
    expect(textOf(stuck)).toContain('Your session is fine')
    // The queue moved on: the next calls answer at once.
    const status = await settle(fake.call(a, 'zen_status'), 500)
    expect(status).not.toBe('HUNG')
    const snap = await settle(fake.call(a, 'browser_snapshot', { tabId: tab }), 1000)
    expect(snap !== 'HUNG' && !snap.isError).toBe(true)
    const d = fake.service.diagnosticsSnapshot()
    expect(d.calls.timedOut).toBe(1)
    expect(d.calls.inFlight).toBe(0)
  })

  it('a page that stays unresponsive is reloaded on the next call', async () => {
    const fake = browser()
    fake.service.callDeadlineMs = 150
    fake.service.pageProbeMs = 30
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    await fake.call(a, 'browser_snapshot', { tabId: tab })
    const view = fake.browser.tabs.view(tab)!
    const answer = view.executeJavaScript.bind(view)
    let hung = true
    view.executeJavaScript = (code: string, frameId?: number) =>
      hung ? new Promise<never>(() => undefined) : answer(code, frameId)
    const reload = view.reload.bind(view)
    view.reload = (ignoreCache: boolean) => {
      hung = false
      reload(ignoreCache)
    }
    await fake.call(a, 'browser_snapshot', { tabId: tab })
    const next = await settle(fake.call(a, 'browser_snapshot', { tabId: tab }), 2000)
    expect(fake.reloads).toEqual([tab])
    expect(next !== 'HUNG' && textOf(next)).toContain('had stopped responding and was reloaded')
  })

  it('one agent stuck does not hold back another', async () => {
    const fake = browser()
    fake.service.callDeadlineMs = 300
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const { s: b } = await named(fake, 'PR 741 review')
    const ta = await openTab(fake, a, 'https://billing.test')
    const tb = await openTab(fake, b, 'https://github.test')
    fake.hold(ta)
    const stuck = fake.call(a, 'browser_snapshot', { tabId: ta })
    const other = await settle(fake.call(b, 'browser_snapshot', { tabId: tb }), 200)
    expect(other).not.toBe('HUNG')
    await stuck
  })
})

describe("page dialogs on an agent's tab are the agent's", () => {
  const confirm = (
    message: string
  ): {
    kind: 'confirm'
    message: string
    defaultValue: string
    frameUrl: string
    pageUrl: string
  } => ({
    kind: 'confirm' as const,
    message,
    defaultValue: '',
    frameUrl: 'https://billing.test/',
    pageUrl: 'https://billing.test/'
  })

  it('browser_handle_dialog is listed only where the host routes dialogs to agents', async () => {
    const listed = (fake: FakeBrowser, s: AgentSession): string[] =>
      fake.service.listTools(s).map((t) => t.name)
    const desktop = browser()
    const { s: d } = await named(desktop, 'Invoice reconciliation')
    expect(listed(desktop, d)).toContain('browser_handle_dialog')
    expect(desktop.service.instructions(d)).toContain('browser_handle_dialog answers it')
    // The dialogs handed to an agent are alert, confirm and prompt (`PageDialogRequest.kind`);
    // a "Leave site?" is never handed to it: where the host has the dialog policy it is the
    // policy's leave or stay (`PageDialogService.confirmLeave` → `AgentService.onLeaveSite`),
    // leave by default; where it has not (Android's `UnloadObjection` leaves silently) the
    // page leaves without a question. The texts say which.
    const handleDialog = desktop.service
      .listTools(d)
      .find((t) => t.name === 'browser_handle_dialog')
    expect(handleDialog?.description).toContain('(alert, confirm or prompt)')
    expect(handleDialog?.description).toContain(
      'a "Leave site?" is never handed to you – your policy\'s leave or stay answers it, leave by default'
    )
    expect(desktop.service.instructions(d)).toContain(
      'Page dialogs (alert, confirm, prompt) on your tabs'
    )
    expect(desktop.service.instructions(d)).toContain('"Leave site?" leave or stay')
    expect(desktop.service.instructions(d)).not.toContain('your tab leaves without a question')

    const android = browser({ agentDialogs: false })
    const { s: a } = await named(android, 'Invoice reconciliation')
    expect(listed(android, a)).not.toContain('browser_handle_dialog')
    expect(listed(android, a)).toContain('browser_snapshot')
    expect(android.service.instructions(a)).not.toContain('browser_handle_dialog')
    expect(android.service.instructions(a)).toContain('answered by this browser, not by you')
    expect(android.service.instructions(a)).toContain('your tab leaves without a question')
    const res = await android.call(a, 'browser_handle_dialog', { accept: true })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('Unknown tool browser_handle_dialog')
  })

  it('a dialog during a call ends the call with it; the user never sees it; the agent answers', async () => {
    const fake = browser()
    const dialogs = new PageDialogService(fake.browser)
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    const gate = fake.hold(tab)
    const call = fake.call(a, 'browser_click', { tabId: tab, target: 'text=Go' })
    await new Promise((r) => setTimeout(r, 20))
    const answer = dialogs.ask(tab, confirm('Delete invoice 42?'))
    const res = await settle(call, 500)
    expect(res).not.toBe('HUNG')
    expect(res !== 'HUNG' && textOf(res)).toContain('opened a confirm dialog: "Delete invoice 42?"')
    expect(dialogs.list()).toEqual([])
    const blocked = await fake.call(a, 'browser_snapshot', { tabId: tab })
    expect(blocked.isError).toBe(true)
    expect(textOf(blocked)).toContain('browser_handle_dialog')
    gate.release()
    const handled = await fake.call(a, 'browser_handle_dialog', { tabId: tab, accept: true })
    expect(handled.isError, textOf(handled)).toBeFalsy()
    expect(await answer).toEqual({ accepted: true, value: null })
  })

  it('a dialog between calls is a notice; an unanswered one is dismissed, never left blocking', async () => {
    const fake = browser()
    fake.service.dialogTtlMs = 50
    const dialogs = new PageDialogService(fake.browser)
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    const answer = dialogs.ask(tab, { ...confirm(''), kind: 'prompt', defaultValue: 'x' })
    expect(textOf(await fake.call(a, 'zen_status'))).toContain('opened a prompt (default "x")')
    expect(await settle(answer, 500)).toEqual({ accepted: false, value: null })
    expect((await fake.call(a, 'browser_snapshot', { tabId: tab })).isError).toBeFalsy()
  })

  it("an away agent's page is answered by the timeout, and the user's own pages still ask the user", async () => {
    const fake = browser()
    fake.service.dialogTtlMs = 50
    const dialogs = new PageDialogService(fake.browser)
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    fake.service.close(a.id)
    expect(await settle(dialogs.ask(tab, confirm('Leave?')), 500)).toEqual({
      accepted: false,
      value: null
    })
    expect(dialogs.list()).toEqual([])
    const mine = fake.user.openTab('https://mine.test')
    void dialogs.ask(mine.id, confirm('Really?'))
    expect(dialogs.list().map((d) => d.tabId)).toEqual([mine.id])
  })

  it("an away agent's tab in front of the user keeps the user's dialogs and Leave site?", async () => {
    const fake = browser()
    fake.service.dialogTtlMs = 50
    const dialogs = new PageDialogService(fake.browser)
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    expect(fake.service.takesDialog(tab)).toBe(true)
    fake.service.close(a.id)
    expect(fake.service.heldBy(fake.model.tabs[tab].folderId!)).toBeDefined()
    expect(fake.service.takesDialog(tab)).toBe(true)

    fake.user.activate(tab)
    expect(fake.service.isShown(fake.model.tabs[tab], fake.win as unknown as ZenWindow)).toBe(true)
    expect(fake.service.takesDialog(tab)).toBe(false)
    void dialogs.ask(tab, confirm('Discard the draft?'))
    expect(dialogs.list().map((d) => d.tabId)).toEqual([tab])
    expect(fake.service.pendingDialog(tab)).toBeNull()
    const host = fake.win as unknown as { host: { isFocused(): boolean; focus(): void } }
    host.host = { isFocused: () => true, focus: () => undefined }
    expect(await settle(dialogs.confirmLeave(tab, false), 50)).toBe('HUNG')
    expect(dialogs.list().filter((d) => d.tabId === tab)).toHaveLength(2)
  })

  it('"Leave site?" on an agent\'s tab neither activates it nor focuses the window', async () => {
    const fake = browser()
    const host = fake.win as unknown as { host: { isFocused(): boolean; focus(): void } }
    let focused = 0
    host.host = { isFocused: () => false, focus: () => void focused++ }
    const dialogs = new PageDialogService(fake.browser)
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const mine = fake.user.openTab('https://mine.test')
    const tab = await openTab(fake, a, 'https://billing.test')
    fake.user.activate(mine.id)
    const before = fake.win.activations.length
    expect(await dialogs.confirmLeave(tab, false)).toBe(true)
    expect(fake.win.activations.slice(before)).toEqual([])
    expect(focused).toBe(0)
    expect(dialogs.list()).toEqual([])
  })
})

describe("the dialog policy: an agent says ahead how its tabs' dialogs are answered", () => {
  type Request = Parameters<PageDialogService['ask']>[1]
  const request = (
    kind: 'alert' | 'confirm' | 'prompt',
    message: string,
    defaultValue = '',
    site = 'https://billing.test/'
  ): Request => ({ kind, message, defaultValue, frameUrl: site, pageUrl: site })
  const listed = (fake: FakeBrowser, s: AgentSession): string[] =>
    fake.service.listTools(s).map((t) => t.name)
  const policy = (
    fake: FakeBrowser,
    s: AgentSession,
    args: Record<string, unknown>
  ): Promise<string> => fake.call(s, 'browser_dialog_policy', args).then(textOf)
  /** The agent's next result: whatever notices queued ride it. */
  const next = (fake: FakeBrowser, s: AgentSession): Promise<string> =>
    fake.call(s, 'zen_status').then(textOf)
  /**
   * Make the fake's navigations raise "Leave site?" through the real `PageDialogService`
   * first, as a host does when the page's `beforeunload` handler objects.
   */
  const objectingPages = (fake: FakeBrowser): void => {
    const tabs = fake.browser.tabs as unknown as { navigate(id: string, url: string): void }
    const real = tabs.navigate.bind(tabs)
    tabs.navigate = (id, url) => {
      void fake.browser.pageDialogs.confirmLeave(id, false).then((leave) => {
        if (leave) real(id, url)
      })
    }
  }
  /**
   * Make the fake's navigations go the way of a host that answers "Leave site?" itself
   * (Android's `TabWebView.onJsBeforeUnload`): the page objects, the host answers at once from
   * the policy the core handed its view (`setDialogPolicy`; leave without an entry), keeps the
   * page on stay, and reports – posted to the core as the wire posts it, so the report lands
   * while the navigating call waits on the load.
   */
  const reportingHost = (fake: FakeBrowser): void => {
    const tabs = fake.browser.tabs as unknown as { navigate(id: string, url: string): void }
    const real = tabs.navigate.bind(tabs)
    tabs.navigate = (id, url) => {
      const entry = fake.dialogPolicies.get(id)?.at(-1)?.beforeunload
      const stay = entry?.answer === 'stay'
      setTimeout(() => {
        fake.service.onPageDialogAnswered(id, {
          kind: 'beforeunload',
          url: fake.model.tabs[id]?.url ?? '',
          message: 'Changes you made may not be saved.',
          answer: stay ? 'stay' : 'leave',
          rule: entry?.rule ?? 'default'
        })
        if (!stay) real(id, url)
      }, 30)
    }
  }

  it('is listed only where the host has the policy, and the instructions say what the host does', async () => {
    const desktop = browser()
    const { s: d } = await named(desktop, 'Invoice reconciliation')
    expect(listed(desktop, d)).toContain('browser_dialog_policy')
    expect(listed(desktop, d)).toContain('browser_handle_dialog')
    const instructions = desktop.service.instructions(d)
    expect(instructions).toContain('Page dialogs (alert, confirm, prompt) on your tabs')
    expect(instructions).toContain(
      'browser_dialog_policy says ahead of an action how they are answered on a tab (confirm OK or Cancel, a prompt\'s text, "Leave site?" leave or stay)'
    )
    expect(instructions).toContain(
      'a confirm or prompt no rule covers returns with the call that opened it, and browser_handle_dialog answers it'
    )
    expect(instructions).toContain(
      "A navigation or close the user makes on your tab follows the user's rules, never your policy."
    )
    const handle = desktop.service.listTools(d).find((t) => t.name === 'browser_handle_dialog')
    expect(handle?.description).toContain(
      '(alert, confirm or prompt) that your dialog policy did not'
    )
    expect(handle?.description).toContain(
      'a "Leave site?" is never handed to you – your policy\'s leave or stay answers it, leave by default'
    )
    const prompts = AGENT_TOOLS.find((t) => t.definition.name === 'browser_prompts')
    expect(prompts?.definition.description).toContain(
      'A dialog policy you set (browser_dialog_policy) is not listed here'
    )

    // Android today: neither the dialogs nor the policy – nothing changes until their half lands.
    const android = browser({ agentDialogs: false })
    const { s: a } = await named(android, 'Invoice reconciliation')
    expect(listed(android, a)).not.toContain('browser_dialog_policy')
    expect(android.service.instructions(a)).toContain('answered by this browser, not by you')
    expect(android.service.instructions(a)).toContain('your tab leaves without a question')
    const res = await android.call(a, 'browser_dialog_policy', { confirm: 'accept' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('Unknown tool browser_dialog_policy')

    // Android with their half: the host answers from the policy, nothing is handed over.
    const later = browser({ agentDialogs: false, agentDialogPolicy: true })
    const { s: l } = await named(later, 'Invoice reconciliation')
    expect(listed(later, l)).toContain('browser_dialog_policy')
    expect(listed(later, l)).not.toContain('browser_handle_dialog')
    expect(later.service.instructions(l)).toContain(
      'are answered by this browser, never handed to you – from your dialog policy where you set one'
    )
    expect(later.service.instructions(l)).toContain(
      'else by default: alert OK, confirm Cancel, prompt Cancel, "Leave site?" leave'
    )

    // browser_respond_prompt, asked about a page dialog, names only the tools its host lists
    // (#766's known gap: Android was told to use browser_handle_dialog, which it does not list).
    const noPrompt = async (agentDialogs: boolean, agentDialogPolicy: boolean): Promise<string> => {
      const fake = browser({ agentDialogs, agentDialogPolicy, agentPrompts: ['permission'] })
      const { s } = await named(fake, 'Invoice reconciliation')
      await openTab(fake, s, 'https://billing.test')
      const res = await fake.call(s, 'browser_respond_prompt', { action: 'allow' })
      expect(res.isError).toBe(true)
      return textOf(res)
    }
    expect(await noPrompt(true, true)).toContain(
      'A page dialog (alert, confirm, prompt) is answered with browser_handle_dialog, or ahead of time by browser_dialog_policy.'
    )
    expect(await noPrompt(true, false)).toContain(
      'A page dialog (alert, confirm, prompt) is answered with browser_handle_dialog.'
    )
    expect(await noPrompt(false, true)).toContain(
      'answered by this browser – from your dialog policy (browser_dialog_policy) where you set one, else by default – and reported in a "Notice:" line.'
    )
    expect(await noPrompt(false, false)).toContain(
      'A page dialog (alert, confirm, prompt) is answered by this browser, not by you.'
    )
  })

  it('set names the policy in force, marks the kinds left to their defaults, and clear says what went', async () => {
    const fake = browser()
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    expect(await policy(fake, a, { tabId: tab, confirm: 'accept' })).toBe(
      `Dialog policy for tab ${tab} (billing.test): confirm → OK; prompt → Cancel (default); "Leave site?" → leave (default); alerts → OK. Kinds marked (default) had no word from you. In force until you clear it (action: "clear"), let the tab go or end the session. Every dialog it answers is reported in your next result with the page's words.`
    )
    expect(
      await policy(fake, a, { confirm: 'dismiss', prompt: { text: 'hello' }, beforeunload: 'stay' })
    ).toBe(
      `Dialog policy for every tab you own, now and later: confirm → Cancel; prompt → OK with "hello"; "Leave site?" → stay; alerts → OK. In force until you clear it (action: "clear") or end the session. Tab ${tab} keeps its own policy over it. Every dialog it answers is reported in your next result with the page's words.`
    )
    // The tab's own rule stands over the session-wide one kind by kind.
    expect(await policy(fake, a, { tabId: tab, prompt: 'accept', ttl: 120, once: true })).toBe(
      `Dialog policy for tab ${tab} (billing.test): confirm → Cancel (for every tab); prompt → OK with the page's default; "Leave site?" → stay (for every tab); alerts → OK. Kinds marked (for every tab) follow your policy for every tab you own. In force once per kind – each kind's rule is spent by the first dialog it answers – for 120 s at most, or until you clear it (action: "clear"), let the tab go or end the session. Every dialog it answers is reported in your next result with the page's words.`
    )
    expect(await policy(fake, a, { tabId: tab, action: 'clear' })).toBe(
      `Dropped the dialog policy of tab ${tab} (billing.test); your policy for every tab you own applies to it now.`
    )
    expect(await policy(fake, a, { tabId: tab, action: 'clear' })).toBe(
      `Tab ${tab} (billing.test) had no dialog policy of its own; your policy for every tab you own applies to it.`
    )
    expect(await policy(fake, a, { action: 'clear' })).toBe(
      'Dropped your dialog policy for every tab you own.'
    )
    expect(await policy(fake, a, { action: 'clear' })).toBe(
      'You had no dialog policy for every tab you own.'
    )
    expect(await policy(fake, a, { tabId: tab, beforeunload: 'leave', ttl: 30 })).toBe(
      `Dialog policy for tab ${tab} (billing.test): confirm → Cancel (default); prompt → Cancel (default); "Leave site?" → leave; alerts → OK. Kinds marked (default) had no word from you. In force for 30 s, or until you clear it (action: "clear"), let the tab go or end the session. Every dialog it answers is reported in your next result with the page's words.`
    )
    expect(await policy(fake, a, { action: 'clear' })).toBe(
      `You had no dialog policy for every tab you own; 1 tab keeps a policy of its own: ${tab} (clear those with their tabId).`
    )
    for (const bad of [
      { tabId: tab },
      { tabId: tab, confirm: 'maybe' },
      { tabId: tab, prompt: 'hello' },
      { tabId: tab, beforeunload: 'ask' },
      { tabId: tab, confirm: 'accept', ttl: 0 },
      { tabId: tab, confirm: 'accept', action: 'drop' }
    ]) {
      const res = await fake.call(a, 'browser_dialog_policy', bad)
      expect(res.isError, JSON.stringify(bad)).toBe(true)
    }
    expect(textOf(await fake.call(a, 'browser_dialog_policy', { tabId: tab }))).toContain(
      'Say at least one of confirm, prompt or beforeunload'
    )
    expect(
      textOf(await fake.call(a, 'browser_dialog_policy', { tabId: tab, prompt: 'hello' }))
    ).toContain('a bare string would be ambiguous')
  })

  it('answers every kind at once from the policy and reports each in the ruled Notice', async () => {
    const fake = browser()
    const dialogs = fake.browser.pageDialogs
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    await policy(fake, a, { tabId: tab, confirm: 'accept', prompt: { text: 'INV-42' } })
    expect(await dialogs.ask(tab, request('confirm', 'Delete invoice 42?'))).toEqual({
      accepted: true,
      value: null
    })
    expect(await dialogs.ask(tab, request('prompt', 'Invoice number?', 'INV-1'))).toEqual({
      accepted: true,
      value: 'INV-42'
    })
    expect(await dialogs.ask(tab, request('alert', 'Saved.'))).toEqual({
      accepted: true,
      value: null
    })
    expect(dialogs.list()).toEqual([])
    expect(fake.service.pendingDialog(tab)).toBeNull()
    const result = await next(fake, a)
    expect(result).toContain(
      `Notice: the page in tab ${tab} (billing.test) opened a confirm dialog: "Delete invoice 42?" – answered OK by your dialog policy.`
    )
    expect(result).toContain(
      `Notice: the page in tab ${tab} (billing.test) opened a prompt (default "INV-1"): "Invoice number?" – answered with "INV-42" by your dialog policy.`
    )
    expect(result).toContain(
      `Notice: the page in tab ${tab} (billing.test) opened an alert: "Saved." – answered OK by your dialog policy.`
    )
    // Reported once: the next result carries none of them again.
    expect(await next(fake, a)).not.toContain('Notice: the page in tab')

    await policy(fake, a, { tabId: tab, confirm: 'dismiss', prompt: 'dismiss' })
    expect(await dialogs.ask(tab, request('confirm', 'Pay now?'))).toEqual({
      accepted: false,
      value: null
    })
    expect(await dialogs.ask(tab, request('prompt', 'Amount?', '10'))).toEqual({
      accepted: false,
      value: null
    })
    const again = await next(fake, a)
    expect(again).toContain(
      `opened a confirm dialog: "Pay now?" – answered Cancel by your dialog policy.`
    )
    expect(again).toContain(
      `opened a prompt (default "10"): "Amount?" – answered Cancel by your dialog policy.`
    )
    // The notices ride whatever call comes next – a set of the policy as well.
    const set = await policy(fake, a, { tabId: tab, prompt: 'accept' })
    expect(set).toContain('Dialog policy for tab')
    expect(await dialogs.ask(tab, request('prompt', 'Amount?', '10'))).toEqual({
      accepted: true,
      value: '10'
    })
    expect(await next(fake, a)).toContain(
      `opened a prompt (default "10"): "Amount?" – answered with "10" by your dialog policy.`
    )
  })

  it('without a policy an alert gets OK at once and is reported with the tag; confirm and prompt still round-trip', async () => {
    const fake = browser()
    const dialogs = fake.browser.pageDialogs
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    expect(await dialogs.ask(tab, request('alert', 'Hello'))).toEqual({
      accepted: true,
      value: null
    })
    expect(await next(fake, a)).toContain(
      `Notice: the page in tab ${tab} (billing.test) opened an alert: "Hello" – answered OK (no policy; browser_dialog_policy sets one).`
    )
    // The desktop's round-trip for a kind no rule covers, as today.
    await policy(fake, a, { tabId: tab, prompt: 'accept' })
    const answer = dialogs.ask(tab, request('confirm', 'Delete invoice 42?'))
    expect(fake.service.pendingDialog(tab)?.message).toBe('Delete invoice 42?')
    const blocked = await fake.call(a, 'browser_snapshot', { tabId: tab })
    expect(blocked.isError).toBe(true)
    expect(textOf(blocked)).toContain('browser_handle_dialog')
    const handled = await fake.call(a, 'browser_handle_dialog', { tabId: tab, accept: false })
    expect(handled.isError, textOf(handled)).toBeFalsy()
    expect(await answer).toEqual({ accepted: false, value: null })
    // An alert on a tab with a policy of another kind is the policy's OK.
    expect(await dialogs.ask(tab, request('alert', 'Bye'))).toEqual({ accepted: true, value: null })
    expect(await next(fake, a)).toContain(
      `opened an alert: "Bye" – answered OK by your dialog policy.`
    )
  })

  it("a host's own report of an answered dialog becomes the same Notice, default answers tagged", async () => {
    const fake = browser({ agentDialogs: false, agentDialogPolicy: true })
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    await policy(fake, a, { tabId: tab, confirm: 'accept' })
    // The host got the policy for the tab's view when the agent last acted on it – each kind's
    // answer with the rule that supplies it, the host's word for its reports.
    expect(fake.dialogPolicies.get(tab)?.at(-1)).toEqual({
      confirm: { answer: 'accept', rule: 'tab' }
    })
    // The wire: kind, the document's url, the message, a prompt's default, the answer and the
    // rule – `default` for a kind the handed policy left out.
    fake.service.onPageDialogAnswered(tab, {
      kind: 'confirm',
      url: 'https://billing.test/pay',
      message: 'Pay now?',
      answer: 'accept',
      rule: 'tab'
    })
    fake.service.onPageDialogAnswered(tab, {
      kind: 'prompt',
      url: 'https://billing.test/pay',
      message: 'Amount?',
      defaultValue: '10',
      answer: 'dismiss',
      rule: 'default'
    })
    fake.service.onPageDialogAnswered(tab, {
      kind: 'beforeunload',
      url: 'https://billing.test/pay',
      message: 'Changes you made may not be saved.',
      answer: 'leave',
      rule: 'default'
    })
    fake.service.onPageDialogAnswered(tab, {
      kind: 'alert',
      url: 'data:text/html,hi',
      message: 'x'.repeat(600),
      answer: 'accept',
      rule: 'tab'
    })
    const result = await next(fake, a)
    expect(result).toContain(
      `Notice: the page in tab ${tab} (billing.test) opened a confirm dialog: "Pay now?" – answered OK by your dialog policy.`
    )
    expect(result).toContain(
      `Notice: the page in tab ${tab} (billing.test) opened a prompt (default "10"): "Amount?" – answered Cancel (no policy; browser_dialog_policy sets one).`
    )
    expect(result).toContain(
      `Notice: the page in tab ${tab} (billing.test) opened a "Leave site?" dialog: "Changes you made may not be saved." – answered left (no policy; browser_dialog_policy sets one).`
    )
    // The message is capped at 500 characters; a page without a site is "the page".
    expect(result).toContain(
      `Notice: the page in tab ${tab} (the page) opened an alert: "${'x'.repeat(500)}" – answered OK by your dialog policy.`
    )
    expect(result).not.toContain('x'.repeat(501))
  })

  it("a host's report spends the once rule it names – the tab's, the session's, neither – never one the core would look up itself", async () => {
    const fake = browser({ agentDialogs: false, agentDialogPolicy: true })
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    const standing = (): Record<string, unknown> => ({
      own: fake.service.dialogPolicyOf(a).tabs.get(tab)?.policy ?? null,
      all: fake.service.dialogPolicyOf(a).all?.policy ?? null,
      view: fake.dialogPolicies.get(tab)?.at(-1)
    })
    const report = (rule: AgentDialogRuleScope, answer: AgentDialogAnswer = 'accept'): void =>
      fake.service.onPageDialogAnswered(tab, {
        kind: 'confirm',
        url: 'https://billing.test/pay',
        message: 'Pay now?',
        answer,
        rule
      })
    await policy(fake, a, { confirm: 'dismiss', once: true })
    await policy(fake, a, { tabId: tab, confirm: 'accept', once: true })
    expect(standing().view).toEqual({ confirm: { answer: 'accept', rule: 'tab' } })

    // `default`: the host answered by default – nothing is spent, whatever stands.
    report('default')
    expect(standing()).toMatchObject({ own: { confirm: 'accept' }, all: { confirm: 'dismiss' } })

    // `tab`: the tab's once rule goes and the session's stands – the core's own lookup would
    // have found the tab's too, but it is the host's word that spends – and the view hears
    // the policy that is left.
    report('tab')
    expect(standing()).toEqual({
      own: null,
      all: { confirm: 'dismiss' },
      view: { confirm: { answer: 'dismiss', rule: 'session' } }
    })

    // A report of a rule the policy no longer carries spends nothing.
    report('tab')
    expect(standing().all).toEqual({ confirm: 'dismiss' })

    // `session`: the session's once rule goes; nothing stands, and the view hears null.
    report('session', 'dismiss')
    expect(fake.service.dialogPolicyOf(a)).toEqual({ all: null, tabs: new Map() })
    expect(standing().view).toBeNull()

    // Every report came back as the Notice, tagged by the rule the host named.
    const result = await next(fake, a)
    expect(result).toContain(
      `opened a confirm dialog: "Pay now?" – answered OK (no policy; browser_dialog_policy sets one).`
    )
    expect(result).toContain(
      `opened a confirm dialog: "Pay now?" – answered OK by your dialog policy.`
    )
    expect(result).toContain(
      `opened a confirm dialog: "Pay now?" – answered Cancel by your dialog policy.`
    )

    // The reverse: `session` leaves the tab's own rule alone, spends the session's kind only,
    // and a report of a kind the session's rule no longer carries spends nothing.
    await policy(fake, a, { confirm: 'dismiss', prompt: 'accept', once: true })
    await policy(fake, a, { tabId: tab, confirm: 'accept', once: true })
    report('session', 'dismiss')
    expect(standing()).toEqual({
      own: { confirm: 'accept' },
      all: { prompt: 'accept' },
      view: {
        confirm: { answer: 'accept', rule: 'tab' },
        prompt: { answer: 'accept', rule: 'session' }
      }
    })
    report('session', 'dismiss')
    expect(standing().all).toEqual({ prompt: 'accept' })
  })

  it("once spends the per-kind rule of the policy that answered; a tab's once never consumes the session's rule", async () => {
    const fake = browser()
    const dialogs = fake.browser.pageDialogs
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    await policy(fake, a, { confirm: 'dismiss' })
    await policy(fake, a, { tabId: tab, confirm: 'accept', once: true })
    // The tab's once rule answers the first confirm and is spent by it…
    expect((await dialogs.ask(tab, request('confirm', 'First?'))).accepted).toBe(true)
    // …the second falls back to the session-wide standing rule, which stays.
    expect((await dialogs.ask(tab, request('confirm', 'Second?'))).accepted).toBe(false)
    expect((await dialogs.ask(tab, request('confirm', 'Third?'))).accepted).toBe(false)
    expect(fake.service.dialogPolicyOf(a).tabs.has(tab)).toBe(false)
    expect(fake.service.dialogPolicyOf(a).all?.policy).toEqual({ confirm: 'dismiss' })
    const result = await next(fake, a)
    expect(result).toContain('"First?" – answered OK by your dialog policy.')
    expect(result).toContain('"Second?" – answered Cancel by your dialog policy.')

    // The other way: a once session-wide rule is spent by the tab it answered on; the tab's
    // own standing rule for another kind is untouched, and the spent kind gets its default.
    await policy(fake, a, { action: 'clear' })
    await policy(fake, a, { prompt: { text: 'A' }, once: true })
    await policy(fake, a, { tabId: tab, confirm: 'accept' })
    expect(await dialogs.ask(tab, request('prompt', 'Name?'))).toEqual({
      accepted: true,
      value: 'A'
    })
    expect(fake.service.dialogPolicyOf(a).all).toBeNull()
    expect(fake.service.dialogPolicyOf(a).tabs.get(tab)?.policy).toEqual({ confirm: 'accept' })
    const held = dialogs.ask(tab, request('prompt', 'Name again?'))
    expect(fake.service.pendingDialog(tab)?.message).toBe('Name again?')
    fake.service.answerDialog(tab, false)
    expect(await held).toEqual({ accepted: false, value: null })
    expect((await dialogs.ask(tab, request('confirm', 'Sure?'))).accepted).toBe(true)
  })

  it('a rule with a ttl drops silently when it runs out, and the next dialog says so', async () => {
    const fake = browser()
    const dialogs = fake.browser.pageDialogs
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    let now = 1_000_000
    fake.service.clock = () => now
    await policy(fake, a, { tabId: tab, confirm: 'accept', ttl: 60 })
    expect((await dialogs.ask(tab, request('confirm', 'Within?'))).accepted).toBe(true)
    now += 59_000
    expect((await dialogs.ask(tab, request('confirm', 'Still?'))).accepted).toBe(true)
    now += 2_000
    expect(fake.service.dialogPolicyOf(a).tabs.size).toBe(0)
    const held = dialogs.ask(tab, request('confirm', 'After?'))
    expect(fake.service.pendingDialog(tab)?.message).toBe('After?')
    fake.service.answerDialog(tab, true)
    await held
    expect(await dialogs.ask(tab, request('alert', 'Gone'))).toEqual({
      accepted: true,
      value: null
    })
    expect(await next(fake, a)).toContain(
      `opened an alert: "Gone" – answered OK (no policy; browser_dialog_policy sets one).`
    )
  })

  it("a session-wide policy covers tabs opened later from their first call; a ttl runs out by its timer; a tab let go drops its own rule – and the hosts' views hear each", async () => {
    const fake = browser()
    const dialogs = fake.browser.pageDialogs
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const first = await openTab(fake, a, 'https://billing.test')
    await policy(fake, a, { confirm: 'accept' })
    const viewOf = (tab: string): unknown => fake.dialogPolicies.get(tab)?.at(-1)
    expect(viewOf(first)).toEqual({ confirm: { answer: 'accept', rule: 'session' } })

    // Now and later: a tab opened after the set hears the policy as it is readied for the
    // agent's first call on it, and its dialogs are answered from it.
    const later = await openTab(fake, a, 'https://later.test')
    expect(viewOf(later)).toEqual({ confirm: { answer: 'accept', rule: 'session' } })
    expect(
      (await dialogs.ask(later, request('confirm', 'Later?', '', 'https://later.test/'))).accepted
    ).toBe(true)
    expect(await next(fake, a)).toContain(
      `the page in tab ${later} (later.test) opened a confirm dialog: "Later?" – answered OK by your dialog policy.`
    )

    // A ttl runs out by its timer, with no dialog or call to notice: the tab's own rule is
    // gone and its view hears what is left – the session's.
    await policy(fake, a, { tabId: later, confirm: 'dismiss', prompt: 'accept', ttl: 0.1 })
    expect(viewOf(later)).toEqual({
      confirm: { answer: 'dismiss', rule: 'tab' },
      prompt: { answer: 'accept', rule: 'tab' }
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(viewOf(later)).toEqual({ confirm: { answer: 'accept', rule: 'session' } })
    expect(fake.service.dialogPolicyOf(a).tabs.size).toBe(0)
    // The session-wide rule's ttl the same: every view of the session hears what is left.
    await policy(fake, a, { tabId: first, prompt: 'accept' })
    await policy(fake, a, { confirm: 'dismiss', ttl: 0.1 })
    expect(viewOf(later)).toEqual({ confirm: { answer: 'dismiss', rule: 'session' } })
    expect(viewOf(first)).toEqual({
      confirm: { answer: 'dismiss', rule: 'session' },
      prompt: { answer: 'accept', rule: 'tab' }
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(fake.service.dialogPolicyOf(a).all).toBeNull()
    expect(viewOf(later)).toBeNull()
    expect(viewOf(first)).toEqual({ prompt: { answer: 'accept', rule: 'tab' } })

    // The user takes one tab back: its own rule goes with it and its view hears null; the
    // session-wide rule stands for the rest, and the released tab's dialogs are the user's.
    await policy(fake, a, { confirm: 'accept' })
    fake.service.releaseTab(first)
    expect(fake.service.dialogPolicyOf(a).tabs.has(first)).toBe(false)
    expect(viewOf(first)).toBeNull()
    expect(fake.service.takesDialog(first)).toBe(false)
    expect(fake.service.dialogPolicyOf(a).all?.policy).toEqual({ confirm: 'accept' })
    expect(viewOf(later)).toEqual({ confirm: { answer: 'accept', rule: 'session' } })
  })

  it('"Leave site?" under the agent\'s navigation on a hidden tab: stay cancels it and the result says so, leave is reported', async () => {
    const fake = browser()
    objectingPages(fake)
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    await policy(fake, a, { tabId: tab, beforeunload: 'stay' })
    const stayed = await fake.call(a, 'browser_navigate', { tabId: tab, url: 'https://next.test' })
    expect(stayed.isError, textOf(stayed)).toBeFalsy()
    expect(textOf(stayed)).toContain(
      'Did not navigate: the page objected ("Leave site?") and your dialog policy answered stay, so the tab still shows the page as it was.'
    )
    expect(textOf(stayed)).toContain(
      `Notice: the page in tab ${tab} (billing.test) opened a "Leave site?" dialog: "Changes you made may not be saved." – answered stayed by your dialog policy.`
    )
    expect(fake.model.tabs[tab].url).toBe('https://billing.test')
    expect(fake.browser.pageDialogs.list()).toEqual([])

    await policy(fake, a, { tabId: tab, beforeunload: 'leave' })
    const left = await fake.call(a, 'browser_navigate', { tabId: tab, url: 'https://next.test' })
    expect(textOf(left)).toContain('Navigated to https://next.test')
    expect(textOf(left)).toContain(
      `opened a "Leave site?" dialog: "Changes you made may not be saved." – answered left by your dialog policy.`
    )
    expect(fake.model.tabs[tab].url).toBe('https://next.test')

    // Without a rule the page leaves, as today – but no longer in silence.
    await policy(fake, a, { tabId: tab, action: 'clear' })
    const silent = await fake.call(a, 'browser_navigate', { tabId: tab, url: 'https://third.test' })
    expect(textOf(silent)).toContain('Navigated to https://third.test')
    expect(textOf(silent)).toContain(
      `opened a "Leave site?" dialog: "Changes you made may not be saved." – answered left (no policy; browser_dialog_policy sets one).`
    )
  })

  it('a stay is read by the navigation it kept, never a later one; back, forward and reload read it in their words too', async () => {
    const fake = browser()
    const dialogs = fake.browser.pageDialogs
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    await policy(fake, a, { tabId: tab, beforeunload: 'stay' })
    // The page's own navigation on the hidden tab: the policy's stay keeps it, and no call of
    // the agent was navigating to read so.
    expect(await dialogs.confirmLeave(tab, false)).toBe(false)
    // The agent's next navigation, which the page lets go without a word: the normal headline
    // – the stay that kept the page before is not read against this navigation – and the
    // Notice of the page's own.
    const went = await fake.call(a, 'browser_navigate', { tabId: tab, url: 'https://next.test' })
    expect(went.isError, textOf(went)).toBeFalsy()
    expect(textOf(went)).toContain('Navigated to https://next.test')
    expect(textOf(went)).not.toContain('Did not navigate')
    expect(textOf(went)).toContain('– answered stayed by your dialog policy.')
    expect(fake.model.tabs[tab].url).toBe('https://next.test')

    // Back, forward and reload meet the page's objection like a navigation: stay keeps the
    // page and each says so in place of its own headline; leave lets each go ahead.
    const tabs = fake.browser.tabs as unknown as {
      goBack(id: string): void
      goForward(id: string): void
      reload(id: string, ignoreCache?: boolean): void
    }
    const objecting =
      (reload: boolean) =>
      (id: string): void => {
        void dialogs.confirmLeave(id, reload)
      }
    tabs.goBack = objecting(false)
    tabs.goForward = objecting(false)
    tabs.reload = objecting(true)
    const view = fake.browser.tabs.view(tab)
    if (!view) throw new Error('no view')
    view.canGoBack = () => true
    view.canGoForward = () => true
    const moves = [
      ['browser_navigate_back', 'Went back.'],
      ['browser_navigate_forward', 'Went forward.'],
      ['browser_reload', 'Reloaded.']
    ] as const
    for (const [tool, headline] of moves) {
      const kept = await fake.call(a, tool, { tabId: tab })
      expect(kept.isError, textOf(kept)).toBeFalsy()
      expect(textOf(kept)).toContain(
        'Did not navigate: the page objected ("Leave site?") and your dialog policy answered stay, so the tab still shows the page as it was.'
      )
      expect(textOf(kept)).not.toContain(headline)
      expect(textOf(kept)).toContain(
        `opened a "Leave site?" dialog: "Changes you made may not be saved." – answered stayed by your dialog policy.`
      )
    }
    await policy(fake, a, { tabId: tab, beforeunload: 'leave' })
    for (const [tool, headline] of moves) {
      const went = await fake.call(a, tool, { tabId: tab })
      expect(went.isError, textOf(went)).toBeFalsy()
      expect(textOf(went)).toContain(headline)
      expect(textOf(went)).not.toContain('Did not navigate')
      expect(textOf(went)).toContain(
        `opened a "Leave site?" dialog: "Changes you made may not be saved." – answered left by your dialog policy.`
      )
    }
  })

  it('a host that answers "Leave site?" itself reports the policy\'s stay, and the navigating call reads it as the core\'s own: the headline and the Notice; a reported leave marks nothing', async () => {
    const fake = browser({ agentDialogs: false, agentDialogPolicy: true })
    reportingHost(fake)
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    // The real wait: the host's report lands while the call waits on the load, as on the wire.
    fake.service.waitForLoad = AgentService.prototype.waitForLoad
    await policy(fake, a, { tabId: tab, beforeunload: 'stay' })
    expect(fake.dialogPolicies.get(tab)?.at(-1)).toEqual({
      beforeunload: { answer: 'stay', rule: 'tab' }
    })
    const stayed = await fake.call(a, 'browser_navigate', { tabId: tab, url: 'https://next.test' })
    expect(stayed.isError, textOf(stayed)).toBeFalsy()
    // The desktop path's words (the test above), from the host's report.
    expect(textOf(stayed)).toContain(
      'Did not navigate: the page objected ("Leave site?") and your dialog policy answered stay, so the tab still shows the page as it was.'
    )
    expect(textOf(stayed)).toContain(
      `Notice: the page in tab ${tab} (billing.test) opened a "Leave site?" dialog: "Changes you made may not be saved." – answered stayed by your dialog policy.`
    )
    expect(fake.model.tabs[tab].url).toBe('https://billing.test')
    // The reading was the call's: nothing is left over for a later one.
    expect(fake.service.takeStayed(tab)).toBeNull()

    // A reported leave: the page goes with the normal headline, the Notice beside it.
    await policy(fake, a, { tabId: tab, beforeunload: 'leave' })
    const left = await fake.call(a, 'browser_navigate', { tabId: tab, url: 'https://next.test' })
    expect(left.isError, textOf(left)).toBeFalsy()
    expect(textOf(left)).toContain('Navigated to https://next.test')
    expect(textOf(left)).not.toContain('Did not navigate')
    expect(textOf(left)).toContain(
      `opened a "Leave site?" dialog: "Changes you made may not be saved." – answered left by your dialog policy.`
    )
    expect(fake.model.tabs[tab].url).toBe('https://next.test')

    // The mark itself, report by report: a stay sets the policy's reading, a leave sets nothing.
    const report = (answer: 'stay' | 'leave', rule: AgentDialogRuleScope): void =>
      fake.service.onPageDialogAnswered(tab, {
        kind: 'beforeunload',
        url: 'https://next.test/',
        message: 'Changes you made may not be saved.',
        answer,
        rule
      })
    report('leave', 'default')
    expect(fake.service.takeStayed(tab)).toBeNull()
    report('stay', 'session')
    expect(fake.service.takeStayed(tab)).toBe('policy')
    expect(fake.service.takeStayed(tab)).toBeNull()
    const notices = await next(fake, a)
    expect(notices).toContain(
      `opened a "Leave site?" dialog: "Changes you made may not be saved." – answered left (no policy; browser_dialog_policy sets one).`
    )
    expect(notices).toContain(
      `opened a "Leave site?" dialog: "Changes you made may not be saved." – answered stayed by your dialog policy.`
    )
  })

  it("a host's reported stay that no call was navigating to read is dropped by the next prepare: the Notice alone", async () => {
    const fake = browser({ agentDialogs: false, agentDialogPolicy: true })
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    await policy(fake, a, { tabId: tab, beforeunload: 'stay' })
    // The page's own navigation on the hidden tab: the host answered stay from the policy and
    // reported so, and no call of the agent was navigating to read it.
    fake.service.onPageDialogAnswered(tab, {
      kind: 'beforeunload',
      url: 'https://billing.test/',
      message: 'Changes you made may not be saved.',
      answer: 'stay',
      rule: 'tab'
    })
    // The agent's next navigation, which the page lets go without a word (the fake's pages
    // have nothing to save): the normal headline – the stay that kept the page before is not
    // read against this navigation – and the Notice of the page's own.
    const went = await fake.call(a, 'browser_navigate', { tabId: tab, url: 'https://next.test' })
    expect(went.isError, textOf(went)).toBeFalsy()
    expect(textOf(went)).toContain('Navigated to https://next.test')
    expect(textOf(went)).not.toContain('Did not navigate')
    expect(textOf(went)).toContain(
      `Notice: the page in tab ${tab} (billing.test) opened a "Leave site?" dialog: "Changes you made may not be saved." – answered stayed by your dialog policy.`
    )
    expect(fake.model.tabs[tab].url).toBe('https://next.test')
    expect(fake.service.takeStayed(tab)).toBeNull()
  })

  it("the user outranks the policy: a hidden tab's \"Leave site?\" is the policy's, a shown tab's is the user's whoever navigates it", async () => {
    const fake = browser()
    const dialogs = fake.browser.pageDialogs
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    await policy(fake, a, { beforeunload: 'stay' })
    // The page's own navigation on the agent's hidden tab: the policy's (the agent's own
    // navigation there: the test above).
    expect(fake.service.takesLeave(tab)).toBe(true)
    expect(await dialogs.confirmLeave(tab, false)).toBe(false)
    expect(await next(fake, a)).toContain('– answered stayed by your dialog policy.')

    // The user closes the tab (the strip's ×, Ctrl+W: `requestClose` → `unloadingForUser`):
    // the user's rules – the desktop asks the user, the policy's stay holds nothing.
    fake.closing.add(tab)
    expect(fake.service.takesLeave(tab)).toBe(false)
    expect(fake.service.takesDialog(tab)).toBe(true)
    expect(await settle(dialogs.confirmLeave(tab, false), 50)).toBe('HUNG')
    expect(dialogs.list().map((d) => [d.tabId, d.kind])).toEqual([[tab, 'beforeunload']])
    dialogs.respond(dialogs.list()[0].id, { accepted: true, value: null })
    fake.closing.delete(tab)
    expect(await next(fake, a)).not.toContain('Leave site?')

    // The user brings the tab in front: every "Leave site?" there is the user's question –
    // the user's navigation while no call acts on the tab…
    fake.user.activate(tab)
    expect(fake.service.takesLeave(tab)).toBe(false)
    expect(await settle(dialogs.confirmLeave(tab, false), 50)).toBe('HUNG')
    expect(dialogs.list()).toHaveLength(1)
    dialogs.respond(dialogs.list()[0].id, { accepted: true, value: null })

    // …and the race the policy must lose: the user navigates the shown tab WHILE a call of
    // the agent acts on it (the two cannot be told apart mid-call). The user is asked; the
    // policy's stay holds nothing and reports nothing.
    const gate = fake.hold(tab)
    const acting = fake.call(a, 'browser_snapshot', { tabId: tab })
    await new Promise((r) => setTimeout(r, 20))
    expect(fake.service.takesLeave(tab)).toBe(false)
    expect(await settle(dialogs.confirmLeave(tab, false), 50)).toBe('HUNG')
    expect(dialogs.list().map((d) => [d.tabId, d.kind])).toEqual([[tab, 'beforeunload']])
    dialogs.respond(dialogs.list()[0].id, { accepted: false, value: null })
    gate.release()
    const snap = await acting
    expect(snap.isError, textOf(snap)).toBeFalsy()
    expect(textOf(snap)).not.toContain('Leave site?')
    expect(await next(fake, a)).not.toContain('Leave site?')
    expect(fake.model.tabs[tab].url).toBe('https://billing.test')
  })

  it("the agent's own navigation on a tab in front of the user meets the user's rules: the user is asked, and the call reports what the user chose", async () => {
    const fake = browser()
    const dialogs = fake.browser.pageDialogs
    objectingPages(fake)
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    await policy(fake, a, { beforeunload: 'stay' })
    fake.user.activate(tab)
    expect(fake.service.takesLeave(tab)).toBe(false)
    // The real wait: a navigating call waits on the user's answer, within its load timeout.
    fake.service.waitForLoad = AgentService.prototype.waitForLoad
    fake.service.loadTimeoutMs = 600

    // The user stays: the user's answer, not the policy's, and the result says whose.
    const asked = fake.call(a, 'browser_navigate', { tabId: tab, url: 'https://next.test' })
    await new Promise((r) => setTimeout(r, 200))
    expect(dialogs.list().map((d) => [d.tabId, d.kind])).toEqual([[tab, 'beforeunload']])
    dialogs.respond(dialogs.list()[0].id, { accepted: false, value: null })
    const stayed = await asked
    expect(stayed.isError, textOf(stayed)).toBeFalsy()
    expect(textOf(stayed)).toContain(
      'Did not navigate: the page objected ("Leave site?") and the user chose to stay (the tab is in front of the user, so the user\'s rules answered it, not your policy); the tab still shows the page as it was.'
    )
    expect(textOf(stayed)).not.toContain('by your dialog policy')
    expect(fake.model.tabs[tab].url).toBe('https://billing.test')
    expect(dialogs.list()).toEqual([])

    // The user leaves: the navigation goes ahead, with the normal headline and no Notice.
    const going = fake.call(a, 'browser_navigate', { tabId: tab, url: 'https://next.test' })
    await new Promise((r) => setTimeout(r, 200))
    expect(dialogs.list()).toHaveLength(1)
    dialogs.respond(dialogs.list()[0].id, { accepted: true, value: null })
    const left = await going
    expect(textOf(left)).toContain('Navigated to https://next.test')
    expect(textOf(left)).not.toContain('Leave site?')
    expect(fake.model.tabs[tab].url).toBe('https://next.test')

    // The user has not answered when the call's wait runs out: the result says so, and the
    // page is still as it was; the user's later answer runs its course.
    const waiting = await fake.call(a, 'browser_navigate', {
      tabId: tab,
      url: 'https://third.test'
    })
    expect(textOf(waiting)).toContain(
      'Did not navigate yet: the page objected ("Leave site?") and the user is being asked (the tab is in front of the user, so the user\'s rules answer it, not your policy); the tab still shows the page as it was. browser_snapshot later shows what the user chose.'
    )
    expect(fake.model.tabs[tab].url).toBe('https://next.test')
    expect(dialogs.list()).toHaveLength(1)
    dialogs.respond(dialogs.list()[0].id, { accepted: true, value: null })
    await new Promise((r) => setTimeout(r, 20))
    expect(fake.model.tabs[tab].url).toBe('https://third.test')
    expect(await next(fake, a)).not.toContain('Leave site?')
  })

  it("the policy goes with the tab (closed, let go) and with the session; a host's view hears of it", async () => {
    const fake = browser()
    const { s: a } = await named(fake, 'Invoice reconciliation')
    const tab = await openTab(fake, a, 'https://billing.test')
    const other = await openTab(fake, a, 'https://other.test')
    await policy(fake, a, { confirm: 'dismiss' })
    await policy(fake, a, { tabId: tab, confirm: 'accept' })
    await policy(fake, a, { tabId: other, prompt: 'accept' })
    expect(fake.dialogPolicies.get(tab)?.at(-1)).toEqual({
      confirm: { answer: 'accept', rule: 'tab' }
    })
    expect(fake.dialogPolicies.get(other)?.at(-1)).toEqual({
      confirm: { answer: 'dismiss', rule: 'session' },
      prompt: { answer: 'accept', rule: 'tab' }
    })
    // The user closes a tab: its own rule goes, the session-wide one stands for the rest.
    fake.user.closeTab(tab)
    expect(fake.service.dialogPolicyOf(a).tabs.has(tab)).toBe(false)
    expect(fake.service.dialogPolicyOf(a).all?.policy).toEqual({ confirm: 'dismiss' })
    // The session ends: everything goes, and the views that are left hear null.
    await fake.call(a, 'zen_session', { action: 'end' })
    expect(fake.service.dialogPolicyOf(a)).toEqual({ all: null, tabs: new Map() })
    expect(fake.dialogPolicies.get(other)?.at(-1)).toBeNull()
  })

  it('the skill tells agents about the policy in the ruled words', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const skill = await readFile(
      join(__dirname, '../../../../resources/skills/zenium-browser/SKILL.md'),
      'utf8'
    )
    expect(skill).toContain(
      'Where `browser_dialog_policy` is listed you may say ahead of an action how dialogs on a tab are to be answered (confirm OK or Cancel, a prompt\'s text, leave or stay) and the browser answers them at once from your policy - without one: alert OK, confirm Cancel, prompt Cancel, "Leave site?" leave - and every dialog it answered comes back in your next result with the page\'s words.'
    )
    expect(skill).toContain(
      'A "Leave site?" is never handed to you on either host: your policy\'s leave or stay answers it, leave by default'
    )
  })
})

describe('the agent never follows the user around', () => {
  it("opens its tabs in the agents' window, whichever window the user focuses", async () => {
    const fake = browser()
    const { s: a } = await named(fake, 'Invoice reconciliation')
    await openTab(fake, a, 'https://billing.test/1')
    const other = { ...fake.win, id: 'win_2' } as unknown as ZenWindow
    const used: string[] = []
    const tabs = fake.browser.tabs as unknown as {
      createTab: (opts: unknown, w?: ZenWindow) => unknown
    }
    const create = tabs.createTab
    tabs.createTab = (opts, w) => {
      used.push(w?.id ?? '?')
      return create(opts, w)
    }
    Object.assign(fake.browser, {
      focusedWindow: () => other,
      allWindows: () => [other, fake.win]
    })
    await openTab(fake, a, 'https://billing.test/2')
    const { s: b } = await named(fake, 'PR 741 review')
    await openTab(fake, b, 'https://github.test')
    expect(used).toEqual(['win_1', 'win_1'])
  })
})

describe('soak: named agents beside a busy human, through drops, parks, stalls and a restart', () => {
  it('no call hangs and no agent ever loses, or gains, a group', async () => {
    const DEADLINE = 2000
    const STALL_DEADLINE = 150
    // No cursor animation: a click is then a few ms here, and the soak is about rounds, not pace.
    let fake = browser({}, { showCursor: false })
    fake.service.callDeadlineMs = DEADLINE
    fake.service.pageProbeMs = 20
    fake.service.dialogTtlMs = 100
    let dialogs = new PageDialogService(fake.browser)
    const NAMES = [
      'Invoice reconciliation',
      'PR 741 review',
      'Flight search Lisbon',
      'Price watch: shoes',
      'Docs audit billing',
      'Recipe collection'
    ]
    const agents: { name: string; s: AgentSession; key: string; groups: Set<string> }[] = []
    for (const name of NAMES) {
      const { s, key } = await named(fake, name)
      agents.push({ name, s, key, groups: new Set() })
    }
    let seed = 7
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const userTabs = new Set<string>()
    let calls = 0
    let hung = 0
    let stalls = 0
    const call = async (
      agent: (typeof agents)[number],
      name: string,
      args: Record<string, unknown> = {}
    ): Promise<string> => {
      calls++
      if (!fake.service.get(agent.s.id)) {
        // What the HTTP layer does for a known id after a loss: resurrect it with the token.
        const back = fake.service.resurrect(
          agent.s.id,
          {
            transport: 'http',
            token: fake.service.serverStatus().token,
            remoteAddress: '127.0.0.1',
            userAgent: 'test'
          },
          null
        )
        if (!back) throw new Error('resurrect refused')
        agent.s = back
      }
      fake.service.touch(agent.s)
      const res = await settle(fake.call(agent.s, name, args), 3000)
      if (res === 'HUNG') {
        hung++
        return ''
      }
      return textOf(res)
    }
    const check = (round: number): void => {
      for (const agent of agents) {
        for (const g of agent.groups) {
          if (!fake.model.folders[g]) continue
          const owner = fake.service.groupOwner(g)?.name ?? fake.service.heldBy(g)?.name ?? '(none)'
          expect(owner, `round ${round}: group ${g} of ${agent.name}`).toBe(agent.name)
        }
      }
      for (const id of userTabs) {
        const t = fake.model.tabs[id]
        if (t) expect(t.folderId, `round ${round}: user tab ${id}`).toBeNull()
      }
      expect(dialogs.list(), `round ${round}: a dialog reached the user`).toEqual([])
    }

    for (let round = 0; round < 360; round++) {
      // The human: browses, clicks around (agents' tabs included), closes their own tabs.
      switch (rand(5)) {
        case 0:
          userTabs.add(fake.user.openTab(`https://user.test/${round}`).id)
          break
        case 1: {
          const ids = [...userTabs].filter((id) => fake.model.tabs[id])
          if (ids.length) fake.user.closeTab(ids[rand(ids.length)])
          break
        }
        case 2: {
          const ids = Object.keys(fake.model.tabs)
          if (ids.length) fake.user.activate(ids[rand(ids.length)])
          break
        }
        case 3: {
          const spaces = fake.model.spaces
          fake.browser.tabs.switchSpace(spaces[rand(spaces.length)].id)
          break
        }
        default:
          break
      }

      const agent = agents[rand(agents.length)]
      const own = fake.service.ownedTabs(agent.s).map((t) => t.id)
      const pick = own.length ? own[rand(own.length)] : null
      switch (pick ? rand(6) : 0) {
        case 0: {
          const text = await call(agent, 'browser_tabs', {
            action: 'new',
            url: `https://${agent.name.split(' ')[0].toLowerCase()}.test/${round}`
          })
          const m = /Opened tab (tab_[\w-]+)/.exec(text)
          if (m) {
            const g = fake.model.tabs[m[1]]?.folderId
            if (g) agent.groups.add(g)
          }
          break
        }
        case 1:
          await call(agent, 'browser_snapshot', { tabId: pick })
          break
        case 2:
          // A click waits for the page to settle; a read is instant. Both drive the page.
          if (round % 8 === 0)
            await call(agent, 'browser_click', { tabId: pick, target: 'text=Go' })
          else await call(agent, 'browser_read_page', { tabId: pick })
          break
        case 3:
          await call(agent, 'zen_groups', { action: 'list', scope: 'all' })
          break
        case 4: {
          // Another agent tries to take this one's group, with force.
          const thief = agents[(agents.indexOf(agent) + 1) % agents.length]
          const g = fake.model.tabs[pick!]?.folderId
          if (g) await call(thief, 'zen_groups', { action: 'adopt', groupId: g, force: true })
          break
        }
        default:
          await call(agent, 'zen_status')
      }

      // Disruptions.
      if (round % 23 === 11) {
        // The connection drops; the client reconnects afresh and resumes with its key.
        const victim = agents[rand(agents.length)]
        fake.service.close(victim.s.id)
        victim.s = await reconnect(fake)
        await call(victim, 'zen_session', { action: 'resume', key: victim.key })
      }
      if (round % 31 === 17) {
        // An hour of silence for one agent: parked, then back.
        const idle = agents[rand(agents.length)]
        idle.s.lastActiveAt = Date.now() - 61 * 60 * 1000
        sweep(fake)
      }
      if (round % 41 === 29 && pick) {
        // A page stops answering mid-call.
        fake.hold(pick)
        fake.service.callDeadlineMs = STALL_DEADLINE
        const before = fake.service.diagnosticsSnapshot().calls.timedOut
        await call(agent, 'browser_snapshot', { tabId: pick })
        fake.service.callDeadlineMs = DEADLINE
        stalls += fake.service.diagnosticsSnapshot().calls.timedOut - before
      }
      if (round % 37 === 5 && pick) {
        // A page opens a dialog; its agent answers it (or the timeout does).
        const answered = dialogs.ask(pick, {
          kind: 'confirm',
          message: `round ${round}`,
          defaultValue: '',
          frameUrl: 'https://x.test/',
          pageUrl: 'https://x.test/'
        })
        if (rand(2)) await call(agent, 'browser_handle_dialog', { tabId: pick, accept: true })
        expect(await settle(answered, 1000)).not.toBe('HUNG')
      }
      if (round === 180) {
        // The browser restarts; every client carries on with its old session id.
        await fake.service.flushClaims()
        const next = fake.restart()
        live.push(next)
        fake = next
        fake.service.callDeadlineMs = DEADLINE
        fake.service.pageProbeMs = 20
        fake.service.dialogTtlMs = 100
        dialogs = new PageDialogService(fake.browser)
      }
      check(round)
    }

    expect(hung).toBe(0)
    expect(stalls).toBeGreaterThan(3)
    expect(calls).toBeGreaterThan(360)
    for (const agent of agents) {
      expect(fake.service.claimOf(agent.s)?.name ?? fake.service.get(agent.s.id)?.name).toBe(
        agent.name
      )
      expect(agent.groups.size).toBeGreaterThan(0)
    }
    const d = fake.service.diagnosticsSnapshot()
    expect(d.calls.inFlight).toBe(0)
  }, 60_000)
})
