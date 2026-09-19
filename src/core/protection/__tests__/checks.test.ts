import { describe, expect, it } from 'vitest'
import { GSB_SEARCH_ENDPOINT } from '../../safebrowsing/gsb'
import {
  apiKeyCheckOf,
  apiKeyProbeUrl,
  base64Url,
  dnsQuery,
  RESOLVER_PROBE_NAME,
  resolverCheckOf,
  resolverProbeUrl
} from '../checks'

describe('the Safe Browsing key probe', () => {
  it('asks hashes:search for a prefix on no list with the key', () => {
    const url = new URL(apiKeyProbeUrl('  AIzaSyD-example_key  ')!)
    expect(`${url.origin}${url.pathname}`).toBe(GSB_SEARCH_ENDPOINT)
    expect(url.searchParams.get('key')).toBe('AIzaSyD-example_key')
    expect(url.searchParams.get('hashPrefixes')).toBe('AAAAAA==')
  })

  it('sends nothing for a key that is not one', () => {
    expect(apiKeyProbeUrl('')).toBeNull()
    expect(apiKeyProbeUrl('has spaces in it')).toBeNull()
    expect(apiKeyProbeUrl('a'.repeat(129))).toBeNull()
  })

  it("reads Google's refusal from the status and its message", () => {
    expect(
      apiKeyCheckOf(
        400,
        JSON.stringify({
          error: { code: 400, message: 'API key not valid. Please pass a valid API key.' }
        })
      )
    ).toEqual({
      ok: false,
      problem: 'Google rejected this key: API key not valid. Please pass a valid API key'
    })
    expect(apiKeyCheckOf(403, 'not json')).toEqual({
      ok: false,
      problem: 'Google rejected this key: the Safe Browsing API is not enabled for it'
    })
    expect(apiKeyCheckOf(400, '')).toEqual({ ok: false, problem: 'Google rejected this key' })
  })

  it('takes an answer, an empty answer and a quota reply as a key that works', () => {
    expect(apiKeyCheckOf(200, '{}')).toEqual({ ok: true })
    expect(apiKeyCheckOf(200, '{"fullHashes":[]}')).toEqual({ ok: true })
    expect(apiKeyCheckOf(429, '{"error":{"message":"Quota exceeded"}}')).toEqual({ ok: true })
    expect(apiKeyCheckOf(503, '')).toEqual({ ok: true })
  })
})

describe('the resolver probe', () => {
  it('builds an A query in wire format', () => {
    const query = dnsQuery('example.com')
    // Header: id 0, RD set, one question; then 7"example" 3"com" 0, type A, class IN.
    expect([...query.subarray(0, 12)]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0])
    expect([...query.subarray(12)]).toEqual([
      7,
      ...'example'.split('').map((c) => c.charCodeAt(0)),
      3,
      ...'com'.split('').map((c) => c.charCodeAt(0)),
      0,
      0,
      1,
      0,
      1
    ])
    expect(dnsQuery('example.com.')).toEqual(query)
  })

  it('encodes base64url without padding', () => {
    expect(base64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8')
    expect(base64Url(new Uint8Array([]))).toBe('')
  })

  it('puts the query where the template says, or appends it', () => {
    const dns = base64Url(dnsQuery(RESOLVER_PROBE_NAME))
    expect(resolverProbeUrl('https://dns.example/dns-query{?dns}')).toBe(
      `https://dns.example/dns-query?dns=${dns}`
    )
    expect(resolverProbeUrl(' https://dns.example/dns-query ')).toBe(
      `https://dns.example/dns-query?dns=${dns}`
    )
    expect(resolverProbeUrl('https://dns.example/q?profile=abc')).toBe(
      `https://dns.example/q?profile=abc&dns=${dns}`
    )
  })

  it('refuses addresses that are not a DoH template', () => {
    expect(resolverProbeUrl('http://dns.example/dns-query')).toBeNull()
    expect(resolverProbeUrl('https://user:pw@dns.example/dns-query')).toBeNull()
    expect(resolverProbeUrl('dns.example')).toBeNull()
    expect(resolverProbeUrl('https://')).toBeNull()
  })

  it('takes any 2xx as the resolver and names the status otherwise', () => {
    expect(resolverCheckOf(200)).toEqual({ ok: true })
    expect(resolverCheckOf(404)).toEqual({
      ok: false,
      problem: 'The resolver did not answer a DNS-over-HTTPS query at this address (HTTP 404)'
    })
  })
})
