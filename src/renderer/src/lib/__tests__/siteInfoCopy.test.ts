import { describe, expect, it } from 'vitest'
import type { SiteInfoSnapshot, SiteSecurity } from '@shared/siteInfo'
import { DEFAULT_CONTAINER_ID, type CertificateError, type Tab, type UIState } from '@shared/types'
import { contentSetting } from '@shared/contentSettings'
import {
  backgroundVideoChoice,
  backgroundVideoLine,
  connectionDetail,
  connectionFault,
  connectionHeadline,
  connectionValue,
  permissionRows,
  security,
  showsBackgroundVideoRow,
  summaryLine
} from '../siteInfoCopy'

/*
 * The Connection row's words where the certificate failed verification (W5-2 (c), Android's
 * #382): the popover names the fault in the shared module's words – `certificateFault` – and
 * never the refused certificate's issuer, as the phone sheet's title line does; the sentence
 * under the level's headline is `certificateErrorDetail`'s; and a tab whose certificate was
 * refused reads as not secure from the first frame, before the host's reading lands.
 */

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0)
const DAY = 86_400_000

function refused(code: number, patch: Partial<CertificateError> = {}): CertificateError {
  return {
    code,
    url: 'https://expired.example/',
    certificate: {
      subjectName: 'expired.example',
      issuerName: 'Example Root CA',
      validStart: NOW - 400 * DAY,
      validExpiry: NOW - 35 * DAY,
      fingerprint: 'sha256/abc'
    },
    bypassed: false,
    ...patch
  }
}

function insecure(error: CertificateError): SiteSecurity {
  return {
    state: 'insecure',
    certificate: {
      subject: error.certificate?.subjectName ?? '',
      issuer: error.certificate?.issuerName ?? '',
      validFrom: error.certificate?.validStart ?? null,
      validTo: error.certificate?.validExpiry ?? null,
      protocol: null
    },
    mixedContent: null,
    certificateError: error
  }
}

const tab = {
  id: 't1',
  url: 'https://expired.example/',
  containerId: DEFAULT_CONTAINER_ID,
  title: 'Expired',
  favicon: null,
  loading: false,
  blockedCount: 0
} as unknown as Tab

const state = { containers: [] } as unknown as UIState

function snapshot(sec: SiteSecurity): SiteInfoSnapshot {
  return {
    tabId: 't1',
    url: tab.url,
    security: sec,
    isPrivate: false
  } as unknown as SiteInfoSnapshot
}

describe("the Connection row's fault (W5-2 (c), #382)", () => {
  it.each([
    [-200, 'Certificate not valid for this site'],
    [-202, 'Certificate not trusted'],
    [-206, 'Certificate revoked'],
    [-213, 'Certificate not valid']
  ])('names ERR_CERT %d by its fault, in the shared module’s words', (code, fault) => {
    const s = insecure(refused(code))
    expect(connectionFault(s, NOW)).toBe(fault)
    expect(connectionValue(s)).toBe(fault)
  })

  it('tells an expired certificate from one not yet valid by the clock it is given', () => {
    const expired = insecure(refused(-201))
    expect(connectionFault(expired, NOW)).toBe('Certificate expired')
    const early = insecure(
      refused(-201, {
        certificate: {
          ...refused(-201).certificate!,
          validStart: NOW + DAY,
          validExpiry: NOW + 90 * DAY
        }
      })
    )
    expect(connectionFault(early, NOW)).toBe('Certificate not yet valid')
    // Without the dates the certificate cannot be early, so it has expired.
    expect(connectionFault(insecure(refused(-201, { certificate: null })), NOW)).toBe(
      'Certificate expired'
    )
  })

  it('names no fault where no certificate was refused: the headline stands', () => {
    const secure: SiteSecurity = {
      state: 'secure',
      certificate: {
        subject: 'meet.example',
        issuer: 'Example CA',
        validFrom: null,
        validTo: null,
        protocol: 'TLS 1.3'
      },
      mixedContent: null
    }
    expect(connectionFault(secure)).toBeNull()
    expect(connectionValue(secure)).toBe(connectionHeadline(secure))
    const plain: SiteSecurity = { state: 'insecure', certificate: null, mixedContent: null }
    expect(connectionFault(plain)).toBeNull()
    expect(connectionValue(plain)).toBe('Not secure')
    expect(connectionValue({ ...plain, certificateError: null })).toBe('Not secure')
  })

  it('puts the shared module’s sentence under the headline: refused, or proceeded past', () => {
    expect(connectionDetail(insecure(refused(-201)))).toBe(
      'The certificate this site sent could not be verified, so Zenium did not load the page.'
    )
    expect(connectionDetail(insecure(refused(-201, { bypassed: true })))).toBe(
      'You chose to proceed past a certificate warning. What you send to this site could be read or changed on the way.'
    )
    // The plain http sentence is untouched.
    expect(
      connectionDetail({ state: 'insecure', certificate: null, mixedContent: null })
    ).not.toMatch(/certificate/i)
  })

  it("names the fault, never the issuer, on the title block's line – the phone sheet's line", () => {
    const line = summaryLine(snapshot(insecure(refused(-202))), tab, state)
    expect(line).toBe('Not secure · Certificate not trusted')
    expect(line).not.toContain('Example Root CA')
    // A sound certificate still names who vouched for it.
    const secure: SiteSecurity = {
      state: 'secure',
      certificate: {
        subject: 'meet.example',
        issuer: 'Example CA',
        validFrom: null,
        validTo: null,
        protocol: null
      },
      mixedContent: null
    }
    expect(
      summaryLine(snapshot(secure), { ...tab, url: 'https://meet.example/' } as Tab, state)
    ).toBe('Secure · Example CA')
  })

  it('reads a refused certificate off the tab before the host’s reading lands, never as secure', () => {
    const error = refused(-201)
    const early = security(null, tab.url, { certificateError: error })
    expect(early.state).toBe('insecure')
    expect(early.certificateError).toBe(error)
    expect(early.certificate).toEqual({
      subject: 'expired.example',
      issuer: 'Example Root CA',
      validFrom: error.certificate!.validStart,
      validTo: error.certificate!.validExpiry,
      protocol: null
    })
    expect(connectionFault(early, NOW)).toBe('Certificate expired')
    // The title line says so from the first frame.
    expect(summaryLine(null, { ...tab, certificateError: error } as Tab, state)).toBe(
      'Not secure · Certificate expired'
    )
    // The host's reading, once landed, is the word.
    const landed = snapshot({ state: 'secure', certificate: null, mixedContent: null })
    expect(security(landed, tab.url, { certificateError: error })).toBe(landed.security)
    // A tab with no refused certificate reads as the address alone says.
    expect(security(null, tab.url, { certificateError: null })).toEqual({
      state: 'secure',
      certificate: null,
      mixedContent: null
    })
    expect(security(null, tab.url)).toEqual({
      state: 'secure',
      certificate: null,
      mixedContent: null
    })
    // An http address with a stale error on the tab is plain http, not a certificate fault.
    expect(
      security(null, 'http://plain.example/', { certificateError: error }).certificateError
    ).toBe(undefined)
  })
})

