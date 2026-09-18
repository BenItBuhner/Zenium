import { describe, expect, it } from 'vitest'
import { pickMessages } from '../extensionRuntime'
import {
  type Harness,
  makeTab,
  harness,
  ID,
  ID2,
  PATH,
  manifest,
  record,
  hello,
  message,
  nextCallId,
  until,
  call,
  events,
  backgroundUp
} from './runtimeHarness'

describe('AndroidExtensionRuntime: attaching records', () => {
  it('opens the manifest through Kotlin, plans one unit per world and starts the background', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    expect(h.kt.calledWith('ext.open')).toEqual([{ id: ID, path: PATH }])
    const configure = h.kt.calledWith('ext.configure')
    expect(configure).toHaveLength(1)
    expect(configure[0].id).toBe(ID)
    expect(configure[0].version).toBe('1.0.0')
    expect(configure[0].path).toBe(PATH)
    const units = configure[0].units as Array<Record<string, unknown>>
    expect(units.map((u) => [u.key, u.world, u.origins])).toEqual([
      ['isolated:https://example.com', `zenium-ext-${ID}`, ['https://example.com']]
    ])
    const config = JSON.parse(String(units[0].config)) as Record<string, unknown>
    expect((config.extension as Record<string, unknown>).isolation).toBe('world')
    const served = configure[0].served as Record<string, unknown>
    // The worker's page stands at the script's URL, where Chrome's `self.location` points.
    expect(served.backgroundUrl).toBe(`https://${ID}.ext.zenium.invalid/bg.js`)
    expect(String(served.backgroundHtml)).toContain('<script src="/bg.js"></script>')
    const late = JSON.parse(String(served.late)) as Record<string, unknown>
    expect(late.late).toBe(true)
    expect((late.extension as Record<string, unknown>).groups).toEqual([])
    expect(h.kt.calledWith('ext.background.start')).toEqual([{ id: ID }])
    expect(h.runtime.configureStats(ID)?.units[0].key).toBe('isolated:https://example.com')
  })

  it('falls back to the with-proxy in the main world on a WebView without isolated worlds', async () => {
    const h = harness({ isolatedWorlds: false })
    await h.runtime.attach(record(h))
    const units = h.kt.calledWith('ext.configure')[0].units as Array<Record<string, unknown>>
    expect(units[0].world).toBeNull()
    const config = JSON.parse(String(units[0].config)) as Record<string, unknown>
    expect((config.extension as Record<string, unknown>).isolation).toBe('with')
    expect(h.runtime.isolatedWorlds).toBe(false)
  })

  it('plans an extension beyond the tab world budget under the with-proxy, later ones too', async () => {
    // Two slots: the first extension takes both (content + USER_SCRIPT world), the second
    // would need one more and runs in the main world instead; a reconfigure of the first that
    // gives a world back does not disturb the second's plan.
    const h = harness({ worldSlots: 2 })
    const first = record(h, {}, manifest({ permissions: ['storage', 'userScripts', 'scripting'] }))
    await h.runtime.attach(first)
    await h.runtime.setRegistered(ID, [
      {
        id: 'us1',
        matches: ['https://example.com/*'],
        excludeMatches: [],
        includeGlobs: [],
        excludeGlobs: [],
        js: ['user.js'],
        css: [],
        runAt: 'document_idle',
        allFrames: false,
        matchAboutBlank: false,
        world: 'USER_SCRIPT',
        persistAcrossSessions: true,
        matchOriginAsFallback: false
      }
    ])
    const plansOfFirst = h.kt.calledWith('ext.configure')
    expect(plansOfFirst).toHaveLength(2)
    const worlds = (plansOfFirst[1].units as Array<Record<string, unknown>>).map((u) => u.world)
    expect(new Set(worlds).size).toBe(2)
    expect(worlds).toContain(`zenium-ext-${ID}-user`)
    const path2 = `/data/user/0/app.zen.chromium/files/zen/extensions/${ID2}/2.0.0`
    const second = record(h, { id: ID2, path: path2 }, manifest({ version: '2.0.0' }))
    await h.runtime.attach(second)
    const plan = h.kt.calledWith('ext.configure').find((c) => c.id === ID2)
    expect(plan).toBeDefined()
    const units = plan?.units as Array<Record<string, unknown>>
    expect(units).toHaveLength(1)
    expect(units[0].world).toBeNull()
    const config = JSON.parse(String(units[0].config)) as Record<string, unknown>
    expect((config.extension as Record<string, unknown>).isolation).toBe('with')
    expect(h.runtime.isolatedWorlds).toBe(true)
    // Detaching the first frees its worlds: the second is re-planned into a world when its
    // plan is next computed.
    await h.runtime.detach(ID)
    await h.runtime.setRegistered(ID2, [])
    await h.runtime.reconfigure({ ...second, pinned: true })
    const replanned = h.kt.calledWith('ext.configure').filter((c) => c.id === ID2)
    expect(replanned).toHaveLength(2)
    expect((replanned[1].units as Array<Record<string, unknown>>)[0].world).toBe(
      `zenium-ext-${ID2}`
    )
  })

  it('coalesces rule pushes: one ext.setRules in flight, one more for everything that arrived meanwhile', async () => {
    const h = harness()
    const dnr = manifest({
      permissions: ['declarativeNetRequest'],
      declarative_net_request: {
        rule_resources: [{ id: 'r1', enabled: true, path: 'rules.json' }]
      }
    })
    h.kt.holdRules = true
    const attaching = h.runtime.attach(record(h, {}, dnr))
    await until(() => h.kt.heldRules.length === 1)
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(1)
    // Three rule changes while the push is out: they wait for one push after it.
    const changes = [
      h.runtime.setRules(ID, { dynamic: [], session: [], enabledRulesets: ['r1'] }),
      h.runtime.setRules(ID, { dynamic: [], session: [], enabledRulesets: [] }),
      h.runtime.setRules(ID, { dynamic: [], session: [], enabledRulesets: ['r1'] })
    ]
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(1)
    h.kt.releaseRules()
    await until(() => h.kt.heldRules.length === 1)
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(2)
    // The second push carries the state as it is now, not as it was when a change asked.
    expect(h.kt.calledWith('ext.setRules')[1].extensions).toEqual([
      { ext: ID, allowPrivate: false, paths: ['rules.json'], dynamic: [] }
    ])
    h.kt.releaseRules()
    await Promise.all([attaching, ...changes])
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(2)
    // The line is clear: the next change pushes at once.
    h.kt.holdRules = false
    await h.runtime.setRules(ID, { dynamic: [], session: [], enabledRulesets: [] })
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(3)
    expect(h.kt.calledWith('ext.setRules')[2].extensions).toEqual([
      { ext: ID, allowPrivate: false, paths: [], dynamic: [] }
    ])
  })

  it('a record toggle alone re-sends the configuration; the private toggle re-pushes a rule set', async () => {
    const h = harness()
    const dnr = manifest({
      permissions: ['declarativeNetRequest'],
      declarative_net_request: {
        rule_resources: [{ id: 'r1', enabled: true, path: 'rules.json' }]
      }
    })
    const rec = record(h, {}, dnr)
    await h.runtime.attach(rec)
    expect(h.kt.calledWith('ext.configure')).toHaveLength(1)
    expect(h.kt.calledWith('ext.configure')[0]).toMatchObject({
      allowFileAccess: false,
      allowPrivate: false
    })
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(1)
    // The same record again: nothing changed, nothing sent.
    await h.runtime.reconfigure({ ...rec })
    expect(h.kt.calledWith('ext.configure')).toHaveLength(1)
    // File access: the plan is the same, the toggle travels.
    await h.runtime.reconfigure({ ...rec, allowFileAccess: true })
    expect(h.kt.calledWith('ext.configure')).toHaveLength(2)
    expect(h.kt.calledWith('ext.configure')[1]).toMatchObject({ allowFileAccess: true })
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(1)
    // Private tabs: the toggle travels and the rules are pushed again with it.
    await h.runtime.reconfigure({ ...rec, allowFileAccess: true, allowPrivate: true })
    expect(h.kt.calledWith('ext.configure')).toHaveLength(3)
    expect(h.kt.calledWith('ext.configure')[2]).toMatchObject({ allowPrivate: true })
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(2)
    expect(h.kt.calledWith('ext.setRules')[1].extensions).toEqual([
      { ext: ID, allowPrivate: true, paths: ['rules.json'], dynamic: [] }
    ])
  })

  it('does not send a plan that changed nothing, and re-plans when registered scripts change', async () => {
    const h = harness()
    const rec = record(h)
    await h.runtime.attach(rec)
    await h.runtime.reconfigure({ ...rec, pinned: true })
    expect(h.kt.calledWith('ext.configure')).toHaveLength(1)
    await h.runtime.setRegistered(ID, [
      {
        id: 'extra',
        matches: ['https://other.example/*'],
        excludeMatches: [],
        includeGlobs: [],
        excludeGlobs: [],
        js: ['extra.js'],
        css: [],
        runAt: 'document_idle',
        allFrames: false,
        matchAboutBlank: false,
        world: 'ISOLATED',
        persistAcrossSessions: true,
        matchOriginAsFallback: false
      }
    ])
    const plans = h.kt.calledWith('ext.configure')
    expect(plans).toHaveLength(2)
    const units = plans[1].units as Array<Record<string, unknown>>
    expect(units.map((u) => u.key)).toEqual([
      'isolated:https://example.com',
      'isolated:https://other.example'
    ])
    const saved = h.saved('extensions-runtime.json')
    expect((saved.registered as Record<string, unknown[]>)[ID]).toHaveLength(1)
  })

  it('fires runtime.onInstalled once per version when the background is ready, then onStartup', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['runtime.onInstalled', 'runtime.onStartup'])
    expect(events(h, 'bg1', 'runtime.onInstalled').map((e) => e.args)).toEqual([
      [{ reason: 'install' }]
    ])
    expect(events(h, 'bg1', 'runtime.onStartup')).toHaveLength(1)
    // The same version again (a browser restart): no install event.
    await h.runtime.detach(ID)
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg2', ['runtime.onInstalled'])
    expect(events(h, 'bg2', 'runtime.onInstalled')).toHaveLength(0)
    // A new version: update with the previous one named.
    await h.runtime.detach(ID)
    const newer = manifest({ version: '1.1.0' })
    await h.runtime.attach(
      record(h, { path: `${PATH.slice(0, -5)}1.1.0`, version: '1.1.0' }, newer)
    )
    backgroundUp(h, 'bg3', ['runtime.onInstalled'])
    expect(events(h, 'bg3', 'runtime.onInstalled').map((e) => e.args)).toEqual([
      [{ reason: 'update', previousVersion: '1.0.0' }]
    ])
  })

  it('detach drops the endpoints and tells Kotlin; forget takes the persisted state and storage along', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    hello(h, 'doc1.n.abcdefgh', 'content')
    expect(h.runtime.router.of(ID)).toHaveLength(2)
    await call(h, 'bg1', 'storage', 'set', ['local', { a: 1 }])
    expect(h.saved(`ext-storage-${ID}.json`).local).toEqual({ a: 1 })
    await h.runtime.forget(ID)
    expect(h.runtime.router.of(ID)).toHaveLength(0)
    expect(h.kt.calledWith('ext.detach')).toEqual([{ id: ID }])
    expect(h.kt.backgrounds.has(ID)).toBe(false)
    const saved = h.saved('extensions-runtime.json')
    expect(saved.installed).toEqual({})
    // No debounced write of the dropped storage document resurrects it.
    expect(h.files.has(`ext-storage-${ID}.json`)).toBe(false)
  })
})

