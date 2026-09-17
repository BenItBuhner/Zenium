// eslint-disable-next-line no-restricted-imports
import { readdirSync, readFileSync } from 'node:fs'
// eslint-disable-next-line no-restricted-imports
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  domainOf,
  hostMatchesDomain,
  hostnameOf,
  isThirdParty,
  publicSuffixTables,
  registrableDomain
} from '../domain'

describe('hostnameOf', () => {
  it('extracts lowercased hostnames without ports, credentials or trailing dots', () => {
    expect(hostnameOf('https://WWW.Example.com/path?q=1#h')).toBe('www.example.com')
    expect(hostnameOf('http://user:pw@host.example:8080/')).toBe('host.example')
    expect(hostnameOf('https://host.example.')).toBe('host.example')
    expect(hostnameOf('https://[::1]:3000/x')).toBe('[::1]')
    expect(hostnameOf('wss://socket.example')).toBe('socket.example')
    expect(hostnameOf('about:blank')).toBeNull()
    expect(hostnameOf('data:text/plain,hi')).toBeNull()
    expect(hostnameOf('not a url')).toBeNull()
  })
})

describe('registrableDomain', () => {
  it('returns eTLD+1 for common and multi-label suffixes', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com')
    expect(registrableDomain('example.com')).toBe('example.com')
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk')
    expect(registrableDomain('shop.example.com.au')).toBe('example.com.au')
    expect(registrableDomain('bucket.s3.amazonaws.com')).toBe('bucket.s3.amazonaws.com')
    expect(registrableDomain('app.github.io')).toBe('app.github.io')
    expect(registrableDomain('x.y.example.co.xx')).toBe('example.co.xx')
  })

  it('leaves IP literals and single labels alone', () => {
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1')
    expect(registrableDomain('[::1]')).toBe('[::1]')
    expect(registrableDomain('localhost')).toBe('localhost')
    expect(registrableDomain('Example.COM.')).toBe('example.com')
  })
})

describe('hostMatchesDomain and domainOf', () => {
  it('matches a domain and its subdomains only', () => {
    expect(hostMatchesDomain('example.com', 'example.com')).toBe(true)
    expect(hostMatchesDomain('a.b.example.com', 'example.com')).toBe(true)
    expect(hostMatchesDomain('notexample.com', 'example.com')).toBe(false)
    expect(hostMatchesDomain('example.com', 'www.example.com')).toBe(false)
    expect(domainOf('https://a.b.example.org/x')).toBe('example.org')
    expect(domainOf('about:blank')).toBeNull()
  })
})

describe('the Kotlin mirror', () => {
  function findFile(dir: string, name: string): string | null {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        const hit = findFile(path, name)
        if (hit) return hit
      } else if (entry.name === name) {
        return path
      }
    }
    return null
  }

  const source = findFile(
    resolve(__dirname, '../../../../android/app/src/main/kotlin'),
    'Domains.kt'
  )
  const kotlin = source ? readFileSync(source, 'utf8') : ''

  function quotedStrings(section: string): string[] {
    return [...section.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '')
  }

  it('holds the same public suffix tables as domain.ts', () => {
    const tables = publicSuffixTables()
    const begin = kotlin.indexOf('// BEGIN MULTI_LABEL_SUFFIXES')
    const end = kotlin.indexOf('// END MULTI_LABEL_SUFFIXES')
    expect(begin).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(begin)
    expect(quotedStrings(kotlin.slice(begin, end)).sort()).toEqual([...tables.multiLabel].sort())

    const generic = /GENERIC_CC_SLDS = hashSetOf\(([^)]*)\)/.exec(kotlin)
    expect(generic).not.toBeNull()
    expect(quotedStrings(generic?.[1] ?? '').sort()).toEqual([...tables.genericCcSlds].sort())
  })
})

describe('isThirdParty', () => {
  it('compares registrable domains and treats missing initiators as first party', () => {
    expect(isThirdParty('https://cdn.example.com/a.js', 'https://www.example.com/')).toBe(false)
    expect(isThirdParty('https://tracker.example/a.js', 'https://www.example.com/')).toBe(true)
    expect(isThirdParty('https://a.example.co.uk/', 'https://b.example.co.uk/')).toBe(false)
    expect(isThirdParty('https://a.example/', undefined)).toBe(false)
    expect(isThirdParty('https://a.example/', 'chrome-extension://abc/page.html')).toBe(true)
    expect(isThirdParty('https://a.example/', 'about:blank')).toBe(true)
  })
})