/*
 * The Background video row of the phone sheet (W6-S8; MED-08 / EDGE-32, the lead's ruling on
 * services' #523): when the sheet earns it, what it reads, and the words under it – all from the
 * catalogue's `background-video` entry, never a copy of its sentences.
 */
describe('the Background video row (W6-S8, #523)', () => {
  const stored = [{ permission: 'camera', decision: 'allow' as const }]
  const allowed = [{ permission: 'background-video', decision: 'allow' as const }]
  const blocked = [{ permission: 'background-video', decision: 'deny' as const }]

  it('is earned on Android by a stored answer or a media session that reports video, in Sound’s shape', () => {
    expect(showsBackgroundVideoRow(stored, null, 'android')).toBe(false)
    expect(showsBackgroundVideoRow(stored, { video: false }, 'android')).toBe(false)
    expect(showsBackgroundVideoRow(stored, { video: undefined }, 'android')).toBe(false)
    expect(showsBackgroundVideoRow(stored, { video: true }, 'android')).toBe(true)
    expect(showsBackgroundVideoRow(allowed, null, 'android')).toBe(true)
    expect(showsBackgroundVideoRow(blocked, undefined, 'android')).toBe(true)
  })

  it('never shows where the catalogue marks the setting n-a: the desktop, whatever the tab plays or stored', () => {
    expect(contentSetting('background-video')?.support).toEqual({
      desktop: 'n-a',
      android: 'enforced'
    })
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(showsBackgroundVideoRow(allowed, { video: true }, platform)).toBe(false)
      expect(showsBackgroundVideoRow(blocked, { video: true }, platform)).toBe(false)
    }
  })

  it('reads the stored decision, else the default – Block, Sound’s inverse: only a stored allow is on', () => {
    expect(backgroundVideoChoice(stored)).toBe('default')
    expect(backgroundVideoChoice(allowed)).toBe('allow')
    expect(backgroundVideoChoice(blocked)).toBe('deny')
    expect(backgroundVideoChoice([]) === 'allow').toBe(false)
  })

  it('says what on and off mean in the catalogue’s own words, the lines the Settings row reads', () => {
    const setting = contentSetting('background-video')!
    expect(backgroundVideoLine(true)).toBe(setting.descriptions?.allow)
    expect(backgroundVideoLine(true)).toBe('Sites can keep playing video in the background')
    expect(backgroundVideoLine(false)).toBe(setting.description)
    expect(backgroundVideoLine(false)).toBe('Sites cannot play video in the background')
  })

  it('leaves the desktop popover’s permission rows as they were: no Background video row is added to them', () => {
    // The desktop's `permissionRows` is pinned: the stored decisions as the engine lists them,
    // Sound where the tab earns it, and nothing else – the row is the phone sheet's alone.
    const audible = { audible: true, muted: false } as unknown as Tab
    const quiet = { audible: false, muted: false } as unknown as Tab
    expect(permissionRows(stored, quiet)).toEqual([{ permission: 'camera', decision: 'allow' }])
    expect(permissionRows(stored, audible)).toEqual([
      { permission: 'camera', decision: 'allow' },
      { permission: 'sound', decision: 'default' }
    ])
    // A stored background-video answer lists as the engine lists it, like any other decision.
    expect(permissionRows([...stored, ...allowed], quiet)).toEqual([
      { permission: 'camera', decision: 'allow' },
      { permission: 'background-video', decision: 'allow' }
    ])
  })
})