describe('AndroidExtensionRuntime: the background lifecycle', () => {
  it('idles the worker out after the quiet time and wakes it for an event it listened for', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['tabs.onCreated'])
    expect(h.kt.backgrounds.has(ID)).toBe(true)
    h.tick(30_000)
    expect(h.kt.calledWith('ext.background.stop')).toEqual([{ id: ID }])
    h.runtime.onGone(['bg1'])
    expect(h.runtime.background.state(ID)).toBe('stopped')
    // A tab appears: the persisted listener wakes the worker and the event waits for ready.
    h.tabs.t2 = makeTab('t2', 'https://two.example/')
    h.notifyState()
    expect(h.kt.calledWith('ext.background.start')).toHaveLength(2)
    expect(h.runtime.background.state(ID)).toBe('starting')
    backgroundUp(h, 'bg2', ['tabs.onCreated'])
    const created = events(h, 'bg2', 'tabs.onCreated')
    expect(created).toHaveLength(1)
    expect((created[0].args as Array<Record<string, unknown>>)[0].url).toBe('https://two.example/')
    expect(h.runtime.backgroundStats(ID)).toMatchObject({ starts: 2, idleStops: 1, queued: 1 })
  })

  it('remembers listeners across sessions so the first event of the next start wakes the worker', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['tabs.onRemoved'])
    const saved = h.saved('extensions-runtime.json')
    expect((saved.listeners as Record<string, string[]>)[ID]).toEqual(['tabs.onRemoved'])
    // Next session, same files: the worker has not run yet, the tab closes anyway.
    const next = harness({ files: h.files })
    await next.runtime.attach(record(next))
    // Chrome starts the background after a browser start; let it idle out first.
    backgroundUp(next, 'bgA')
    next.tick(30_000)
    next.runtime.onGone(['bgA'])
    delete next.tabs.t1
    next.notifyState()
    expect(next.runtime.background.state(ID)).toBe('starting')
    backgroundUp(next, 'bgB', ['tabs.onRemoved'])
    expect(events(next, 'bgB', 'tabs.onRemoved')).toHaveLength(1)
  })

  it('drops an event a stopped worker never listened for instead of waking it', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    h.tick(30_000)
    h.runtime.onGone(['bg1'])
    h.tabs.t2 = makeTab('t2', 'https://two.example/')
    h.notifyState()
    expect(h.kt.calledWith('ext.background.start')).toHaveLength(1)
    expect(h.runtime.backgroundStats(ID)).toMatchObject({ dropped: 1 })
  })

  it('a page posting to navigator.serviceWorker wakes the stopped worker; its ports are relayed both ways and closed with it', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    h.tick(30_000)
    h.runtime.onGone(['bg1'])
    hello(h, 'pop1', 'popup', { url: `https://${ID}.ext.zenium.invalid/popup.html` })
    // A port handed to the worker with the first postMessage (Stylus's shape).
    message(h, 'pop1', { t: 'sw', op: 'post', data: { lock: '/bg.js' }, ports: ['pop1:1'] })
    expect(h.runtime.background.state(ID)).toBe('starting')
    backgroundUp(h, 'bg2')
    const arrived = h.kt.to('bg2').filter((m) => m.t === 'sw')
    expect(arrived).toEqual([
      {
        t: 'sw',
        op: 'message',
        from: 'pop1',
        url: `https://${ID}.ext.zenium.invalid/popup.html`,
        context: 'popup',
        focused: true,
        visible: true,
        data: { lock: '/bg.js' },
        ports: ['pop1:1'],
        ep: 'bg2'
      }
    ])
    // Traffic on the port follows it to the popup, and the popup's to the worker.
    message(h, 'bg2', { t: 'sw', op: 'port', port: 'pop1:1', data: { id: 1, res: 42 }, ports: [] })
    expect(h.kt.to('pop1').filter((m) => m.t === 'sw')).toEqual([
      { t: 'sw', op: 'port', port: 'pop1:1', data: { id: 1, res: 42 }, ports: [], ep: 'pop1' }
    ])
    message(h, 'pop1', { t: 'sw', op: 'port', port: 'pop1:1', data: { id: 2, args: [1] } })
    expect(h.kt.to('bg2').filter((m) => m.t === 'sw')).toHaveLength(2)
    // The worker lists its pages and posts to one, handing it a port of its own.
    message(h, 'bg2', { t: 'sw', op: 'clients', id: 9 })
    const listed = h.kt.to('bg2').find((m) => m.t === 'sw' && m.op === 'clients')
    expect(listed?.clients).toEqual([
      {
        id: 'pop1',
        url: `https://${ID}.ext.zenium.invalid/popup.html`,
        context: 'popup',
        focused: true,
        visible: true
      }
    ])
    message(h, 'bg2', { t: 'sw', op: 'post', to: 'pop1', data: { hi: 1 }, ports: ['bg2:1'] })
    expect(h.kt.to('pop1').filter((m) => m.t === 'sw' && m.op === 'message')).toEqual([
      { t: 'sw', op: 'message', data: { hi: 1 }, ports: ['bg2:1'], ep: 'pop1' }
    ])
    // A content script is no client and cannot post to the worker's pages.
    hello(h, 'doc1.n.abcdefgh', 'content')
    message(h, 'bg2', { t: 'sw', op: 'post', to: 'doc1.n.abcdefgh', data: 1, ports: [] })
    expect(h.kt.to('doc1.n.abcdefgh').filter((m) => m.t === 'sw')).toHaveLength(0)
    // The worker idles out: the popup hears that both ports are gone, and a message on one of
    // them does not start the worker again (its end died with it).
    h.tick(30_000)
    h.runtime.onGone(['bg2'])
    const closed = h.kt
      .to('pop1')
      .filter((m) => m.t === 'sw' && m.op === 'close')
      .map((m) => m.port)
    expect(closed.sort()).toEqual(['bg2:1', 'pop1:1'])
    message(h, 'pop1', { t: 'sw', op: 'port', port: 'pop1:1', data: 3 })
    expect(h.runtime.background.state(ID)).toBe('stopped')
  })

  it('a runtime.sendMessage from a content script wakes the stopped worker and is answered once it runs', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    h.tick(30_000)
    h.runtime.onGone(['bg1'])
    hello(h, 'doc1.n.abcdefgh', 'content')
    message(h, 'doc1.n.abcdefgh', { t: 'msg', id: 7, target: {}, data: { type: 'ping' } })
    expect(h.runtime.background.state(ID)).toBe('starting')
    expect(h.kt.to('doc1.n.abcdefgh').filter((m) => m.t === 'reply')).toHaveLength(0)
    backgroundUp(h, 'bg2')
    const delivered = h.kt.to('bg2').filter((m) => m.t === 'deliver')
    expect(delivered).toHaveLength(1)
    expect(delivered[0].data).toEqual({ type: 'ping' })
    expect((delivered[0].sender as Record<string, unknown>).tab).toMatchObject({
      url: 'https://example.com/'
    })
    message(h, 'bg2', {
      t: 'msgReply',
      id: delivered[0].id,
      handled: true,
      response: { pong: true }
    })
    const reply = h.kt.to('doc1.n.abcdefgh').find((m) => m.t === 'reply')
    expect(reply).toMatchObject({ id: 7, ok: true, result: { pong: true } })
  })

  it('a gone from a page the runtime already replaced does not restart the new one', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['tabs.onCreated'])
    h.tick(30_000)
    // Stopped, then woken before Kotlin reported the old page gone.
    h.tabs.t2 = makeTab('t2', 'https://two.example/')
    h.notifyState()
    expect(h.runtime.background.state(ID)).toBe('starting')
    hello(h, 'bg2', 'background')
    h.runtime.onGone(['bg1'])
    expect(h.runtime.background.state(ID)).toBe('starting')
    expect(h.kt.calledWith('ext.background.start')).toHaveLength(2)
  })

  it('an MV2 persistent page never idles out', async () => {
    const h = harness()
    const mv2 = manifest({
      manifest_version: 2,
      permissions: ['storage', 'https://example.com/*'],
      host_permissions: undefined,
      background: { scripts: ['bg.js'], persistent: true },
      action: undefined,
      browser_action: { default_popup: 'popup.html' }
    })
    await h.runtime.attach(record(h, {}, mv2))
    backgroundUp(h, 'bg1')
    h.tick(120_000)
    expect(h.kt.calledWith('ext.background.stop')).toHaveLength(0)
    expect(h.runtime.background.kind(ID)).toBe('persistent')
  })
})

