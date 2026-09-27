import { describe, expect, it } from 'vitest'
import type { WebDavSyncCredentials } from '../../../shared/types'
import {
  WebDavError,
  WebDavTransport,
  basicAuthorization,
  classifyStatus,
  hrefPath,
  isWebDavError,
  namesInListing,
  parseMultistatus,
  webDavDocumentUrl,
  webDavFolderName,
  webDavFolderSegments,
  webDavFolderUrl,
  webDavRootUrl
} from '../webdav'
import { FakeWebDavServer, contentEtag } from './fakeWebDavServer'
import apacheFixture from './fixtures/webdav-apache-mod_dav.xml?raw'
import nextcloudFixture from './fixtures/webdav-nextcloud.xml?raw'
import sabredavFixture from './fixtures/webdav-sabredav.xml?raw'
import wsgidavFixture from './fixtures/webdav-wsgidav.xml?raw'

/**
 * The WebDAV transport (ID-32) against real servers' words and against the fake server.
 *
 * The fixtures are PROPFIND `Depth: 1` answers captured verbatim on 2026-09-27 from four servers
 * started on this machine, each holding the same directory (`Zenium/zenium-sync/` with a nested
 * collection, `a1b2c3.zensync`, `README.txt` and `odd name é.zenpage`), asked for `resourcetype`,
 * `getetag`, `getlastmodified`, `getcontentlength`:
 *  - `webdav-nextcloud.xml`: Nextcloud 35.0.1 (SQLite, PHP 8.3), the directory under
 *    `remote.php/dav/files/alice/` and an app password (`d:` with `oc:` / `nc:` namespaces, ETags
 *    as `&quot;` entities, the collections carrying ETags of their own);
 *  - `webdav-apache-mod_dav.xml`: Apache 2.4.58 mod_dav + mod_dav_fs (`D:` responses, `lp1:`
 *    properties, weak `W/` ETags, the collection's `getcontentlength` under a 404 propstat);
 *  - `webdav-sabredav.xml`: sabre/dav 4.6 on PHP 8.3 (`d:`, one line, ETags as `&quot;` entities;
 *    Nextcloud's and ownCloud's DAV is this library);
 *  - `webdav-wsgidav.xml`: WsgiDAV 4.3.5 (`ns0:` prefix, `<ns0:collection />` with a space,
 *    unquoted ETags).
 */

const NAMES = ['odd name é.zenpage', 'README.txt', 'a1b2c3.zensync']

describe('the multistatus scanner on real servers', () => {
  it.each([
    [
      'Nextcloud',
      nextcloudFixture,
      '/remote.php/dav/files/alice/Zenium/zenium-sync',
      '"c76ca5f3bf53c3ed6849aefc1e3f39fe"'
    ],
    ['Apache mod_dav', apacheFixture, '/Zenium/zenium-sync', 'W/"4-65c73660a846f"'],
    [
      'SabreDAV',
      sabredavFixture,
      '/Zenium/zenium-sync',
      '"1c90d0bc9f7d1b25f0701928dc8b80cbb07be8b7"'
    ],
    ['WsgiDAV', wsgidavFixture, '/Zenium/zenium-sync', '5450469-1790500563-4']
  ])(
    'reads %s: the directory, a nested collection, three documents',
    (_server, xml, path, oddEtag) => {
      const entries = parseMultistatus(xml)
      expect(entries).toHaveLength(5)
      const dir = entries.find((e) => hrefPath(e.href) === path)!
      expect(dir.collection).toBe(true)
      // Its length sits under a 404 propstat on every server: not a length.
      expect(dir.contentLength).toBeNull()
      expect(dir.lastModified).toMatch(/GMT$/)
      const nested = entries.find((e) => hrefPath(e.href) === `${path}/nested`)!
      expect(nested.collection).toBe(true)
      const odd = entries.find((e) => hrefPath(e.href) === `${path}/odd name é.zenpage`)!
      expect(odd.collection).toBe(false)
      expect(odd.contentLength).toBe(4)
      expect(odd.etag).toBe(oddEtag)
      expect(namesInListing(entries, `http://127.0.0.1:8080${path}/`).sort()).toEqual(
        [...NAMES].sort()
      )
    }
  )
})

