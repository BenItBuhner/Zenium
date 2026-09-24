import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpAuthPrompt, PermissionPrompt, PermissionRule, Tab, UIState } from '@shared/types'
import { uiStore } from '../ui'
import {
  blockedPopupsOf,
  closeQuietPrompt,
  closeSecurityPrompt,
  currentPermissionPrompt,
  currentSecurityPrompt,
  describePermissionRule,
  httpAuthSpace,
  openQuietPrompt,
  openSecurityPrompt,
  originOf,
  popupsAllowedFor,
  quietPermissionPrompt,
  siteLabel
} from '../security'

function state(patch: Partial<UIState>): UIState {
  return {
    tabs: {},
    spaces: [{ id: 's1', activeTabId: 't1', tabIds: ['t1'] }],
    activeSpaceId: 's1',
    permissionRules: [],
    blockedPopups: {},
    securityPrompts: [],
    permissionPrompts: [],
    ...patch
  } as unknown as UIState
}

const tab = { id: 't1', url: 'https://news.example/story' } as Tab

describe('origins and labels', () => {
  it('reads the origin of a page and nothing for opaque URLs', () => {
    expect(originOf('https://news.example:8443/a?b#c')).toBe('https://news.example:8443')
    expect(originOf('about:blank')).toBe(null)
    expect(originOf('not a url')).toBe(null)
  })

  it('drops the https scheme from site labels and keeps the rest', () => {
    expect(siteLabel('https://news.example')).toBe('news.example')
    expect(siteLabel('http://intranet:8080')).toBe('http://intranet:8080')
  })
})

describe('blocked pop-ups', () => {
  it('lists a tab’s blocked entries and tolerates no tab', () => {
    const s = state({
      blockedPopups: { t1: [{ url: 'https://ad.example/', at: 1, kind: 'popup' }] }
    })
    expect(blockedPopupsOf(s, 't1').length).toBe(1)
    expect(blockedPopupsOf(s, 't2')).toEqual([])
    expect(blockedPopupsOf(s, null)).toEqual([])
  })

  it('knows whether the site of a tab may open pop-ups', () => {
    const rules: PermissionRule[] = [
      { origin: 'https://news.example', permission: 'popups', decision: 'allow' }
    ]
    expect(popupsAllowedFor(state({ permissionRules: rules }), tab)).toBe(true)
    expect(popupsAllowedFor(state({ permissionRules: [] }), tab)).toBe(false)
    expect(
      popupsAllowedFor(state({ permissionRules: rules }), {
        ...tab,
        url: 'https://other.example/'
      })
    ).toBe(false)
    expect(popupsAllowedFor(state({ permissionRules: rules }), null)).toBe(false)
  })
})

describe('describePermissionRule', () => {
  const rule = (permission: string, decision: PermissionRule['decision'] = 'allow'): string =>
    describePermissionRule({ origin: 'https://a.example', permission, decision })

  it('phrases known permissions after may / may not, in sentence case', () => {
    expect(rule('popups')).toBe('May open pop-up windows')
    expect(rule('camera', 'deny')).toBe('May not use the camera')
    expect(rule('fileSystem')).toBe('May write to files and folders you picked')
    expect(rule('fileSystem:read', 'deny')).toBe('May not view the folders you picked')
  })

  it('names the scheme of an external-app rule and the embedder of a storage-access rule', () => {
    expect(rule('openExternal:zoommtg')).toBe('May hand zoommtg: links to another app')
    expect(rule('openExternal', 'deny')).toBe('May not hand links to other apps')
    expect(rule('storage-access:https://embedder.example')).toBe(
      'May use its cookies inside embedder.example'
    )
  })

  it('falls back to the raw permission name, readable', () => {
    expect(rule('some-new_thing')).toBe('May some new thing')
  })
})

describe('currentSecurityPrompt', () => {
  it('shows the active tab’s prompt or one without a tab, never another tab’s', () => {
    const s = state({
      tabs: { t1: tab },
      securityPrompts: [
        { id: 'p2', kind: 'client-certificate', tabId: 't2', host: 'h', certificates: [] },
        {
          id: 'p1',
          kind: 'http-auth',
          tabId: 't1',
          host: 'h',
          port: 443,
          realm: '',
          scheme: 'basic',
          isProxy: false,
          secure: true,
          failedBefore: false,
          username: ''
        }
      ]
    })
    expect(currentSecurityPrompt(s)?.id).toBe('p1')
    const proxy = state({
      tabs: { t1: tab },
      securityPrompts: [
        { id: 'p2', kind: 'client-certificate', tabId: 't2', host: 'h', certificates: [] },
        { id: 'p0', kind: 'client-certificate', tabId: null, host: 'h', certificates: [] }
      ]
    })
    expect(currentSecurityPrompt(proxy)?.id).toBe('p0')
    expect(currentSecurityPrompt(state({ tabs: { t1: tab } }))).toBe(null)
  })
})

