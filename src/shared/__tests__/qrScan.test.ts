import { describe, expect, it } from 'vitest'
import {
  contactName,
  newQrSession,
  qrDestination,
  qrErrorMessage,
  qrPayloadKind,
  qrScanAvailable,
  qrSessionOver,
  qrStartMessage,
  qrSubmitInput,
  qrText,
  reduceQr,
  wifiNetworkName,
  type QrSession
} from '../qrScan'

describe('qrDestination: what becomes of a decoded payload', () => {
  it('navigates to an address, as typing it would', () => {
    expect(qrDestination('https://example.org/')).toEqual({
      kind: 'navigate',
      url: 'https://example.org/'
    })
    expect(qrDestination('example.org')).toEqual({ kind: 'navigate', url: 'https://example.org' })
    expect(qrDestination('  http://localhost:8080/path?q=1 \n')).toEqual({
      kind: 'navigate',
      url: 'http://localhost:8080/path?q=1'
    })
    expect(qrPayloadKind('192.168.1.1')).toBe('url')
  })

  it('searches words through the default engine', () => {
    expect(qrDestination('weather in Lisbon')).toEqual({
      kind: 'search',
      query: 'weather in Lisbon'
    })
    expect(qrPayloadKind('weather in Lisbon')).toBe('text')
  })

  it('searches a payload with line breaks as one line', () => {
    expect(qrDestination('table 12\r\norder 4471')).toEqual({
      kind: 'search',
      query: 'table 12 order 4471'
    })
  })

  it('searches a Wi-Fi payload by its network name alone, never its password', () => {
    const payload = 'WIFI:T:WPA;S:Cafe Lisboa;P:hunter2;H:false;;'
    expect(qrPayloadKind(payload)).toBe('wifi')
    const destination = qrDestination(payload)
    expect(destination).toEqual({ kind: 'search', query: 'Cafe Lisboa' })
    expect(JSON.stringify(destination)).not.toContain('hunter2')
    expect(qrSubmitInput(payload)).toBe('Cafe Lisboa')
  })

  it('reads a Wi-Fi network name with escaped separators and falls back without one', () => {
    expect(wifiNetworkName('WIFI:S:Home\\;Guest\\:2;T:WPA;P:x;;')).toBe('Home;Guest:2')
    expect(wifiNetworkName('WIFI:T:nopass;S:;;')).toBeNull()
    expect(qrDestination('WIFI:T:nopass;P:x;;')).toEqual({ kind: 'search', query: 'Wi-Fi network' })
  })

  it('searches a contact by the name it carries', () => {
    const vcard = 'BEGIN:VCARD\nVERSION:3.0\nN:Doe;Jane;;;\nFN:Jane Doe\nTEL:+351000000\nEND:VCARD'
    expect(qrPayloadKind(vcard)).toBe('contact')
    expect(qrDestination(vcard)).toEqual({ kind: 'search', query: 'Jane Doe' })
    expect(contactName('BEGIN:VCARD\nVERSION:2.1\nN;CHARSET=UTF-8:Doe;Jane;Q\nEND:VCARD')).toBe(
      'Jane Q Doe'
    )
    expect(contactName('MECARD:N:Doe,Jane;TEL:123;;')).toBe('Jane Doe')
    expect(contactName('MECARD:TEL:123;;')).toBeNull()
  })

  it('falls back to the contact payload as one line when it names nobody', () => {
    expect(qrDestination('BEGIN:VCARD\nVERSION:3.0\nTEL:123\nEND:VCARD')).toEqual({
      kind: 'search',
      query: 'BEGIN:VCARD VERSION:3.0 TEL:123 END:VCARD'
    })
  })

  it('treats mailto, tel and geo like typed text: a search', () => {
    expect(qrPayloadKind('mailto:someone@example.org')).toBe('text')
    expect(qrDestination('tel:+351000000')?.kind).toBe('search')
    expect(qrDestination('geo:38.7,-9.1')?.kind).toBe('search')
  })

  it('has nothing to submit for an empty payload', () => {
    expect(qrDestination('')).toBeNull()
    expect(qrDestination(' \n ')).toBeNull()
    expect(qrSubmitInput('')).toBeNull()
  })

  it('submits an address as scanned so the core resolves it like typed text', () => {
    expect(qrSubmitInput(' example.org\n')).toBe('example.org')
    expect(qrSubmitInput('weather  in\nLisbon')).toBe('weather in Lisbon')
  })

  it('trims and normalizes line breaks', () => {
    expect(qrText('\r\n a\r\nb \r\n')).toBe('a\nb')
  })
})