describe('the multistatus scanner on what the wire may carry', () => {
  it('matches local names under any prefix, none included, and any case', () => {
    const xml =
      '<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/d/</href>' +
      '<propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat>' +
      '</response><Response><Href>/d/A.zensync</Href><PropStat><Prop><GetETag>"x"</GetETag>' +
      '<GetContentLength>12</GetContentLength></Prop><Status>HTTP/1.1 200 OK</Status></PropStat></Response>' +
      '</multistatus>'
    const entries = parseMultistatus(xml)
    expect(entries).toEqual([
      { href: '/d/', collection: true, etag: null, lastModified: null, contentLength: null },
      {
        href: '/d/A.zensync',
        collection: false,
        etag: '"x"',
        lastModified: null,
        contentLength: 12
      }
    ])
  })

  it('skips comments, processing instructions and a doctype; takes CDATA as text; decodes entities', () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE multistatus><!-- a comment <d:href>/no/</d:href> -->' +
      '<d:multistatus xmlns:d="DAV:"><?pi something?><d:response>' +
      '<d:href><![CDATA[/d/a&b.zensync]]></d:href>' +
      '<d:propstat><d:prop><d:getetag>&quot;e&#x74;ag&quot;</d:getetag>' +
      '<d:getlastmodified>Tue, 13 Oct 2015 17:07:35 GMT</d:getlastmodified></d:prop>' +
      '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
    expect(parseMultistatus(xml)).toEqual([
      {
        href: '/d/a&b.zensync',
        collection: false,
        etag: '"etag"',
        lastModified: 'Tue, 13 Oct 2015 17:07:35 GMT',
        contentLength: null
      }
    ])
  })

  it('takes properties from 2xx propstats only and drops a response without an href', () => {
    const xml =
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/d/x</d:href>' +
      '<d:propstat><d:prop><d:getetag>"old"</d:getetag></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>' +
      '<d:propstat><d:prop><d:getcontentlength>7</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>' +
      '</d:response><d:response><d:propstat><d:prop><d:getetag>"orphan"</d:getetag></d:prop>' +
      '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
    expect(parseMultistatus(xml)).toEqual([
      { href: '/d/x', collection: false, etag: null, lastModified: null, contentLength: 7 }
    ])
  })

  it('reads absolute-URL hrefs and attribute values holding angle brackets; survives a cut-off body', () => {
    const xml =
      '<d:multistatus xmlns:d="DAV:"><d:response>' +
      '<d:href>https://cloud.example.com/remote.php/dav/files/alice/Zenium/zenium-sync/a.zensync</d:href>' +
      '<d:propstat><d:prop><d:getetag title="a > b">"1"</d:getetag></d:prop>' +
      '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/cut'
    const entries = parseMultistatus(xml)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.etag).toBe('"1"')
    expect(
      namesInListing(
        entries,
        'https://cloud.example.com/remote.php/dav/files/alice/Zenium/zenium-sync/'
      )
    ).toEqual(['a.zensync'])
  })

  it('lists direct children only, by decoded name, the directory itself and collections left out', () => {
    const entries = parseMultistatus(
      '<d:multistatus xmlns:d="DAV:">' +
        '<d:response><d:href>/dav/Zenium/zenium-sync/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
        '<d:response><d:href>/dav/Zenium/zenium-sync/sub/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
        '<d:response><d:href>/dav/Zenium/zenium-sync/sub/deep.zensync</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
        '<d:response><d:href>/dav/Zenium/zenium-sync/one%20two.zenpage</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
        '<d:response><d:href>/dav/Zenium/zenium-sync/one%20two.zenpage</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
        '</d:multistatus>'
    )
    expect(namesInListing(entries, 'https://h/dav/Zenium/zenium-sync/')).toEqual([
      'one two.zenpage'
    ])
  })
})