describe('AndroidExtensionRuntime: chrome.storage on the shared helpers', () => {
  it('round-trips local items, persists them per extension and raises onChanged elsewhere', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['storage.onChanged'])
    hello(h, 'doc1.n.abcdefgh', 'content')
    const set = await call(h, 'doc1.n.abcdefgh', 'storage', 'set', ['local', { a: 1, b: 'two' }])
    expect(set.ok).toBe(true)
    const get = await call(h, 'doc1.n.abcdefgh', 'storage', 'get', ['local', ['a', 'missing']])
    expect(get.result).toEqual({ a: 1 })
    const changed = events(h, 'bg1', 'storage.onChanged')
    expect(changed).toHaveLength(1)
    expect(changed[0].args).toEqual([{ a: { newValue: 1 }, b: { newValue: 'two' } }, 'local'])
    const doc = h.saved(`ext-storage-${ID}.json`)
    expect(doc.local).toEqual({ a: 1, b: 'two' })
    const bytes = await call(h, 'doc1.n.abcdefgh', 'storage', 'getBytesInUse', ['local', null])
    expect(bytes.result).toBe(Buffer.byteLength('a1b"two"'))
  })

  it('enforces the sync quota and keeps the session area from content scripts until allowed', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    hello(h, 'doc1.n.abcdefgh', 'content')
    message(h, 'doc1.n.abcdefgh', { t: 'listen', event: 'storage.onChanged', on: true })
    const big = await call(h, 'bg1', 'storage', 'set', ['sync', { k: 'x'.repeat(9000) }])
    expect(big.ok).toBe(false)
    expect(String(big.error)).toContain('QUOTA_BYTES_PER_ITEM')
    const denied = await call(h, 'doc1.n.abcdefgh', 'storage', 'get', ['session', null])
    expect(denied.ok).toBe(false)
    // A session change is not announced to the content script while the area is closed to it.
    await call(h, 'bg1', 'storage', 'set', ['session', { early: true }])
    expect(events(h, 'doc1.n.abcdefgh', 'storage.onChanged')).toHaveLength(0)
    const level = await call(h, 'bg1', 'storage', 'setAccessLevel', [
      'session',
      { accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }
    ])
    expect(level.ok).toBe(true)
    await call(h, 'bg1', 'storage', 'set', ['session', { s: 1 }])
    const allowed = await call(h, 'doc1.n.abcdefgh', 'storage', 'get', ['session', null])
    expect(allowed.result).toEqual({ early: true, s: 1 })
    const heard = events(h, 'doc1.n.abcdefgh', 'storage.onChanged')
    expect(heard).toHaveLength(1)
    expect(heard[0].args).toEqual([{ s: { newValue: 1 } }, 'session'])
    // Session items never touch the disk.
    h.runtime.flushSync()
    expect(h.files.has(`ext-storage-${ID}.json`)).toBe(false)
  })

  it('chrome.extension reads the file-access and private toggles from the record', async () => {
    const h = harness()
    const rec = record(h, { allowFileAccess: true })
    await h.runtime.attach(rec)
    backgroundUp(h, 'bg1')
    const files = await call(h, 'bg1', 'extension', 'isAllowedFileSchemeAccess', [])
    expect(files.result).toBe(true)
    const incognito = await call(h, 'bg1', 'extension', 'isAllowedIncognitoAccess', [])
    expect(incognito.result).toBe(false)
    await h.runtime.reconfigure({ ...rec, allowPrivate: true })
    const allowed = await call(h, 'bg1', 'extension', 'isAllowedIncognitoAccess', [])
    expect(allowed.result).toBe(true)
  })

  it('managed is read-only and empty', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    const get = await call(h, 'bg1', 'storage', 'get', ['managed', null])
    expect(get.result).toEqual({})
    const set = await call(h, 'bg1', 'storage', 'set', ['managed', { a: 1 }])
    expect(set.ok).toBe(false)
  })
})

