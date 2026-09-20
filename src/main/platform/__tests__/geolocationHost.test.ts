import { describe, expect, it } from 'vitest'
import { channelToMhz, parseNetsh, parseNmcli, percentToDbm } from '../geolocation'

describe('nmcli output', () => {
  it('reads BSSID, signal and frequency from terse lines with escaped colons', () => {
    const output = [
      'AA\\:BB\\:CC\\:DD\\:EE\\:FF:72:2412 MHz',
      '11\\:22\\:33\\:44\\:55\\:66:40:5180 MHz',
      'AA\\:BB\\:CC\\:DD\\:EE\\:FF:70:2412 MHz',
      '',
      'garbage line'
    ].join('\n')
    expect(parseNmcli(output)).toEqual([
      { macAddress: 'aa:bb:cc:dd:ee:ff', signalStrength: -64, frequency: 2412 },
      { macAddress: '11:22:33:44:55:66', signalStrength: -80, frequency: 5180 }
    ])
  })

  it('copes with missing fields and empty output', () => {
    expect(parseNmcli('AA\\:BB\\:CC\\:DD\\:EE\\:FF::')).toEqual([
      { macAddress: 'aa:bb:cc:dd:ee:ff' }
    ])
    expect(parseNmcli('')).toEqual([])
  })
})

describe('netsh output', () => {
  it('reads each BSSID block with its signal and channel, in any language', () => {
    const output = [
      'SSID 1 : Home',
      '    Network type            : Infrastructure',
      '    BSSID 1                 : aa:bb:cc:dd:ee:ff',
      '         Signal             : 80%',
      '         Radio type         : 802.11ax',
      '         Channel            : 6',
      '    BSSID 2                 : 11:22:33:44:55:66',
      '         Signal             : 40%',
      '         Kanal              : 36',
      'SSID 2 : Cafe',
      '    BSSID 1                 : aa:bb:cc:dd:ee:ff',
      '         Signal             : 10%'
    ].join('\r\n')
    expect(parseNetsh(output)).toEqual([
      { macAddress: 'aa:bb:cc:dd:ee:ff', signalStrength: -60, frequency: 2437 },
      { macAddress: '11:22:33:44:55:66', signalStrength: -80, frequency: 5180 }
    ])
  })

  it('gives nothing for a machine without Wi-Fi', () => {
    expect(parseNetsh('There is no wireless interface on the system.')).toEqual([])
  })
})

describe('unit conversion', () => {
  it('turns quality percentages into dBm on the NetworkManager scale', () => {
    expect(percentToDbm(100)).toBe(-50)
    expect(percentToDbm(0)).toBe(-100)
    expect(percentToDbm(140)).toBe(-50)
    expect(percentToDbm(-3)).toBe(-100)
  })

  it('maps Wi-Fi channels to centre frequencies', () => {
    expect(channelToMhz(1)).toBe(2412)
    expect(channelToMhz(13)).toBe(2472)
    expect(channelToMhz(14)).toBe(2484)
    expect(channelToMhz(36)).toBe(5180)
    expect(channelToMhz(177)).toBe(5885)
    expect(channelToMhz(20)).toBeNull()
    expect(channelToMhz(0)).toBeNull()
  })
})