describe('the addresses', () => {
  it('builds the directory under the root and the folder, one trailing slash, segments encoded', () => {
    const settings = {
      url: ' https://cloud.example.com/remote.php/dav/files/alice ',
      username: 'alice',
      folder: 'Zenium/Sync Folder'
    }
    expect(webDavRootUrl(settings.url)).toBe(
      'https://cloud.example.com/remote.php/dav/files/alice/'
    )
    expect(webDavFolderUrl(settings)).toBe(
      'https://cloud.example.com/remote.php/dav/files/alice/Zenium/Sync%20Folder/zenium-sync/'
    )
    expect(webDavDocumentUrl(settings, 'a b.zensync')).toBe(
      'https://cloud.example.com/remote.php/dav/files/alice/Zenium/Sync%20Folder/zenium-sync/a%20b.zensync'
    )
  })

  it('drops empty, dot and parent segments of the folder; an empty folder is the root itself', () => {
    expect(webDavFolderSegments(' /Zenium//sub/../ . /')).toEqual(['Zenium', 'sub'])
    expect(webDavFolderSegments('')).toEqual([])
    expect(webDavFolderUrl({ url: 'https://h/dav/', username: 'u', folder: '' })).toBe(
      'https://h/dav/zenium-sync/'
    )
  })

  it('names the folder as the status shows it: the last segment, or the host for the root', () => {
    expect(
      webDavFolderName({
        url: 'https://cloud.example.com/dav/',
        username: 'u',
        folder: 'Zenium/sub'
      })
    ).toBe('sub')
    expect(
      webDavFolderName({ url: 'https://cloud.example.com/dav/', username: 'u', folder: '' })
    ).toBe('cloud.example.com')
    expect(webDavFolderName({ url: 'not a url', username: 'u', folder: '' })).toBe('not a url')
  })

  it('classifies every status the engine acts on', () => {
    expect([401, 403].map(classifyStatus)).toEqual(['auth', 'auth'])
    expect(classifyStatus(404)).toBe('missing')
    expect([412, 423].map(classifyStatus)).toEqual(['conflict', 'conflict'])
    expect([500, 502, 503, 0].map(classifyStatus)).toEqual(new Array(4).fill('unavailable'))
    expect([301, 400, 405, 409, 418].map(classifyStatus)).toEqual(new Array(5).fill('refused'))
  })

  it('spells Basic as RFC 7617 does, from the UTF-8 bytes', () => {
    expect(basicAuthorization('alice', 'app-pass')).toBe('Basic YWxpY2U6YXBwLXBhc3M=')
    expect(basicAuthorization('Aladdin', 'open sesame')).toBe('Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==')
    expect(basicAuthorization('é', 'ü')).toBe(
      `Basic ${Buffer.from('é:ü', 'utf8').toString('base64')}`
    )
  })
})

const ROOT = '/remote.php/dav/files/alice'
const CREDENTIALS: WebDavSyncCredentials = {
  url: `https://cloud.test${ROOT}/`,
  username: 'alice',
  password: 'app-pass',
  folder: 'Zenium'
}
const DIR_PATH = `${ROOT}/Zenium/zenium-sync`

function server(): FakeWebDavServer {
  return new FakeWebDavServer({ roots: [ROOT], users: { alice: 'app-pass' } })
}

function transport(
  dav: FakeWebDavServer,
  credentials: WebDavSyncCredentials = CREDENTIALS,
  options: { timeoutMs?: number } = {}
): WebDavTransport {
  let n = 0
  return new WebDavTransport(credentials, dav.fetch, { ...options, random: () => `r${++n}` })
}

async function failure(promise: Promise<unknown>): Promise<WebDavError> {
  try {
    await promise
  } catch (error) {
    expect(isWebDavError(error)).toBe(true)
    return error as WebDavError
  }
  throw new Error('expected a WebDavError')
}