describe('AndroidExtensionRuntime: chrome.alarms on the shared scheduler', () => {
  it('schedules, fires onAlarm through the wake policy, repeats periodic alarms and persists them', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['alarms.onAlarm'])
    const created = await call(h, 'bg1', 'alarms', 'create', [
      'tick',
      { delayInMinutes: 1, periodInMinutes: 2 }
    ])
    expect(created.ok).toBe(true)
    const all = await call(h, 'bg1', 'alarms', 'getAll', [])
    expect((all.result as Array<Record<string, unknown>>).map((a) => a.name)).toEqual(['tick'])
    const saved = h.saved('extensions-runtime.json')
    expect((saved.alarms as Record<string, unknown[]>)[ID]).toHaveLength(1)
    // Let the worker idle out; the alarm must wake it.
    h.tick(30_000)
    h.runtime.onGone(['bg1'])
    h.tick(30_000)
    expect(h.runtime.background.state(ID)).toBe('starting')
    backgroundUp(h, 'bg2', ['alarms.onAlarm'])
    const fired = events(h, 'bg2', 'alarms.onAlarm')
    expect(fired).toHaveLength(1)
    expect((fired[0].args as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: 'tick',
      periodInMinutes: 2
    })
    const next = await call(h, 'bg2', 'alarms', 'get', ['tick'])
    expect((next.result as Record<string, unknown>).scheduledTime).toBe(h.clock.now + 2 * 60_000)
    const cleared = await call(h, 'bg2', 'alarms', 'clear', ['tick'])
    expect(cleared.result).toBe(true)
    expect(h.timers.filter((t) => !t.cleared && t.at > h.clock.now)).toHaveLength(1)
  })
})

