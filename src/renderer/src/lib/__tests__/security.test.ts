import { describe, expect, it } from 'vitest'
import type { PermissionRule, Tab, UIState } from '@shared/types'
import {
  blockedPopupsOf,
  currentSecurityPrompt,
  describePermissionRule,
  originOf,
  popupsAllowedFor,
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

  it('phrases known permissions after may / may not', () => {
    expect(rule('popups')).toBe('may open pop-up windows')
    expect(rule('camera', 'deny')).toBe('may not use the camera')
    expect(rule('fileSystem')).toBe('may write to files and folders you picked')
  })

  it('names the scheme of an external-app rule and the embedder of a storage-access rule', () => {
    expect(rule('openExternal:zoommtg')).toBe('may hand zoommtg: links to another app')
    expect(rule('openExternal', 'deny')).toBe('may not hand links to other apps')
    expect(rule('openExternal:package:com.example.app')).toBe('may open the app com.example.app')
    expect(rule('openExternal:intent', 'deny')).toBe(
      'may not open other apps through intent: links'
    )
    expect(rule('storage-access:https://embedder.example')).toBe(
      'may use its cookies inside embedder.example'
    )
  })

  it('falls back to the raw permission name, readable', () => {
    expect(rule('some-new_thing')).toBe('may some new thing')
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
