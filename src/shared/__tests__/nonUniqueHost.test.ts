import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isNonUniqueHost, nonUniqueHostTables, parseIpv4, parseIpv6 } from '../nonUniqueHost'

describe('isNonUniqueHost', () => {
  it('names loopback: localhost, every *.localhost, 127/8 and [::1]', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'localhost.',
      'dev.localhost',
      'a.b.localhost',
      '127.0.0.1',
      '127.1.2.3',
      '[::1]',
      '::1',
      '[0:0:0:0:0:0:0:1]',
      '[::ffff:127.0.0.1]'
    ])
      expect(isNonUniqueHost(host), host).toBe(true)
  })

  it('names the IPv4 blocks that are not publicly routable, and no others', () => {
    for (const host of [
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1',
      '100.127.255.254',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '239.255.255.255',
      '240.0.0.1',
      '255.255.255.255'
    ])
      expect(isNonUniqueHost(host), host).toBe(true)
    for (const host of [
      '1.1.1.1',
      '8.8.8.8',
      '9.255.255.255',
      '11.0.0.1',
      '100.63.255.255',
      '100.128.0.1',
      '126.255.255.255',
      '128.0.0.1',
      '169.253.1.1',
      '169.255.1.1',
      '172.15.255.255',
      '172.32.0.1',
      '192.0.1.1',
      '192.0.3.1',
      '192.88.98.1',
      '192.167.1.1',
      '192.169.1.1',
      '198.17.255.255',
      '198.20.0.1',
      '198.51.101.1',
      '203.0.112.1',
      '223.255.255.255'
    ])
      expect(isNonUniqueHost(host), host).toBe(false)
  })

  it('names the IPv6 blocks that are not publicly routable, bracketed or not, and no others', () => {
    for (const host of [
      '[::]',
      '[::1]',
      '[100::1]',
      '[2001:db8::1]',
      '[2001:DB8:0:0:0:0:0:1]',
      '[fc00::1]',
      '[fd12:3456:789a::1]',
      '[fe80::1]',
      '[fe80::1%25eth0]',
      'fe80::1%eth0',
      '[febf::1]',
      '[fec0::1]',
      '[ff02::1]',
      // IPv4-mapped and NAT64 addresses answer for the IPv4 address they carry.
      '[::ffff:10.0.0.1]',
      '[::ffff:a00:1]',
      '[::ffff:192.168.0.1]',
      '[64:ff9b::10.0.0.1]',
      '[64:ff9b::7f00:1]'
    ])
      expect(isNonUniqueHost(host), host).toBe(true)
    for (const host of [
      '[2606:4700:4700::1111]',
      '[2001:4860:4860::8888]',
      '[2001:db7::1]',
      '[2001:db9::1]',
      '[fbff::1]',
      '[fe00::1]',
      '[fe7f::1]',
      '[ec00::1]',
      '[::ffff:8.8.8.8]',
      '[::ffff:808:808]',
      '[64:ff9b::1.1.1.1]',
      '[100:0:0:1::1]'
    ])
      expect(isNonUniqueHost(host), host).toBe(false)
  })

  it('names single-label hosts and the suffixes no registry delegates', () => {
    for (const host of [
      'intranet',
      'INTRANET',
      'router.',
      'nas',
      'printer.local',
      'Printer.LOCAL',
      'api.service.internal',
      'staging.test',
      'host.invalid',
      'gateway.home.arpa',
      'tv.lan',
      'pc.home',
      'mail.corp',
      'wiki.intranet',
      'db.private',
      'box.localdomain'
    ])
      expect(isNonUniqueHost(host), host).toBe(true)
  })

  it('leaves public hosts alone, however local they look, and the documentation names with them', () => {
    for (const host of [
      'example.com',
      'www.example.com',
      'example.com.',
      'EXAMPLE.ORG',
      'old.example',
      'www.example',
      'localhost.com',
      'mylocal.host',
      'local.example',
      'notlocal.dev',
      'example.co.uk',
      'xn--bcher-kva.example',
      'internal-tools.example.com',
      'lan.example.net',
      'test.example.org',
      'a.b.c.d.e.example'
    ])
      expect(isNonUniqueHost(host), host).toBe(false)
  })

  it('treats what it cannot parse as unique, so a malformed host is still upgraded', () => {
    for (const host of [
      '',
      ' ',
      '.',
      '[',
      '[]',
      '300.1.1.1',
      '1.2.3',
      '1.2.3.4.5',
      '[::1',
      '[1:2:3:4:5:6:7:8:9]',
      '[::1::2]',
      '[gggg::1]',
      '[::ffff:300.1.1.1]',
      'not a host'
    ])
      expect(isNonUniqueHost(host), JSON.stringify(host)).toBe(false)
  })
})

describe('parseIpv4 and parseIpv6', () => {
  it('read dotted decimal and RFC 4291 text into bytes, refusing anything else', () => {
    expect([...(parseIpv4('192.168.0.1') ?? [])]).toEqual([192, 168, 0, 1])
    expect(parseIpv4('192.168.0')).toBeNull()
    expect(parseIpv4('192.168.0.256')).toBeNull()
    expect(parseIpv4('192.168.0.a')).toBeNull()
    expect(parseIpv4('0x7f.0.0.1')).toBeNull()

    const loopback = new Array<number>(15).fill(0).concat(1)
    expect([...(parseIpv6('::1') ?? [])]).toEqual(loopback)
    expect([...(parseIpv6('0:0:0:0:0:0:0:1') ?? [])]).toEqual(loopback)
    expect([...(parseIpv6('::ffff:192.168.0.1') ?? [])]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 168, 0, 1
    ])
    expect([...(parseIpv6('fe80::1%eth0') ?? [])].slice(0, 2)).toEqual([0xfe, 0x80])
    expect(parseIpv6('1:2:3:4:5:6:7')).toBeNull()
    expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBeNull()
    expect(parseIpv6('1::2::3')).toBeNull()
    expect(parseIpv6('::12345')).toBeNull()
    expect(parseIpv6('1.2.3.4')).toBeNull()
    expect(parseIpv6('::1.2.3.4:5')).toBeNull()
  })
})

describe('the Kotlin twin (privacy/NonUniqueHost.kt)', () => {
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
    resolve(__dirname, '../../../android/app/src/main/kotlin'),
    'NonUniqueHost.kt'
  )
  const kotlin = source ? readFileSync(source, 'utf8') : ''

  function section(name: string): string[] {
    const begin = kotlin.indexOf(`// BEGIN ${name}`)
    const end = kotlin.indexOf(`// END ${name}`)
    expect(begin, name).toBeGreaterThan(0)
    expect(end, name).toBeGreaterThan(begin)
    return [...kotlin.slice(begin, end).matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '').sort()
  }

  it('holds the same suffix and address tables', () => {
    const tables = nonUniqueHostTables()
    expect(section('NON_REGISTRABLE_SUFFIXES')).toEqual([...tables.suffixes].sort())
    expect(section('RESERVED_IPV4')).toEqual([...tables.ipv4].sort())
    expect(section('RESERVED_IPV6')).toEqual([...tables.ipv6].sort())
    expect(section('IPV4_CARRIER_IPV6')).toEqual([...tables.ipv4Carriers].sort())
  })
})
