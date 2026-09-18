import { describe, expect, it } from 'vitest'
import {
  ERROR_EXTRA_IMAGE,
  ERROR_INVALID_PROGRESS,
  ERROR_MISSING_REQUIRED
} from '@core/extensions/api/notifications'
import { notificationEvent } from '../extensionNotifications'
import {
  type Harness,
  ID,
  backgroundUp,
  call,
  events,
  harness,
  manifest,
  record
} from './runtimeHarness'

const basic = {
  type: 'basic',
  iconUrl: 'icon.png',
  title: 'Hello',
  message: 'World'
}

async function withNotifications(h: Harness): Promise<void> {
  await h.runtime.attach(
    record(h, {}, manifest({ permissions: ['notifications', 'storage'], name: 'Notifier' }))
  )
  backgroundUp(h, 'bg1', [
    'notifications.onClicked',
    'notifications.onButtonClicked',
    'notifications.onClosed'
  ])
}

function shown(h: Harness, id: string): Record<string, unknown> | undefined {
  return h.kt.notifications.get(`${ID}/${id}`)
}

describe('chrome.notifications on the system shade', () => {
  it('creates a basic notification on the extension channel with the flattened fields', async () => {
    const h = harness()
    await withNotifications(h)
    const reply = await call(h, 'bg1', 'notifications', 'create', ['n1', basic])
    expect(reply.ok).toBe(true)
    expect(reply.result).toBe('n1')
    expect(shown(h, 'n1')).toEqual({
      notificationId: 'n1',
      extensionName: 'Notifier',
      title: 'Hello',
      body: 'World',
      subText: '',
      iconUrl: 'icon.png',
      imageUrl: null,
      progress: null,
      buttons: [],
      silent: false,
      priority: 0,
      eventTime: null
    })
    const all = await call(h, 'bg1', 'notifications', 'getAll', [])
    expect(all.result).toEqual({ n1: true })
  })

  it('hands out an id when the extension names none and accepts the bare (options) form', async () => {
    const h = harness()
    await withNotifications(h)
    const a = await call(h, 'bg1', 'notifications', 'create', [undefined, basic])
    const b = await call(h, 'bg1', 'notifications', 'create', [basic])
    expect(typeof a.result).toBe('string')
    expect(typeof b.result).toBe('string')
    expect(a.result).not.toBe(b.result)
    expect(h.kt.notifications.size).toBe(2)
  })

  it("applies Chrome's option rules", async () => {
    const h = harness()
    await withNotifications(h)
    const missing = await call(h, 'bg1', 'notifications', 'create', ['x', { title: 'no type' }])
    expect(missing.ok).toBe(false)
    expect(missing.error).toBe(ERROR_MISSING_REQUIRED)
    const image = await call(h, 'bg1', 'notifications', 'create', [
      'x',
      { ...basic, imageUrl: 'hero.png' }
    ])
    expect(image.error).toBe(ERROR_EXTRA_IMAGE)
    const progress = await call(h, 'bg1', 'notifications', 'create', [
      'x',
      { ...basic, type: 'progress', progress: 120 }
    ])
    expect(progress.error).toBe(ERROR_INVALID_PROGRESS)
    const tooLong = await call(h, 'bg1', 'notifications', 'create', ['a'.repeat(501), basic])
    expect(String(tooLong.error)).toContain('500 characters or less')
    expect(h.kt.notifications.size).toBe(0)
  })

  it('renders list items, progress, context message, buttons, priority and silence', async () => {
    const h = harness()
    await withNotifications(h)
    await call(h, 'bg1', 'notifications', 'create', [
      'list',
      {
        type: 'list',
        iconUrl: 'icon.png',
        title: 'Inbox',
        message: 'Two new',
        contextMessage: 'mail.example',
        items: [
          { title: 'Ann', message: 'Hi' },
          { title: 'Bob', message: '' }
        ],
        buttons: [{ title: 'Open' }, { title: 'Later' }, { title: 'Dropped (max two)' }],
        priority: 2,
        silent: true,
        eventTime: 1_700_000_000_000
      }
    ])
    expect(shown(h, 'list')).toMatchObject({
      title: 'Inbox',
      body: 'Two new\nAnn: Hi\nBob',
      subText: 'mail.example',
      buttons: ['Open', 'Later'],
      priority: 2,
      silent: true,
      eventTime: 1_700_000_000_000
    })
    await call(h, 'bg1', 'notifications', 'create', [
      'dl',
      { type: 'progress', iconUrl: 'icon.png', title: 'Saving', message: 'file.zip', progress: 42 }
    ])
    expect(shown(h, 'dl')).toMatchObject({ body: 'file.zip\n42%', progress: 42 })
    await call(h, 'bg1', 'notifications', 'create', [
      'pic',
      { type: 'image', iconUrl: 'icon.png', title: 'Photo', message: 'New', imageUrl: 'hero.jpg' }
    ])
    expect(shown(h, 'pic')).toMatchObject({ imageUrl: 'hero.jpg' })
  })

  it('update merges into the shown notification in place; an unknown id is false', async () => {
    const h = harness()
    await withNotifications(h)
    await call(h, 'bg1', 'notifications', 'create', [
      'dl',
      { type: 'progress', iconUrl: 'icon.png', title: 'Saving', message: 'file.zip', progress: 10 }
    ])
    const updated = await call(h, 'bg1', 'notifications', 'update', ['dl', { progress: 80 }])
    expect(updated.result).toBe(true)
    expect(shown(h, 'dl')).toMatchObject({ title: 'Saving', progress: 80, body: 'file.zip\n80%' })
    const bad = await call(h, 'bg1', 'notifications', 'update', ['dl', { imageUrl: 'x.png' }])
    expect(bad.error).toBe(ERROR_EXTRA_IMAGE)
    const unknown = await call(h, 'bg1', 'notifications', 'update', ['nope', { title: 'x' }])
    expect(unknown.result).toBe(false)
    expect(events(h, 'bg1', 'notifications.onClosed')).toHaveLength(0)
  })

  it('clear takes it down and fires onClosed(id, false); a second clear is false', async () => {
    const h = harness()
    await withNotifications(h)
    await call(h, 'bg1', 'notifications', 'create', ['n1', basic])
    const cleared = await call(h, 'bg1', 'notifications', 'clear', ['n1'])
    expect(cleared.result).toBe(true)
    expect(shown(h, 'n1')).toBeUndefined()
    expect(events(h, 'bg1', 'notifications.onClosed').map((e) => e.args)).toEqual([['n1', false]])
    const again = await call(h, 'bg1', 'notifications', 'clear', ['n1'])
    expect(again.result).toBe(false)
    expect((await call(h, 'bg1', 'notifications', 'getAll', [])).result).toEqual({})
  })

  it('a tap is onClicked then onClosed(byUser), a button onButtonClicked then onClosed, a swipe onClosed', async () => {
    const h = harness()
    await withNotifications(h)
    await call(h, 'bg1', 'notifications', 'create', ['n1', basic])
    await call(h, 'bg1', 'notifications', 'create', ['n2', basic])
    await call(h, 'bg1', 'notifications', 'create', ['n3', basic])
    h.runtime.onNotification({ id: ID, notificationId: 'n1', event: 'clicked' })
    h.runtime.onNotification({ id: ID, notificationId: 'n2', event: 'button', index: 1 })
    h.runtime.onNotification({ id: ID, notificationId: 'n3', event: 'closed' })
    expect(events(h, 'bg1', 'notifications.onClicked').map((e) => e.args)).toEqual([['n1']])
    expect(events(h, 'bg1', 'notifications.onButtonClicked').map((e) => e.args)).toEqual([
      ['n2', 1]
    ])
    expect(events(h, 'bg1', 'notifications.onClosed').map((e) => e.args)).toEqual([
      ['n1', true],
      ['n2', true],
      ['n3', true]
    ])
    expect((await call(h, 'bg1', 'notifications', 'getAll', [])).result).toEqual({})
    // A notification that outlived the process still reports its tap.
    h.runtime.onNotification({ id: ID, notificationId: 'old', event: 'clicked' })
    expect(events(h, 'bg1', 'notifications.onClicked').map((e) => e.args)).toEqual([
      ['n1'],
      ['old']
    ])
  })

  it('getPermissionLevel is what the app may post', async () => {
    const h = harness()
    await withNotifications(h)
    expect((await call(h, 'bg1', 'notifications', 'getPermissionLevel', [])).result).toBe('granted')
    h.kt.notificationsAllowed = false
    expect((await call(h, 'bg1', 'notifications', 'getPermissionLevel', [])).result).toBe('denied')
  })

  it('detaching the extension takes its notifications and channel with it', async () => {
    const h = harness()
    await withNotifications(h)
    await call(h, 'bg1', 'notifications', 'create', ['n1', basic])
    await h.runtime.detach(ID)
    expect(h.kt.notifications.size).toBe(0)
    expect(h.kt.calledWith('ext.notifications.forget')).toEqual([{ id: ID }])
  })

  it('checks the payload Kotlin posts', () => {
    expect(notificationEvent({ id: ID, notificationId: 'n', event: 'button', index: 1 })).toEqual({
      extensionId: ID,
      notificationId: 'n',
      event: 'button',
      index: 1
    })
    expect(notificationEvent({ id: ID, notificationId: 'n', event: 'tapped' })).toBeNull()
    expect(notificationEvent({ id: ID, event: 'clicked' })).toBeNull()
    expect(notificationEvent(null)).toBeNull()
  })
})
