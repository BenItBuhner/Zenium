import { describe, expect, it } from 'vitest'
import type { Browser } from '../browser'
import { ContentRulesService } from '../contentRules'
import { PermissionService } from '../permissions'
import type { PermissionPromptHost, StoreIO } from '../platform'
import type { ContentRules } from '../../shared/contentRules'

function fakeIo(): StoreIO {
  return {
    readSync: () => null,
    write: async () => undefined,
    writeSync: () => undefined
  }
}

const prompts: PermissionPromptHost = {
  show: async () => 'block',
  cancel: () => undefined
}

function harness(withHook = true): {
  service: ContentRulesService
  permissions: PermissionService
  pushed: ContentRules[]
} {
  const permissions = new PermissionService(fakeIo(), prompts)
  const pushed: ContentRules[] = []
  const views = withHook
    ? { setContentRules: (rules: ContentRules) => void pushed.push(rules) }
    : {}
  const browser = { permissions, platform: { views } } as unknown as Browser
  return { service: new ContentRulesService(browser), permissions, pushed }
}

describe('ContentRulesService', () => {
  it('answers the desktop from the permission store: the site, the default, the built-in default', () => {
    const { service, permissions } = harness()
    expect(service.allows('images', 'https://a.example/x')).toBe(true)
    permissions.set('images', 'https://a.example', 'deny')
    expect(service.allows('images', 'https://a.example/x')).toBe(false)
    expect(service.allows('images', 'https://b.example/x')).toBe(true)
    permissions.setDefault('javascript', 'deny')
    expect(service.allows('javascript', 'https://b.example/')).toBe(false)
    permissions.set('javascript', 'https://b.example', 'allow')
    expect(service.allows('javascript', 'https://b.example/')).toBe(true)
  })

  it('answers "download PDFs" for the request engine', () => {
    const { service, permissions } = harness()
    expect(service.allows('pdf', 'https://docs.example/a.pdf')).toBe(true)
    permissions.set('pdf', 'https://docs.example', 'deny')
    expect(service.allows('pdf', 'https://docs.example/a.pdf')).toBe(false)
  })

  it("reads a private container's own answers", () => {
    const { service, permissions } = harness()
    const details = { privateContainerId: 'private' }
    permissions.remember('images', 'https://a.example/', 'deny', details)
    expect(service.allows('images', 'https://a.example/', details)).toBe(false)
    expect(service.allows('images', 'https://a.example/')).toBe(true)
  })

  it('pushes the document to a host with the hook, once at start and once per change', () => {
    const { service, permissions, pushed } = harness()
    service.start()
    expect(pushed).toHaveLength(1)
    expect(pushed[0].images).toEqual({ default: 'allow', sites: {} })
    expect(pushed[0]['insecure-content'].default).toBe('deny')
    permissions.set('images', 'https://a.example', 'deny')
    expect(pushed).toHaveLength(2)
    expect(pushed[1].images).toEqual({ default: 'allow', sites: { 'https://a.example': 'deny' } })
    // A row that is not the document's changes nothing the host holds.
    permissions.set('geolocation', 'https://a.example', 'deny')
    expect(pushed).toHaveLength(2)
    permissions.setDefault('javascript', 'deny')
    expect(pushed[2].javascript.default).toBe('deny')
    service.stop()
    permissions.set('javascript', 'https://a.example', 'allow')
    expect(pushed).toHaveLength(3)
  })

  it('leaves a host without the hook alone', () => {
    const { service, permissions, pushed } = harness(false)
    service.start()
    permissions.set('images', 'https://a.example', 'deny')
    expect(pushed).toEqual([])
    service.stop()
  })

  it("resolves every row for a navigation at once, an extension's rule over the store's answer", () => {
    const { service, permissions } = harness()
    permissions.set('images', 'https://a.example', 'deny')
    permissions.setDefault('javascript', 'deny')
    expect(service.resolveAll('https://a.example/page')).toEqual({
      images: false,
      javascript: false,
      'insecure-content': false,
      sensors: true,
      'third-party-sign-in': true,
      'payment-handler': true
    })
    // An extension's rule (`chrome.contentSettings`, the override provider) is a function of the
    // URL the pushed document cannot carry: the resolved answer ranks it above the user's.
    permissions.setOverride((permission, url) => {
      if (!url.startsWith('https://a.example/')) return null
      if (permission === 'images') return 'allow'
      if (permission === 'sensors') return 'deny'
      return null
    })
    expect(service.resolveAll('https://a.example/page')).toMatchObject({
      images: true,
      javascript: false,
      sensors: false
    })
    expect(service.resolveAll('https://b.example/page')).toMatchObject({
      images: true,
      javascript: false,
      sensors: true
    })
    // The pushed document never sees the rule: the host that reads it alone would decide wrongly.
    expect(service.rules().images.sites['https://a.example']).toBe('deny')
    // The tab's own container is read as the desktop's handlers read it.
    permissions.remember('javascript', 'https://b.example/', 'allow', {
      privateContainerId: 'private'
    })
    expect(
      service.resolveAll('https://b.example/', { privateContainerId: 'private' }).javascript
    ).toBe(true)
    expect(service.resolveAll('https://b.example/').javascript).toBe(false)
  })

  it("pushes the unchanged document when an extension's rules change, so a host drops what it remembered", () => {
    const { service, permissions, pushed } = harness()
    expect(service.started).toBe(false)
    service.start()
    expect(service.started).toBe(true)
    expect(pushed).toHaveLength(1)
    permissions.setOverride((permission) => (permission === 'images' ? 'deny' : null))
    permissions.overridesChanged(['images'])
    expect(pushed).toHaveLength(2)
    expect(pushed[1]).toEqual(pushed[0])
    // A change of a row that is not the document's still moves nothing.
    permissions.overridesChanged(['geolocation'])
    expect(pushed).toHaveLength(2)
    // A private container's own answer is no line of the document either, and is pushed as well.
    permissions.remember('javascript', 'https://p.example/', 'deny', {
      privateContainerId: 'private'
    })
    expect(pushed).toHaveLength(3)
    expect(pushed[2]).toEqual(pushed[0])
    service.stop()
    expect(service.started).toBe(false)
  })

  it('names the guards a document is refused, private answers included', () => {
    const { service, permissions } = harness()
    expect(service.blockedGuards('https://a.example/')).toEqual([])
    permissions.set('sensors', 'https://a.example', 'deny')
    permissions.setDefault('payment-handler', 'deny')
    expect(service.blockedGuards('https://a.example/')).toEqual(['sensors', 'payment-handler'])
    expect(service.blockedGuards('https://b.example/')).toEqual(['payment-handler'])
    permissions.remember('third-party-sign-in', 'https://b.example/', 'deny', {
      privateContainerId: 'private'
    })
    expect(service.blockedGuards('https://b.example/', { privateContainerId: 'private' })).toEqual([
      'third-party-sign-in',
      'payment-handler'
    ])
  })
})