describe('AndroidExtensionRuntime: tab and navigation events', () => {
  it('turns view events into webNavigation and tabs.onUpdated for listening pages', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['webNavigation.onCommitted', 'tabs.onUpdated', 'tabs.onActivated'])
    h.tabs.t1.loading = true
    h.runtime.onViewEvent('t1', 'navigated', {
      url: 'https://example.com/next',
      title: '',
      inPage: false,
      canGoBack: true,
      canGoForward: false
    })
    const committed = events(h, 'bg1', 'webNavigation.onCommitted')
    expect(committed).toHaveLength(1)
    expect((committed[0].args as Array<Record<string, unknown>>)[0]).toMatchObject({
      url: 'https://example.com/next',
      frameId: 0,
      transitionType: 'link'
    })
    const updated = events(h, 'bg1', 'tabs.onUpdated')
    expect(updated).toHaveLength(1)
    expect((updated[0].args as unknown[])[1]).toEqual({
      status: 'loading',
      url: 'https://example.com/next'
    })
    h.tabs.t2 = makeTab('t2', 'https://two.example/')
    h.active.id = 't2'
    h.notifyState()
    const activated = events(h, 'bg1', 'tabs.onActivated')
    expect(activated).toHaveLength(1)
    expect((activated[0].args as Array<Record<string, unknown>>)[0]).toEqual({
      tabId: h.runtime.api.tabs.chromeIdFor('t2'),
      windowId: 1
    })
  })

  it('keeps private tabs from an extension not allowed in them: no events, unknown to tabs.*', async () => {
    const h = harness()
    const rec = record(h)
    await h.runtime.attach(rec)
    backgroundUp(h, 'bg1', [
      'tabs.onCreated',
      'tabs.onUpdated',
      'tabs.onActivated',
      'tabs.onRemoved',
      'webNavigation.onCommitted',
      'webRequest.onBeforeRequest'
    ])
    h.tabs.p1 = makeTab('p1', 'https://secret.example/', 'private')
    h.active.id = 'p1'
    h.notifyState()
    expect(events(h, 'bg1', 'tabs.onCreated')).toHaveLength(0)
    expect(events(h, 'bg1', 'tabs.onActivated')).toHaveLength(0)
    h.runtime.onViewEvent('p1', 'navigated', {
      url: 'https://secret.example/page',
      title: '',
      inPage: false,
      canGoBack: true,
      canGoForward: false
    })
    expect(events(h, 'bg1', 'webNavigation.onCommitted')).toHaveLength(0)
    expect(events(h, 'bg1', 'tabs.onUpdated')).toHaveLength(0)
    h.runtime.onRequest({
      tabId: 'p1',
      url: 'https://secret.example/asset.js',
      type: 'script',
      method: 'GET',
      initiator: 'https://secret.example',
      decision: 'allow',
      micros: 1
    })
    expect(events(h, 'bg1', 'webRequest.onBeforeRequest')).toHaveLength(0)
    // The tabs API: the query does not list it, get does not know it, the window has one tab.
    const privateId = h.runtime.api.tabs.chromeIdFor('p1')
    const query = await call(h, 'bg1', 'tabs', 'query', [{}])
    expect((query.result as Array<Record<string, unknown>>).map((t) => t.id)).toEqual([
      h.runtime.api.tabs.chromeIdFor('t1')
    ])
    const active = await call(h, 'bg1', 'tabs', 'query', [{ active: true }])
    expect(active.result).toEqual([])
    const get = await call(h, 'bg1', 'tabs', 'get', [privateId])
    expect(String(get.error)).toContain(`No tab with id: ${privateId}`)
    const win = await call(h, 'bg1', 'windows', 'getCurrent', [])
    expect((win.result as { tabs: unknown[] }).tabs).toHaveLength(1)
    const inject = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId: privateId }, funcSource: '() => 1' }
    ])
    expect(String(inject.error)).toContain('No tab with id')
    expect(h.kt.calledWith('ext.exec')).toHaveLength(0)
    // Closed while unseen: no onRemoved either, though the tab is gone from the model by then.
    delete h.tabs.p1
    h.active.id = 't1'
    h.notifyState()
    expect(events(h, 'bg1', 'tabs.onRemoved')).toHaveLength(0)
    expect(events(h, 'bg1', 'tabs.onActivated')).toHaveLength(1)
    // Allowed in private tabs: the same extension sees the next one.
    await h.runtime.reconfigure({ ...rec, allowPrivate: true })
    h.tabs.p2 = makeTab('p2', 'https://secret.example/two', 'private')
    h.notifyState()
    expect(events(h, 'bg1', 'tabs.onCreated')).toHaveLength(1)
    const seen = await call(h, 'bg1', 'tabs', 'get', [h.runtime.api.tabs.chromeIdFor('p2')])
    expect(seen.result).toMatchObject({ incognito: true, url: 'https://secret.example/two' })
    delete h.tabs.p2
    h.notifyState()
    expect(events(h, 'bg1', 'tabs.onRemoved')).toHaveLength(1)
  })

  it('a navigation event landing after the new document said hello leaves its endpoints answering; Kotlin says which are gone', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    // The commit callback is posted from Kotlin and often lands after the new document's
    // bootstrap has said hello: the endpoint that hello registered must survive it.
    hello(h, 'doc2.n.abcdefgh', 'content', { url: 'https://example.com/other' })
    expect(h.runtime.router.of(ID, 'content')).toHaveLength(1)
    h.runtime.onViewEvent('t1', 'navigated', {
      url: 'https://example.com/other',
      title: '',
      inPage: false,
      canGoBack: true,
      canGoForward: false
    })
    expect(h.runtime.router.of(ID, 'content')).toHaveLength(1)
    const set = await call(h, 'doc2.n.abcdefgh', 'storage', 'set', ['local', { k: 1 }])
    expect(set.ok).toBe(true)
    // The previous document's endpoint goes when Kotlin reports it (ext.gone), not before.
    h.runtime.onGone(['doc2.n.abcdefgh'])
    expect(h.runtime.router.of(ID, 'content')).toHaveLength(0)
  })
})

