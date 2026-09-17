import { describe, expect, it } from 'vitest'
import {
  classifyExternalUrl,
  intentFallbackUrl,
  intentPackage,
  schemeOf
} from '../externalProtocols'

describe('schemeOf', () => {
  it('reads the scheme case-insensitively and ignores surrounding space', () => {
    expect(schemeOf('MailTo:someone@example.com')).toBe('mailto')
    expect(schemeOf('  tel:+123 ')).toBe('tel')
    expect(schemeOf('intent://scan/#Intent;scheme=zxing;end')).toBe('intent')
    expect(schemeOf('android-app://com.example')).toBe('android-app')
  })

  it('has none for relative or malformed input', () => {
    expect(schemeOf('/path/only')).toBeNull()
    expect(schemeOf('1abc:foo')).toBeNull()
    expect(schemeOf('')).toBeNull()
  })
})

describe('classifyExternalUrl', () => {
  it('keeps the web in the browser', () => {
    expect(classifyExternalUrl('https://example.com')).toEqual({ kind: 'web', scheme: 'https' })
    expect(classifyExternalUrl('HTTP://example.com')).toEqual({ kind: 'web', scheme: 'http' })
  })

  it('hands the everyday schemes to another app, remembered per scheme', () => {
    expect(classifyExternalUrl('mailto:a@b.c')).toEqual({
      kind: 'external',
      scheme: 'mailto',
      label: 'email address',
      canRemember: true
    })
    expect(classifyExternalUrl('tel:+4912345')).toMatchObject({
      scheme: 'tel',
      label: 'phone number'
    })
    expect(classifyExternalUrl('sms:+4912345?body=hi')).toMatchObject({ label: 'text message' })
    expect(classifyExternalUrl('market://details?id=app')).toMatchObject({
      label: 'Play Store listing',
      canRemember: true
    })
  })

  it('treats unknown custom schemes as external without a label', () => {
    expect(classifyExternalUrl('spotify:track:123')).toEqual({
      kind: 'external',
      scheme: 'spotify',
      label: null,
      canRemember: true
    })
  })

  it('never offers to remember intent links, whose target changes per link', () => {
    expect(classifyExternalUrl('intent://scan/#Intent;scheme=zxing;package=com.x;end')).toEqual({
      kind: 'external',
      scheme: 'intent',
      label: 'app link',
      canRemember: false
    })
    expect(classifyExternalUrl('android-app://com.example/https/example.com')).toMatchObject({
      canRemember: false
    })
  })

  it('blocks schemes that reach the browser or the device itself', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'content://media/external/images/1',
      'zen://settings',
      'about:blank',
      'data:text/html,hi',
      'blob:https://example.com/x',
      'chrome://flags',
      'view-source:https://example.com',
      'no scheme at all'
    ]) {
      expect(classifyExternalUrl(url).kind, url).toBe('blocked')
    }
  })
})

describe('intentFallbackUrl', () => {
  it('reads the browser fallback of an intent URL', () => {
    expect(
      intentFallbackUrl(
        'intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;S.browser_fallback_url=https%3A%2F%2Fzxing.org;end'
      )
    ).toBe('https://zxing.org')
  })

  it('ignores fallbacks that are not web addresses, and other schemes', () => {
    expect(
      intentFallbackUrl(
        'intent://x/#Intent;scheme=y;S.browser_fallback_url=javascript%3Aalert(1);end'
      )
    ).toBeNull()
    expect(intentFallbackUrl('intent://x/#Intent;scheme=y;end')).toBeNull()
    expect(intentFallbackUrl('https://example.com/?S.browser_fallback_url=https://x')).toBeNull()
  })
})

describe('intentPackage', () => {
  it('reads the app an intent URL names', () => {
    expect(
      intentPackage(
        'intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;end'
      )
    ).toBe('com.google.zxing.client.android')
    expect(
      intentPackage('intent://x/#Intent;package=com.x;S.browser_fallback_url=https%3A%2F%2Fx;end')
    ).toBe('com.x')
  })

  it('has none for intents without a package, or other schemes', () => {
    expect(intentPackage('intent://x/#Intent;scheme=y;end')).toBeNull()
    expect(intentPackage('market://details?id=com.x')).toBeNull()
  })
})
