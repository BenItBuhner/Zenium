import { execFile } from 'node:child_process'
import type { GeolocationHost } from '../../core/platform'
import type { WifiAccessPoint } from '../../shared/geolocation'

/** A scan that takes longer is abandoned (the network query goes on with the address alone). */
const SCAN_TIMEOUT_MS = 4_000

/**
 * The Wi-Fi networks in range, for the network location provider (MW-04). Linux asks
 * NetworkManager (`nmcli`), which most desktops run; Windows asks `netsh`. A machine without a
 * scanner, without Wi-Fi or with the tools missing gives an empty list, and BeaconDB then
 * locates by the address alone – a city, not a street, which is what Chrome's network
 * provider without networks does too. macOS locates through the OS (the shim only falls back
 * here), and Apple's scanner needs Location permission of its own, so no scan there.
 */
export class ElectronGeolocation implements GeolocationHost {
  async scanWifi(): Promise<WifiAccessPoint[]> {
    switch (process.platform) {
      case 'linux':
        return parseNmcli(
          await run('nmcli', ['-t', '-f', 'BSSID,SIGNAL,FREQ', 'device', 'wifi', 'list'])
        )
      case 'win32':
        return parseNetsh(await run('netsh', ['wlan', 'show', 'networks', 'mode=bssid']))
      default:
        return []
    }
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: SCAN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? '' : String(stdout))
    )
  })
}

const BSSID = /^([0-9a-f]{2}(?::[0-9a-f]{2}){5})$/i

/**
 * NetworkManager's strength is a percentage; the location API wants dBm. NetworkManager maps
 * -100 dBm to 0 and -50 dBm to 100, so the way back is `dBm = percent / 2 - 100` (Windows'
 * `netsh` quality percentage follows the same rule).
 */
export function percentToDbm(percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent))
  return Math.round(clamped / 2 - 100)
}

/**
 * `nmcli -t -f BSSID,SIGNAL,FREQ device wifi list`: one network a line, fields split by `:`,
 * the BSSID's own colons escaped as `\:` – `AA\:BB\:CC\:DD\:EE\:FF:72:2412 MHz`.
 */
export function parseNmcli(output: string): WifiAccessPoint[] {
  const out: WifiAccessPoint[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const fields = splitTerse(line)
    const mac = (fields[0] ?? '').toLowerCase()
    if (!BSSID.test(mac)) continue
    const ap: WifiAccessPoint = { macAddress: mac }
    const signal = Number(fields[1])
    if (fields[1] !== undefined && fields[1] !== '' && Number.isFinite(signal))
      ap.signalStrength = percentToDbm(signal)
    const freq = Number.parseInt(fields[2] ?? '', 10)
    if (Number.isFinite(freq) && freq > 0) ap.frequency = freq
    out.push(ap)
  }
  return dedupe(out)
}

/** Split a terse nmcli line on unescaped `:`, unescaping `\:` and `\\`. */
function splitTerse(line: string): string[] {
  const fields: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && i + 1 < line.length) {
      current += line[++i]
      continue
    }
    if (ch === ':') {
      fields.push(current)
      current = ''
      continue
    }
    current += ch
  }
  fields.push(current)
  return fields
}

/**
 * `netsh wlan show networks mode=bssid`: blocks of `BSSID 1 : aa:bb:…`, `Signal : 80%`,
 * `Channel : 6` (the channel gives the frequency), in the system's language – only the values
 * are read, by shape.
 */
export function parseNetsh(output: string): WifiAccessPoint[] {
  const out: WifiAccessPoint[] = []
  let current: WifiAccessPoint | null = null
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    const bssid = /^BSSID\s+\d+\s*:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s*$/i.exec(line)
    if (bssid) {
      current = { macAddress: bssid[1].toLowerCase() }
      out.push(current)
      continue
    }
    if (!current) continue
    const percent = /:\s*(\d{1,3})\s*%\s*$/.exec(line)
    if (percent && current.signalStrength === undefined) {
      current.signalStrength = percentToDbm(Number(percent[1]))
      continue
    }
    const channel = /^[^:]*\b(?:Channel|Kanal|Canal|Canale)\b[^:]*:\s*(\d{1,3})\s*$/i.exec(line)
    if (channel && current.frequency === undefined) {
      const mhz = channelToMhz(Number(channel[1]))
      if (mhz) current.frequency = mhz
    }
  }
  return dedupe(out)
}

/** The centre frequency of a Wi-Fi channel: 2.4 GHz channels 1–14, 5 GHz channels 32–177. */
export function channelToMhz(channel: number): number | null {
  if (!Number.isInteger(channel) || channel <= 0) return null
  if (channel === 14) return 2484
  if (channel <= 13) return 2407 + 5 * channel
  if (channel >= 32 && channel <= 177) return 5000 + 5 * channel
  return null
}

function dedupe(list: WifiAccessPoint[]): WifiAccessPoint[] {
  const seen = new Set<string>()
  return list.filter((ap) => {
    if (seen.has(ap.macAddress)) return false
    seen.add(ap.macAddress)
    return true
  })
}