describe('reduceQr: the scan sheet state machine', () => {
  const scanning = (): QrSession => reduceQr(newQrSession(), { kind: 'ready', torch: true })

  it('starts in the starting phase without a torch or a still', () => {
    expect(newQrSession()).toEqual({
      phase: 'starting',
      torch: false,
      torchOn: false,
      still: null,
      text: '',
      error: null
    })
  })

  it('moves to scanning on ready and remembers whether there is a torch', () => {
    expect(scanning()).toMatchObject({ phase: 'scanning', torch: true })
    expect(reduceQr(newQrSession(), { kind: 'ready', torch: false }).torch).toBe(false)
  })

  it('keeps the last still and the torch state', () => {
    let s = scanning()
    s = reduceQr(s, { kind: 'still', dataUrl: 'data:image/jpeg;base64,AAA' })
    expect(s.still).toBe('data:image/jpeg;base64,AAA')
    const same = reduceQr(s, { kind: 'still', dataUrl: '' })
    expect(same).toBe(s)
    s = reduceQr(s, { kind: 'torch', on: true })
    expect(s.torchOn).toBe(true)
    expect(reduceQr(s, { kind: 'torch', on: true })).toBe(s)
  })

  it('is done with the trimmed text on a decode and turns the torch off', () => {
    const s = reduceQr(reduceQr(scanning(), { kind: 'torch', on: true }), {
      kind: 'decoded',
      text: ' https://example.org/ \n'
    })
    expect(s).toMatchObject({ phase: 'done', text: 'https://example.org/', torchOn: false })
    expect(qrSessionOver(s)).toBe(true)
  })

  it('keeps scanning on a decode that carries no text', () => {
    const s = scanning()
    expect(reduceQr(s, { kind: 'decoded', text: '  ' })).toBe(s)
  })

  it('fails with the error and is cancelled on abort', () => {
    const failed = reduceQr(scanning(), { kind: 'error', error: 'busy' })
    expect(failed).toMatchObject({ phase: 'failed', error: 'busy' })
    expect(qrSessionOver(failed)).toBe(true)
    const aborted = reduceQr(scanning(), { kind: 'aborted' })
    expect(aborted.phase).toBe('cancelled')
    expect(qrSessionOver(aborted)).toBe(true)
  })

  it('ignores every event once the session is over', () => {
    const done = reduceQr(scanning(), { kind: 'decoded', text: 'x' })
    expect(reduceQr(done, { kind: 'still', dataUrl: 'data:,' })).toBe(done)
    expect(reduceQr(done, { kind: 'error', error: 'camera' })).toBe(done)
    expect(reduceQr(done, { kind: 'decoded', text: 'y' })).toBe(done)
    expect(reduceQr(done, { kind: 'aborted' })).toBe(done)
  })
})

describe('the capability and the messages', () => {
  it('shows the camera buttons only where the host has a back camera', () => {
    expect(qrScanAvailable({ qrScan: true })).toBe(true)
    expect(qrScanAvailable({ qrScan: false })).toBe(false)
  })

  it('names the refusals and the missing camera, and nothing for a start', () => {
    expect(qrStartMessage('scanning')).toBeNull()
    expect(qrStartMessage('denied')).toMatch(/camera access is needed/i)
    expect(qrStartMessage('denied-permanently')).toMatch(/turned off for Zenium/)
    expect(qrStartMessage('unavailable')).toMatch(/not available/i)
  })

  it('names every camera error', () => {
    expect(qrErrorMessage('busy')).toMatch(/another app/i)
    expect(qrErrorMessage('disconnected')).toMatch(/stopped/i)
    expect(qrErrorMessage('camera')).toMatch(/could not be started/i)
  })
})