describe('httpAuthSpace', () => {
  const challenge: HttpAuthPrompt = {
    id: 'p1',
    kind: 'http-auth',
    tabId: 't1',
    host: 'h',
    port: 443,
    realm: 'Staff',
    scheme: 'basic',
    isProxy: false,
    secure: true,
    failedBefore: false,
    username: ''
  }

  it('is the same for a challenge asked again (the refusal), whatever its id and scheme', () => {
    const refused = {
      ...challenge,
      id: 'p2',
      failedBefore: true,
      username: 'ann',
      scheme: 'digest'
    }
    expect(httpAuthSpace(refused)).toBe(httpAuthSpace(challenge))
  })

  it('tells realms, ports, proxies and tabs apart', () => {
    const space = httpAuthSpace(challenge)
    expect(httpAuthSpace({ ...challenge, realm: 'Admin' })).not.toBe(space)
    expect(httpAuthSpace({ ...challenge, port: 8443 })).not.toBe(space)
    expect(httpAuthSpace({ ...challenge, isProxy: true })).not.toBe(space)
    expect(httpAuthSpace({ ...challenge, tabId: 't2' })).not.toBe(space)
    expect(httpAuthSpace({ ...challenge, tabId: null })).not.toBe(space)
  })
})

describe('currentPermissionPrompt', () => {
  const prompt = (id: string, tabId: string | null): PermissionPrompt => ({
    id,
    tabId,
    origin: 'https://news.example',
    permission: 'camera',
    message: 'Allow news.example to use your camera?',
    detail: '',
    allowLabel: 'Allow',
    blockLabel: 'Block',
    allowOnce: true,
    requestedAt: 1
  })

  it('shows the active tab’s oldest prompt, or one without a tab, never another tab’s', () => {
    const s = state({
      tabs: { t1: tab },
      permissionPrompts: [prompt('q2', 't2'), prompt('q1', 't1'), prompt('q3', 't1')]
    })
    expect(currentPermissionPrompt(s)?.id).toBe('q1')
    expect(
      currentPermissionPrompt(
        state({ tabs: { t1: tab }, permissionPrompts: [prompt('q2', 't2'), prompt('q0', null)] })
      )?.id
    ).toBe('q0')
    expect(currentPermissionPrompt(state({ tabs: { t1: tab } }))).toBe(null)
  })

  it('waits while a security prompt is up on the same tab', () => {
    const s = state({
      tabs: { t1: tab },
      permissionPrompts: [prompt('q1', 't1')],
      securityPrompts: [
        { id: 'p1', kind: 'client-certificate', tabId: 't1', host: 'h', certificates: [] }
      ]
    })
    expect(currentPermissionPrompt(s)).toBe(null)
  })

  it('a quiet prompt waits in the bell on the phone until the bell names it; the desktop shows it in turn', () => {
    const quiet: PermissionPrompt = { ...prompt('q1', 't1'), permission: 'notifications', quiet: true }
    const s = state({ tabs: { t1: tab }, permissionPrompts: [quiet, prompt('q2', 't1')] })
    expect(currentPermissionPrompt(s, { quietOpenId: null })?.id).toBe('q2')
    expect(currentPermissionPrompt(s, { quietOpenId: 'q1' })?.id).toBe('q1')
    expect(currentPermissionPrompt(s)?.id).toBe('q1')
    expect(
      currentPermissionPrompt(state({ tabs: { t1: tab }, permissionPrompts: [quiet] }), {
        quietOpenId: null
      })
    ).toBe(null)
  })

  it('finds the tab’s quiet prompt for the bell, and the bell opens and closes it through the ui store', () => {
    const quiet: PermissionPrompt = { ...prompt('q1', 't1'), permission: 'notifications', quiet: true }
    const s = state({ tabs: { t1: tab }, permissionPrompts: [prompt('q0', 't1'), quiet] })
    expect(quietPermissionPrompt(s, 't1')?.id).toBe('q1')
    expect(quietPermissionPrompt(s, 't2')).toBe(null)
    expect(quietPermissionPrompt({ ...s, permissionPrompts: undefined } as unknown as UIState, 't1')).toBe(
      null
    )

    openQuietPrompt('q1')
    expect(uiStore.get().quietPromptId).toBe('q1')
    closeQuietPrompt()
    expect(uiStore.get().quietPromptId).toBe(null)
  })
})

describe('openSecurityPrompt', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    closeSecurityPrompt()
  })

  it('hides the page once the snapshot is in, and a close overtakes an open still waiting', async () => {
    vi.stubGlobal('window', { zen: { invoke: async () => null } })
    const opening = openSecurityPrompt('t1')
    closeSecurityPrompt()
    await opening
    expect(uiStore.get().securityPromptOpen).toBe(false)

    await openSecurityPrompt('t1')
    expect(uiStore.get().securityPromptOpen).toBe(true)
    closeSecurityPrompt()
    expect(uiStore.get().securityPromptOpen).toBe(false)
  })

  it('two opens in flight (the dialog mounted twice) leave the page hidden, not shown', async () => {
    vi.stubGlobal('window', { zen: { invoke: async () => null } })
    const first = openSecurityPrompt('t1')
    closeSecurityPrompt()
    const second = openSecurityPrompt('t1')
    await Promise.all([first, second])
    expect(uiStore.get().securityPromptOpen).toBe(true)
  })
})
