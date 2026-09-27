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
      // The pages' user-facing alias: a web page must not launch the browser's own pages.
      'zenium://settings/privacy',
      'ZENIUM://settings',
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

describe('a malformed intent: URL (the shape Intent.parseUri rejects) carries nothing and never throws', () => {
  const malformed = [
    'intent:',
    'intent://',
    'intent://host',
    'intent://host#Intent;',
    'intent://host#Intent',
    // A `#Intent;` part that never reaches `end` is no intent to Android's parser.
    'intent://x#Intent;S.browser_fallback_url=https%3A%2F%2Fzxing.org%2F',
    'intent://x#Intent;package=com.x',
    'intent://x#Intent;package=com.x;S.browser_fallback_url=https%3A%2F%2Fzxing.org%2F',
    // Empty values.
    'intent://x#Intent;S.browser_fallback_url=;end',
    'intent://x#Intent;package=;end',
    // A fallback that is not http(s), or cannot be decoded.
    'intent://x#Intent;S.browser_fallback_url=javascript%3Aalert(1);end',
    'intent://x#Intent;S.browser_fallback_url=file%3A%2F%2F%2Fetc%2Fpasswd;end',
    'intent://x#Intent;S.browser_fallback_url=intent%3A%2F%2Fy%23Intent%3Bend;end',
    'intent://x#Intent;S.browser_fallback_url=zenium%3A%2F%2Fsettings;end',
    'intent://x#Intent;S.browser_fallback_url=%E0%A4%A;end',
    // A package that is no package-name token.
    'intent://x#Intent;package=com.x%3Bmalice;end',
    'intent://x#Intent;package=../evil;end',
    'intent://x#Intent;package=com.x evil;end',
    // The names outside the `#Intent;…end` part (in the data URI) are not extras.
    'intent://x;package=com.x#Intent;end',
    'intent://x?S.browser_fallback_url=https%3A%2F%2Fzxing.org%2F#Intent;end',
    'intent://x#other;package=com.x;end',
    // Junk pairs.
    'intent://x#Intent;;;end',
    'intent://x#Intent;=;end',
    'intent://x#Intent;=com.x;end',
    // Not an intent at all.
    'https://example.com/#Intent;package=com.x;end',
    ''
  ]

  it.each(malformed)('%j', (url) => {
    expect(() => intentFallbackUrl(url)).not.toThrow()
    expect(() => intentPackage(url)).not.toThrow()
    expect(intentFallbackUrl(url)).toBeNull()
    expect(intentPackage(url)).toBeNull()
  })

  it('the part is read as Intent.parseUri reads it: after the LAST #, up to `end`, the first of a repeated name, values as written', () => {
    // A `#` in the data part: the extras are after the last one.
    expect(intentPackage('intent://x/a#b#Intent;package=com.x;end')).toBe('com.x')
    // `end` closes the part; what follows is not read.
    expect(intentPackage('intent://x#Intent;end;package=com.x;end')).toBeNull()
    // `end` is matched as a prefix, as Android matches it.
    expect(intentPackage('intent://x#Intent;package=com.x;end;')).toBe('com.x')
    expect(intentPackage('intent://x#Intent;endless=1;package=com.x;end')).toBeNull()
    // The first of a repeated name counts.
    expect(intentPackage('intent://x#Intent;package=com.first;package=com.second;end')).toBe(
      'com.first'
    )
    // An unencoded fallback reads up to its `;`, as Android's does.
    expect(
      intentFallbackUrl('intent://x#Intent;S.browser_fallback_url=https://zxing.org/;end')
    ).toBe('https://zxing.org/')
    // The scheme is read case-insensitively; surrounding space is ignored.
    expect(intentPackage('  INTENT://x#Intent;package=com.x;end ')).toBe('com.x')
    // A fallback beside a package: both read, the caller prefers the fallback.
    const both =
      'intent://x#Intent;package=com.x;S.browser_fallback_url=https%3A%2F%2Fzxing.org%2Fw;end'
    expect(intentFallbackUrl(both)).toBe('https://zxing.org/w')
    expect(intentPackage(both)).toBe('com.x')
  })
})