describe('AndroidExtensionRuntime: scripting into frames', () => {
  it('names a subframe to the host by its document id, and all frames on allFrames', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    hello(h, 'docA.1', 'content')
    hello(h, 'docB.1', 'content', { top: false, url: 'https://frame.example/inner' })
    const tabId = h.runtime.api.tabs.chromeIdFor('t1')
    const frames = await call(h, 'bg1', 'webNavigation', 'getAllFrames', [{ tabId }])
    expect((frames.result as Array<{ frameId: number }>).map((f) => f.frameId)).toEqual([0, 1])
    // The main frame alone by default: no document named.
    const top = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId }, funcSource: '() => 1' }
    ])
    expect(top.result).toEqual([{ frameId: 0, documentId: '', result: { ran: true } }])
    expect(h.kt.calledWith('ext.exec').map((a) => a.doc)).toEqual([null])
    // One subframe: its document; the result carries its frame id.
    h.kt.files.set(`${ID}/api.js`, 'self.api = 1')
    const inner = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId, frameIds: [1] }, files: ['api.js'] }
    ])
    expect(inner.error).toBeUndefined()
    expect(inner.result).toEqual([{ frameId: 1, documentId: '', result: { ran: true } }])
    expect(h.kt.calledWith('ext.exec').at(-1)).toMatchObject({ doc: 'docB', ext: ID, tabId: 't1' })
    // Every frame the extension has a script in.
    const all = await call(h, 'bg1', 'scripting', 'insertCSS', [
      { target: { tabId, allFrames: true }, css: 'body{margin:0}' }
    ])
    expect(all.error).toBeUndefined()
    expect(
      h.kt
        .calledWith('ext.exec')
        .slice(-2)
        .map((a) => [a.kind, a.doc])
    ).toEqual([
      ['css', null],
      ['css', 'docB']
    ])
    // A frame the tab does not have: Chrome's error, nothing sent to the host.
    const before = h.kt.calledWith('ext.exec').length
    const missing = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId, frameIds: [7] }, funcSource: '() => 1' }
    ])
    expect(String(missing.error)).toBe(`No frame with id 7 in tab ${tabId}.`)
    expect(h.kt.calledWith('ext.exec')).toHaveLength(before)
    // A subframe the host cannot reach is left out under allFrames, and fails a named target.
    h.kt.failExec = (args) =>
      args.doc === 'docB' ? 'This WebView cannot run a script in a subframe' : null
    const swept = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId, allFrames: true }, funcSource: '() => 1' }
    ])
    expect(swept.error).toBeUndefined()
    expect(swept.result).toEqual([{ frameId: 0, documentId: '', result: { ran: true } }])
    const named = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId, frameIds: [1] }, funcSource: '() => 1' }
    ])
    expect(String(named.error)).toContain('cannot run a script in a subframe')
    h.kt.failExec = null
    // The frame's document went away with a navigation: the id no longer resolves.
    h.runtime.onGone(['docB.1'])
    const gone = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId, frameIds: [1] }, funcSource: '() => 1' }
    ])
    expect(String(gone.error)).toContain('No frame with id 1')
  })
})

