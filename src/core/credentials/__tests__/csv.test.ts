import { describe, expect, it } from 'vitest'
import { CHROME_HEADER, csvField, parseCsv, parseImport, serializeCsv, toChromeCsv } from '../csv'
import { credential } from './fakes'

describe('CSV parsing', () => {
  it('follows RFC 4180: quotes, doubled quotes, embedded separators and newlines', () => {
    const rows = parseCsv('a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n')
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2']
    ])
  })

  it('tolerates a BOM, LF endings, a missing trailing newline and blank lines', () => {
    expect(parseCsv('\uFEFFa,b\n1,2\n\n3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4']
    ])
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('\n\n')).toEqual([])
  })

  it('keeps empty fields in place', () => {
    expect(parseCsv('a,,c\n,,\n')).toEqual([['a', '', 'c']])
    expect(parseCsv('a,,\n')).toEqual([['a', '', '']])
  })

  it('quotes what needs quoting when writing', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('with,comma')).toBe('"with,comma"')
    expect(csvField('with "quote"')).toBe('"with ""quote"""')
    expect(csvField('multi\nline')).toBe('"multi\nline"')
    expect(csvField(' padded ')).toBe('" padded "')
    expect(
      serializeCsv([
        ['a', 'b'],
        ['1,2', '']
      ])
    ).toBe('a,b\r\n"1,2",\r\n')
  })
})

describe('import formats', () => {
  it('reads a Chrome or Edge export', () => {
    const text = [
      'name,url,username,password,note',
      'example.com,https://example.com/login,ada,pw-ada,work account',
      'shop,https://shop.example/,bob,"p,w""x",',
      'nopass,https://nopass.example/,carol,,',
      ''
    ].join('\n')
    const parsed = parseImport(text)
    expect(parsed.format).toBe('chrome')
    expect(parsed.invalid).toBe(1)
    expect(parsed.rows).toEqual([
      {
        url: 'https://example.com/login',
        username: 'ada',
        password: 'pw-ada',
        notes: 'work account'
      },
      { url: 'https://shop.example/', username: 'bob', password: 'p,w"x', notes: '' }
    ])
  })

  it('reads a Firefox export with realms and timestamps', () => {
    const text = [
      '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"',
      '"https://example.com","ada","pw-ada",,"https://example.com","{1}","1700000000000","1700000001000","1700000002000"',
      '"https://router.example","admin","pw-admin","Router",,"{2}","1700000000","1700000001","1700000002"',
      ''
    ].join('\r\n')
    const parsed = parseImport(text)
    expect(parsed.format).toBe('firefox')
    expect(parsed.rows).toEqual([
      {
        url: 'https://example.com',
        username: 'ada',
        password: 'pw-ada',
        notes: '',
        createdAt: 1_700_000_000_000,
        lastUsedAt: 1_700_000_001_000
      },
      {
        url: 'https://router.example',
        username: 'admin',
        password: 'pw-admin',
        notes: '',
        realm: 'Router',
        createdAt: 1_700_000_000_000,
        lastUsedAt: 1_700_000_001_000
      }
    ])
  })

  it('reads a Bitwarden export, keeping login items and the first URI', () => {
    const text = [
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
      ',,login,Example,some notes,,0,"https://example.com,https://www.example.com",ada,pw-ada,',
      ',,note,Secure note,body,,0,,,,',
      ',,login,Shop,,,0,https://shop.example,bob,pw-bob,otpauth://x',
      ''
    ].join('\n')
    const parsed = parseImport(text)
    expect(parsed.format).toBe('bitwarden')
    expect(parsed.invalid).toBe(1)
    expect(parsed.rows).toEqual([
      { url: 'https://example.com', username: 'ada', password: 'pw-ada', notes: 'some notes' },
      { url: 'https://shop.example', username: 'bob', password: 'pw-bob', notes: '' }
    ])
  })

  it('reads Safari, LastPass, KeePass and generic layouts', () => {
    const safari = parseImport(
      'Title,URL,Username,Password,Notes,OTPAuth\nExample,https://example.com,ada,pw,,\n'
    )
    expect(safari.format).toBe('safari')
    expect(safari.rows[0]).toMatchObject({
      url: 'https://example.com',
      username: 'ada',
      password: 'pw'
    })

    const lastpass = parseImport(
      'url,username,password,extra,name,grouping,fav\nhttps://example.com,ada,pw,note here,Example,Work,0\n'
    )
    expect(lastpass.format).toBe('lastpass')
    expect(lastpass.rows[0]).toMatchObject({ username: 'ada', password: 'pw', notes: 'note here' })

    const keepass = parseImport(
      '"Account","Login Name","Password","Web Site","Comments"\n"Example","ada","pw","https://example.com","c"\n'
    )
    expect(keepass.format).toBe('keepass')
    expect(keepass.rows[0]).toMatchObject({
      url: 'https://example.com',
      password: 'pw',
      notes: 'c'
    })

    const generic = parseImport('Site,Email,Pass\nexample.com,ada@example.com,pw\n')
    expect(generic.format).toBe('generic')
    expect(generic.rows[0]).toEqual({
      url: 'example.com',
      username: 'ada@example.com',
      password: 'pw',
      notes: ''
    })
  })

  it('matches header names case-insensitively and gives up without URL or password columns', () => {
    expect(parseImport('NAME,URL,USERNAME,PASSWORD,NOTE\nx,https://a.example,u,p,\n').format).toBe(
      'chrome'
    )
    expect(parseImport('name,username,password\nx,u,p\n')).toEqual({
      format: null,
      rows: [],
      invalid: 1
    })
    expect(parseImport('')).toEqual({ format: null, rows: [], invalid: 0 })
  })

  it('keeps surrounding spaces in passwords but trims everything else', () => {
    const parsed = parseImport(
      'name,url,username,password,note\n x , https://a.example , u , p , n \n'
    )
    expect(parsed.rows[0]).toEqual({
      url: 'https://a.example',
      username: 'u',
      password: ' p ',
      notes: 'n'
    })
  })
})

describe('export', () => {
  it('writes Chrome-compatible CSV that imports back identically', () => {
    const logins = [
      credential({
        origin: 'https://www.example.com',
        url: 'https://www.example.com/login',
        username: 'ada',
        password: 'p,w"1',
        notes: 'two\nlines'
      }),
      credential({
        origin: 'https://shop.example',
        url: '',
        username: 'bob',
        password: 'pw-bob',
        notes: ''
      })
    ]
    const text = toChromeCsv(logins)
    expect(text.split('\r\n')[0]).toBe(CHROME_HEADER.join(','))
    expect(text).toContain('example.com,https://www.example.com/login,ada,"p,w""1","two\nlines"')
    expect(text).toContain('shop.example,https://shop.example,bob,pw-bob,')
    const back = parseImport(text)
    expect(back.format).toBe('chrome')
    expect(back.rows).toEqual([
      {
        url: 'https://www.example.com/login',
        username: 'ada',
        password: 'p,w"1',
        notes: 'two\nlines'
      },
      { url: 'https://shop.example', username: 'bob', password: 'pw-bob', notes: '' }
    ])
  })

  it('exports an empty vault as just the header', () => {
    expect(toChromeCsv([])).toBe('name,url,username,password,note\r\n')
  })
})
