import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSettings } from '../../../shared/types'
import { PageDialogService } from '../../pageDialogs'
import type { ZenWindow } from '../../window'
import type { AgentSession } from '../service'
import { CLAIMS_FILE } from '../claims'
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
    // "Leave site?" never reaches it – an agent's page leaves without a question
    // (`PageDialogService.confirmLeave`; Android's `UnloadObjection` leaves silently) – so no
    // text names it among them, and both hosts' instructions say so.
    const handleDialog = desktop.service
      .listTools(d)
      .find((t) => t.name === 'browser_handle_dialog')
    expect(handleDialog?.description).toContain('(alert, confirm or prompt)')
    expect(handleDialog?.description).not.toContain('Leave site?')
    expect(desktop.service.instructions(d)).toContain(
      'Page dialogs (alert, confirm, prompt) on your tabs'
    )
    expect(desktop.service.instructions(d)).toContain('your tab leaves without a question')

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