describe('AndroidExtensionRuntime: popups and options', () => {
  it('opens the manifest popup as a sheet, or raises action.onClicked when there is none', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['action.onClicked'])
    h.runtime.openPopup(ID)
    expect(h.kt.calledWith('ext.popup.open')).toEqual([
      {
        id: ID,
        url: `https://${ID}.ext.zenium.invalid/popup.html`,
        context: 'popup',
        title: 'Runtime test'
      }
    ])
    h.runtime.closePopup()
    expect(h.kt.calledWith('ext.popup.close')).toHaveLength(1)
    await call(h, 'bg1', 'action', 'setPopup', [{ popup: '' }])
    h.runtime.openPopup(ID)
    expect(h.kt.calledWith('ext.popup.open')).toHaveLength(1)
    const clicked = events(h, 'bg1', 'action.onClicked')
    expect(clicked).toHaveLength(1)
    expect((clicked[0].args as Array<Record<string, unknown>>)[0]).toMatchObject({
      url: 'https://example.com/'
    })
    expect(h.runtime.popupFor(ID)).toBeNull()
  })

  it('options pages open as a sheet, or as a tab when the manifest asks for one', async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, manifest({ options_ui: { page: 'options.html' } })))
    h.runtime.openOptions(ID)
    expect(h.kt.calledWith('ext.popup.open')).toEqual([
      {
        id: ID,
        url: `https://${ID}.ext.zenium.invalid/options.html`,
        context: 'options',
        title: 'Runtime test'
      }
    ])
    const inTab = harness()
    await inTab.runtime.attach(
      record(inTab, {}, manifest({ options_ui: { page: 'options.html', open_in_tab: true } }))
    )
    inTab.runtime.openOptions(ID)
    expect(inTab.kt.calledWith('ext.popup.open')).toHaveLength(0)
    expect(Object.values(inTab.tabs).map((t) => t.url)).toContain(
      `https://${ID}.ext.zenium.invalid/options.html`
    )
  })
})