describe('the transport over the fake server', () => {
  it('probes the root with Depth 0 and nothing else; the folder need not exist', async () => {
    const dav = server()
    expect(await transport(dav).probe()).toEqual({ ok: true })
    expect(dav.drain()).toMatchObject([{ method: 'PROPFIND', path: ROOT, status: 207 }])
    expect(dav.log).toEqual([])
    expect(dav.collections.has(`${ROOT}/Zenium`)).toBe(false)
  })

  it('reports a refused sign-in, a wrong address and an unreachable server as the probe', async () => {
    const dav = server()
    expect(await transport(dav, { ...CREDENTIALS, password: 'nope' }).probe()).toEqual({
      ok: false,
      kind: 'auth',
      status: 401
    })
    expect(
      await transport(dav, {
        ...CREDENTIALS,
        url: 'https://cloud.test/remote.php/dav/files/bob/'
      }).probe()
    ).toEqual({ ok: false, kind: 'missing', status: 404 })
    dav.failNext = 503
    expect(await transport(dav).probe()).toEqual({ ok: false, kind: 'unavailable', status: 503 })
    dav.down = true
    expect(await transport(dav).probe()).toEqual({ ok: false, kind: 'unavailable', status: 0 })
  })

  it('lists an absent directory as empty, makes it level by level on the first write, then lists the names', async () => {
    const dav = server()
    const t = transport(dav)
    expect(await t.list()).toEqual([])
    expect(dav.drain()).toMatchObject([{ method: 'PROPFIND', path: DIR_PATH, status: 404 }])

    await t.write('dev.zensync', '{"a":1}')
    const log = dav.drain()
    expect(log.map((r) => [r.method, r.path, r.status])).toEqual([
      ['MKCOL', `${ROOT}/Zenium`, 201],
      ['MKCOL', DIR_PATH, 201],
      ['PUT', `${DIR_PATH}/dev.zensync.tmp-r1`, 201],
      ['MOVE', `${DIR_PATH}/dev.zensync.tmp-r1`, 201]
    ])
    expect(log[3]!.headers).toMatchObject({
      destination: `https://cloud.test${DIR_PATH}/dev.zensync`,
      overwrite: 'T'
    })
    expect(await t.list()).toEqual(['dev.zensync'])
    expect(dav.files(DIR_PATH)?.get('dev.zensync')).toBe('{"a":1}')

    // The second write asks for no MKCOL and replaces in one rename.
    await t.write('dev.zensync', '{"a":2}')
    expect(dav.drain().map((r) => [r.method, r.status])).toEqual([
      ['PROPFIND', 207],
      ['PUT', 201],
      ['MOVE', 204]
    ])
    expect(dav.files(DIR_PATH)?.get('dev.zensync')).toBe('{"a":2}')
    expect([...dav.files(DIR_PATH)!.keys()]).toEqual(['dev.zensync'])
  })

  it('reads with If-None-Match once it holds an ETag and answers a 304 from what it read', async () => {
    const dav = server()
    dav.mount(DIR_PATH, new Map([['dev.zensync', 'first']]))
    const t = transport(dav)
    expect(await t.read('dev.zensync')).toBe('first')
    expect(await t.read('dev.zensync')).toBe('first')
    const [one, two] = dav.drain()
    expect(one!.headers['if-none-match']).toBeUndefined()
    expect(two).toMatchObject({ headers: { 'if-none-match': contentEtag('first') }, status: 304 })

    dav.files(DIR_PATH)!.set('dev.zensync', 'second')
    expect(await t.read('dev.zensync')).toBe('second')
    expect(dav.drain()[0]).toMatchObject({ status: 200 })
    expect(await t.read('gone.zensync')).toBeNull()

    // Its own write forgets the read: the next GET is unconditional.
    await t.write('dev.zensync', 'third')
    dav.drain()
    expect(await t.read('dev.zensync')).toBe('third')
    expect(dav.drain()[0]!.headers['if-none-match']).toBeUndefined()
  })

  it('falls back to PUT in place where MOVE is refused: unconditional for a name it never saw, If-Match after', async () => {
    const dav = server()
    dav.refuseMove = 405
    dav.mount(DIR_PATH, new Map([['other.zensync', 'theirs']]))
    const t = transport(dav)

    await t.write('mine.zensync', 'v1')
    expect(dav.drain().map((r) => [r.method, r.path, r.status, r.headers['if-match']])).toEqual([
      // The mount made the folders: 405 says so, and is taken as made.
      ['MKCOL', `${ROOT}/Zenium`, 405, undefined],
      ['MKCOL', DIR_PATH, 405, undefined],
      ['PUT', `${DIR_PATH}/mine.zensync.tmp-r1`, 201, undefined],
      ['MOVE', `${DIR_PATH}/mine.zensync.tmp-r1`, 405, undefined],
      ['DELETE', `${DIR_PATH}/mine.zensync.tmp-r1`, 204, undefined],
      ['PUT', `${DIR_PATH}/mine.zensync`, 201, undefined]
    ])
    expect(t.moveRefused).toBe(true)
    expect([...dav.files(DIR_PATH)!.keys()].sort()).toEqual(['mine.zensync', 'other.zensync'])

    // From now on no temp file; the ETag the PUT answered with guards the next one.
    await t.write('mine.zensync', 'v2')
    expect(dav.drain()).toMatchObject([
      {
        method: 'PUT',
        path: `${DIR_PATH}/mine.zensync`,
        status: 204,
        headers: { 'if-match': contentEtag('v1') }
      }
    ])

    // A document it read is replaced only as it last saw it.
    expect(await t.read('other.zensync')).toBe('theirs')
    await t.write('other.zensync', 'mine now')
    expect(dav.drain().at(-1)).toMatchObject({
      status: 204,
      headers: { 'if-match': contentEtag('theirs') }
    })

    // Someone else wrote in between: a conflict, and the server's copy stands.
    dav.files(DIR_PATH)!.set('mine.zensync', 'someone else')
    const error = await failure(t.write('mine.zensync', 'v3'))
    expect(error).toMatchObject({ kind: 'conflict', status: 412, method: 'PUT' })
    expect(dav.files(DIR_PATH)!.get('mine.zensync')).toBe('someone else')
  })

  it('treats a 501 for MOVE the same way and any other MOVE failure as the error it is', async () => {
    const dav = server()
    dav.refuseMove = 501
    const t = transport(dav)
    await t.write('a.zensync', 'x')
    expect(t.moveRefused).toBe(true)
    expect(dav.files(DIR_PATH)!.get('a.zensync')).toBe('x')

    const other = server()
    other.mount(DIR_PATH, new Map())
    const u = transport(other)
    other.locked = true
    const error = await failure(u.write('a.zensync', 'x'))
    expect(error).toMatchObject({ kind: 'conflict', status: 423, method: 'PUT' })
    other.locked = false
    // Nothing of the failed write stays behind; MOVE is still trusted.
    expect(u.moveRefused).toBe(false)
    await u.write('a.zensync', 'y')
    expect([...other.files(DIR_PATH)!.entries()]).toEqual([['a.zensync', 'y']])
  })

  it('removes a document (a missing one is done) and the whole directory', async () => {
    const dav = server()
    const t = transport(dav)
    await t.write('a.zensync', '1')
    await t.write('b.zenpage', '2')
    await t.remove('a.zensync')
    await t.remove('a.zensync')
    expect(
      dav
        .drain()
        .filter((r) => r.method === 'DELETE')
        .map((r) => r.status)
    ).toEqual([204, 404])
    expect(await t.list()).toEqual(['b.zenpage'])
    await t.removeAll()
    expect(dav.collections.has(DIR_PATH)).toBe(false)
    expect(dav.collections.has(`${ROOT}/Zenium`)).toBe(true)
    expect(await t.list()).toEqual([])
    // The directory comes back on the next write.
    await t.write('c.zensync', '3')
    expect(await t.list()).toEqual(['c.zensync'])
  })

  it('maps every answer to the typed error the engine acts on', async () => {
    const dav = server()
    dav.mount(DIR_PATH, new Map([['a.zensync', 'x']]))
    const t = transport(dav)
    const cases: Array<[number, string]> = [
      [401, 'auth'],
      [403, 'auth'],
      [412, 'conflict'],
      [423, 'conflict'],
      [500, 'unavailable'],
      [502, 'unavailable'],
      [418, 'refused']
    ]
    for (const [status, kind] of cases) {
      dav.failNext = status
      const error = await failure(t.list())
      expect(error).toMatchObject({ kind, status, method: 'PROPFIND', name: 'WebDavError' })
      expect(error.message).toBe(`WebDAV PROPFIND answered ${status}`)
    }
    // A 404 is an absence where an absence is an answer (a GET, a listing, a DELETE) and
    // `missing` where it is not (the folder to make the directory in).
    dav.failNext = 404
    expect(await t.read('a.zensync')).toBeNull()
    dav.failNext = 404
    expect(await t.list()).toEqual([])
    dav.failNext = 404
    await t.remove('a.zensync')
    dav.failNext = 404
    expect(await failure(t.write('b.zensync', 'y'))).toMatchObject({
      kind: 'missing',
      status: 404,
      method: 'MKCOL'
    })
    dav.down = true
    const network = await failure(t.read('a.zensync'))
    expect(network).toMatchObject({ kind: 'unavailable', status: 0, method: 'GET' })
  })

  it('gives up on a server that never answers, within the timeout, as unavailable', async () => {
    const dav = server()
    dav.hang = true
    const t = transport(dav, CREDENTIALS, { timeoutMs: 20 })
    const error = await failure(t.list())
    expect(error).toMatchObject({ kind: 'unavailable', status: 0, method: 'PROPFIND' })
    expect(error.message).toBe('WebDAV PROPFIND: no response within 20 ms')
  })

  it('sends one Authorization header, built once, and never lets it or the address into a message', async () => {
    const dav = server()
    const t = transport(dav)
    await t.write('a.zensync', 'x')
    await t.read('a.zensync')
    await t.list()
    const authorizations = new Set(dav.drain().map((r) => r.headers['authorization']))
    expect([...authorizations]).toEqual(['Basic YWxpY2U6YXBwLXBhc3M='])

    dav.down = true
    const network = await failure(t.list())
    expect(network.message).toBe('WebDAV PROPFIND: fetch failed: <url> refused the connection')
    dav.down = false
    dav.failNext = 401
    const auth = await failure(t.list())
    for (const message of [network.message, auth.message]) {
      expect(message).not.toContain('app-pass')
      expect(message).not.toContain('alice')
      expect(message).not.toContain('YWxpY2U6YXBwLXBhc3M=')
      expect(message).not.toContain('cloud.test')
    }
  })

  it('refuses a name that would leave the directory', async () => {
    const t = transport(server())
    for (const name of ['', '.', '..', 'a/b', 'a\\b'])
      await expect(t.read(name)).rejects.toThrow('invalid sync document name')
  })
})
