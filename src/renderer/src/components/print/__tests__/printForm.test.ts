import { describe, expect, it } from 'vitest'
import type { PrinterDescription } from '@shared/print'
import { defaultPrintSettings, SAVE_AS_PDF_LABEL } from '@shared/print'
import {
  destinationFromValue,
  destinationOptions,
  destinationValue,
  marginInches,
  marginText,
  marginTexts,
  marginUnitFor,
  PDF_DESTINATION,
  showsPrinterOnly
} from '../printForm'

function printer(name: string, isDefault = false, displayName = name): PrinterDescription {
  return { name, displayName, description: '', isDefault, duplex: null }
}

describe('the destination menulist', () => {
  it('lists the printers with the default first, then Save as PDF, as Chrome does', () => {
    const options = destinationOptions([
      printer('Office_Duplex', false, 'Office Duplex'),
      printer('Zenium_PDF', true),
      printer('Attic', false)
    ])
    expect(options.map((o) => o.label)).toEqual([
      'Zenium_PDF',
      'Attic',
      'Office Duplex',
      SAVE_AS_PDF_LABEL
    ])
    expect(options[options.length - 1]?.value).toBe(PDF_DESTINATION)
  })

  it('is Save as PDF alone on a machine without printers', () => {
    expect(destinationOptions([])).toEqual([{ value: PDF_DESTINATION, label: SAVE_AS_PDF_LABEL }])
  })

  it('round-trips a destination through its value, printer names with colons included', () => {
    const office = { kind: 'printer', name: 'ipp://print.local:631/Office' } as const
    expect(destinationFromValue(destinationValue(office))).toEqual(office)
    expect(destinationFromValue(destinationValue({ kind: 'pdf' }))).toEqual({ kind: 'pdf' })
    expect(destinationFromValue('something else')).toEqual({ kind: 'pdf' })
  })

  it('shows copies and colour for a printer only', () => {
    const settings = defaultPrintSettings('en-US')
    expect(showsPrinterOnly({ ...settings, destination: { kind: 'pdf' } })).toBe(false)
    expect(showsPrinterOnly({ ...settings, destination: { kind: 'printer', name: 'Office' } })).toBe(
      true
    )
  })
})

describe('custom margins', () => {
  it('are typed in inches where the paper is Letter and in millimetres elsewhere', () => {
    expect(marginUnitFor('en-US')).toBe('in')
    expect(marginUnitFor('en-CA')).toBe('in')
    expect(marginUnitFor('en-GB')).toBe('mm')
    expect(marginUnitFor('de')).toBe('mm')
    expect(marginUnitFor(null)).toBe('mm')
  })

  it('shows two decimals of an inch and whole millimetres', () => {
    expect(marginText(0.4, 'in')).toBe('0.4')
    expect(marginText(0.39370078, 'in')).toBe('0.39')
    expect(marginText(0.39370078, 'mm')).toBe('10')
    expect(marginText(0, 'mm')).toBe('0')
    expect(marginTexts({ top: 1, right: 0.5, bottom: 1, left: 0.5 }, 'mm')).toEqual({
      top: '25',
      right: '13',
      bottom: '25',
      left: '13'
    })
  })

  it('reads a typed figure back as inches, a decimal comma included', () => {
    expect(marginInches('0.5', 'in', 'letter')).toBe(0.5)
    expect(marginInches(' 25,4 ', 'mm', 'a4')).toBeCloseTo(1, 6)
    expect(marginInches('0', 'in', 'letter')).toBe(0)
  })

  it('is null while the field is not a number, and never negative', () => {
    expect(marginInches('', 'in', 'letter')).toBeNull()
    expect(marginInches('abc', 'in', 'letter')).toBeNull()
    expect(marginInches('-1', 'in', 'letter')).toBeNull()
    expect(marginInches('1e400', 'in', 'letter')).toBeNull()
  })

  it("stops at half the paper's shorter side less a little, where Chrome's handles meet", () => {
    // Letter's shorter side is 8.5 in: the most is 4.25 − 0.25.
    expect(marginInches('9', 'in', 'letter')).toBe(4)
    // A4's is 210 mm: 105 mm − 6.35 mm, in inches.
    expect(marginInches('300', 'mm', 'a4')).toBeCloseTo(210 / 25.4 / 2 - 0.25, 3)
    // An unknown paper falls back to the first size's bound rather than none.
    expect(marginInches('9', 'in', 'no-such-paper')).toBe(4)
  })
})