describe('AndroidExtensionRuntime: chrome.identity', () => {
  const REDIRECT = `https://${ID}.chromiumapp.org/`
  const PROVIDER = 'https://auth.test/authorize?client=1'

  /** Starts a `launchWebAuthFlow` from the background; the reply arrives when the flow ends. */
  function launch(
    h: Harness,
    details: Record<string, unknown>
  ): { reply: () => Record<string, unknown> | undefined } {
    const id = nextCallId()
    message(h, 'bg1', {
      t: 'call',
      id,
      ns: 'identity',
      method: 'launchWebAuthFlow',
      args: [details]
    })
    return { reply: () => h.kt.to('bg1').find((m) => m.t === 'reply' && m.id === id) }
  }

  async function withIdentity(): Promise<Harness> {
    const h = harness()
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['identity', 'storage'] })))
    backgroundUp(h, 'bg1')
    return h
  }

  it('runs an interactive flow in a tab in front and resolves with the URL Kotlin cancelled on the way back', async () => {
    const h = await withIdentity()
    const flow = launch(h, { url: PROVIDER, interactive: true })
    await until(() => h.created.length === 1)
    const tabId = h.created[0].id
    expect(h.created[0].active).toBe(true)
    expect(h.tabs[tabId].url).toBe(PROVIDER)
    expect(h.kt.calledWith('ext.authFlow')).toEqual([{ tabId, id: ID }])
    expect(h.runtime.identity.running(ID)).toBe(true)
    expect(h.runtime.identity.flowTab(ID)).toBe(tabId)

    // The provider's pages come and go; only the way back ends the flow.
    h.runtime.onViewEvent(tabId, 'navigated', {
      url: 'https://auth.test/login',
      title: '',
      canGoBack: false,
      canGoForward: false,
      inPage: false
    })
    h.runtime.onViewEvent(tabId, 'stopLoading', {
      url: 'https://auth.test/login',
      title: '',
      canGoBack: false,
      canGoForward: false
    })
    expect(flow.reply()).toBeUndefined()
    h.runtime.onIdentityRedirect({ tabId, url: `${REDIRECT}cb#access_token=abc&state=s` })
    await until(() => flow.reply() !== undefined)
    expect(flow.reply()).toMatchObject({
      ok: true,
      result: `${REDIRECT}cb#access_token=abc&state=s`
    })
    // The tab is closed and Kotlin told the flow is over.
    expect(h.tabs[tabId]).toBeUndefined()
    expect(h.kt.calledWith('ext.authFlow')).toEqual([
      { tabId, id: ID },
      { tabId, id: null }
    ])
    expect(h.runtime.identity.running(ID)).toBe(false)
  })

  it("a redirect that committed anyway (a POST) ends the flow from the tab's navigation event", async () => {
    const h = await withIdentity()
    const flow = launch(h, { url: PROVIDER, interactive: true })
    await until(() => h.created.length === 1)
    const tabId = h.created[0].id
    h.runtime.onViewEvent(tabId, 'navigated', {
      url: `${REDIRECT}?code=posted`,
      title: '',
      canGoBack: false,
      canGoForward: false,
      inPage: false
    })
    await until(() => flow.reply() !== undefined)
    expect(flow.reply()).toMatchObject({ ok: true, result: `${REDIRECT}?code=posted` })
  })

  it('a silent flow loads in the background and fails, tab closed unseen, once a page wants the user', async () => {
    const h = await withIdentity()
    const flow = launch(h, { url: PROVIDER })
    await until(() => h.created.length === 1)
    const tabId = h.created[0].id
    expect(h.created[0].active).toBe(false)
    expect(h.active.id).toBe('t1')
    h.runtime.onViewEvent(tabId, 'stopLoading', {
      url: 'https://auth.test/login',
      title: '',
      canGoBack: false,
      canGoForward: false
    })
    await until(() => flow.reply() !== undefined)
    expect(flow.reply()).toMatchObject({ ok: false, error: 'User interaction required.' })
    expect(h.tabs[tabId]).toBeUndefined()
    expect(h.active.id).toBe('t1')
    // Its timeout was cleared with it.
    expect(h.timers.filter((t) => t.ms === 60_000 && !t.cleared)).toHaveLength(0)
  })

  it('a silent flow that may load pages times out on the runtime clock', async () => {
    const h = await withIdentity()
    const flow = launch(h, {
      url: PROVIDER,
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 5_000
    })
    await until(() => h.created.length === 1)
    h.tick(5_000)
    await until(() => flow.reply() !== undefined)
    expect(flow.reply()).toMatchObject({ ok: false, error: 'The flow timed out.' })
    expect(Object.keys(h.tabs)).toEqual(['t1'])
  })

  it('the user closing the tab cancels the flow; a failed page load fails it', async () => {
    const h = await withIdentity()
    const cancelled = launch(h, { url: PROVIDER, interactive: true })
    await until(() => h.created.length === 1)
    delete h.tabs[h.created[0].id]
    h.notifyState()
    await until(() => cancelled.reply() !== undefined)
    expect(cancelled.reply()).toMatchObject({
      ok: false,
      error: 'The user did not approve access.'
    })
    expect(h.kt.calledWith('ext.authFlow').at(-1)).toEqual({ tabId: h.created[0].id, id: null })

    const failed = launch(h, { url: PROVIDER, interactive: true })
    await until(() => h.created.length === 2)
    h.runtime.onViewEvent(h.created[1].id, 'failLoad', {
      code: -105,
      description: 'ERR_NAME_NOT_RESOLVED',
      url: PROVIDER
    })
    await until(() => failed.reply() !== undefined)
    expect(failed.reply()).toMatchObject({
      ok: false,
      error: 'Authorization page could not be loaded.'
    })
  })

  it('one flow per extension at a time; detaching the extension ends it', async () => {
    const h = await withIdentity()
    const first = launch(h, { url: PROVIDER, interactive: true })
    await until(() => h.created.length === 1)
    const second = launch(h, { url: PROVIDER, interactive: true })
    await until(() => second.reply() !== undefined)
    expect(second.reply()).toMatchObject({
      ok: false,
      error: 'A web auth flow is already running for this extension.'
    })
    expect(h.created).toHaveLength(1)
    await h.runtime.detach(ID)
    await until(() => first.reply() !== undefined)
    expect(first.reply()).toMatchObject({ ok: false, error: 'The user did not approve access.' })
    expect(h.tabs[h.created[0].id]).toBeUndefined()
  })

  it('checks the details like Chrome and answers the account members without an account', async () => {
    const h = await withIdentity()
    expect(await call(h, 'bg1', 'identity', 'launchWebAuthFlow', [{ url: 'nope' }])).toMatchObject({
      ok: false,
      error: 'Invalid URL'
    })
    expect(await call(h, 'bg1', 'identity', 'launchWebAuthFlow', [{}])).toMatchObject({
      ok: false,
      error: 'Invalid details'
    })
    expect(h.created).toHaveLength(0)
    expect(await call(h, 'bg1', 'identity', 'getProfileUserInfo', [{}])).toMatchObject({
      ok: true,
      result: { email: '', id: '' }
    })
    expect(await call(h, 'bg1', 'identity', 'getAuthToken', [{}])).toMatchObject({
      ok: false,
      error: expect.stringContaining('no signed-in browser account') as string
    })
    expect(await call(h, 'bg1', 'identity', 'getAccounts', [])).toMatchObject({
      ok: true,
      result: []
    })
    expect(await call(h, 'bg1', 'identity', 'clearAllCachedAuthTokens', [])).toMatchObject({
      ok: true
    })
    expect(await call(h, 'bg1', 'identity', 'getRedirectURL', ['cb'])).toMatchObject({
      ok: true,
      result: `${REDIRECT}cb`
    })
  })
})

describe('pickMessages', () => {
  it('prefers the UI locale, then its language, then the manifest default', () => {
    const locales = {
      en: JSON.stringify({ name: { message: 'English' } }),
      de_DE: JSON.stringify({ name: { message: 'Deutsch (DE)' } }),
      de: JSON.stringify({ name: { message: 'Deutsch' } })
    }
    expect(pickMessages(locales, 'de-DE', 'en')?.name.message).toBe('Deutsch (DE)')
    expect(pickMessages(locales, 'de-AT', 'en')?.name.message).toBe('Deutsch')
    expect(pickMessages(locales, 'fr-FR', 'en')?.name.message).toBe('English')
    expect(pickMessages({}, 'fr-FR', 'en')).toBeNull()
  })
})
