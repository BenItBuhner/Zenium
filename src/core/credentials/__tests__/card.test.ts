import { describe, expect, it } from 'vitest'
import {
  cardDigits,
  cardExpired,
  cardFromForm,
  cardLabel,
  cardNetwork,
  cardSummary,
  expiryLabel,
  fullYear,
  luhnValid,
  maskedCardNumber,
  parseExpiry,
  validateCard
} from '../card'

/** A fixed "now": 15 June 2026. */
const NOW = Date.UTC(2026, 5, 15, 12)

describe('luhnValid', () => {
  it('accepts the networks’ test numbers however they are spaced', () => {
    for (const number of [
      '4242 4242 4242 4242',
      '4000-0566-5566-5556',
      '5555555555554444',
      '2223003122003222',
      '378282246310005',
      '6011111111111117',
      '3056930009020004',
      '3566002020360505',
      '6200000000000005',
      '6759649826438453'
    ])
      expect(luhnValid(number), number).toBe(true)
  })

  it('rejects a typo, too few or too many digits, and letters', () => {
    expect(luhnValid('4242424242424241')).toBe(false)
    expect(luhnValid('42424242424')).toBe(false)
    expect(luhnValid('42424242424242424242')).toBe(false)
    expect(luhnValid('not a card')).toBe(false)
    expect(luhnValid('')).toBe(false)
  })

  it('keeps only the digits of a typed number', () => {
    expect(cardDigits(' 4242-4242 4242.4242 ')).toBe('4242424242424242')
  })
})

describe('cardNetwork', () => {
  it('reads the issuer prefix', () => {
    expect(cardNetwork('4242424242424242')).toBe('visa')
    expect(cardNetwork('5555555555554444')).toBe('mastercard')
    expect(cardNetwork('2223003122003222')).toBe('mastercard')
    expect(cardNetwork('378282246310005')).toBe('amex')
    expect(cardNetwork('6011111111111117')).toBe('discover')
    expect(cardNetwork('6500000000000002')).toBe('discover')
    expect(cardNetwork('3056930009020004')).toBe('diners')
    expect(cardNetwork('36227206271667')).toBe('diners')
    expect(cardNetwork('3566002020360505')).toBe('jcb')
    expect(cardNetwork('6200000000000005')).toBe('unionpay')
    expect(cardNetwork('6759649826438453')).toBe('maestro')
    expect(cardNetwork('5018000000000009')).toBe('maestro')
    expect(cardNetwork('9999999999999999')).toBe('unknown')
    expect(cardNetwork('')).toBe('unknown')
  })
})

describe('parseExpiry', () => {
  it('reads every spelling pages use', () => {
    expect(parseExpiry('12/27', NOW)).toEqual({ month: 12, year: 2027 })
    expect(parseExpiry('1 / 2027', NOW)).toEqual({ month: 1, year: 2027 })
    expect(parseExpiry('03-29', NOW)).toEqual({ month: 3, year: 2029 })
    expect(parseExpiry('0429', NOW)).toEqual({ month: 4, year: 2029 })
    expect(parseExpiry('042029', NOW)).toEqual({ month: 4, year: 2029 })
    expect(parseExpiry('2028-07', NOW)).toEqual({ month: 7, year: 2028 })
    expect(parseExpiry('7.31', NOW)).toEqual({ month: 7, year: 2031 })
  })

  it('refuses impossible months and years and text', () => {
    expect(parseExpiry('13/27', NOW)).toBeNull()
    expect(parseExpiry('00/27', NOW)).toBeNull()
    expect(parseExpiry('12/1850', NOW)).toBeNull()
    expect(parseExpiry('soon', NOW)).toBeNull()
    expect(parseExpiry('', NOW)).toBeNull()
  })

  it('puts two-digit years in the current century', () => {
    expect(fullYear(27, NOW)).toBe(2027)
    expect(fullYear(2027, NOW)).toBe(2027)
  })
})

describe('cardExpired', () => {
  it('keeps a card good through the last day of its expiry month', () => {
    expect(cardExpired(6, 2026, NOW)).toBe(false)
    expect(cardExpired(5, 2026, NOW)).toBe(true)
    expect(cardExpired(1, 2027, NOW)).toBe(false)
    expect(cardExpired(12, 2025, NOW)).toBe(true)
  })
})

describe('validateCard', () => {
  it('names the problem, or none', () => {
    const good = {
      number: '4242424242424242',
      expMonth: 12,
      expYear: 2030,
      name: 'Ada',
      nickname: ''
    }
    expect(validateCard(good, NOW)).toBeNull()
    expect(validateCard({ ...good, number: '1234' }, NOW)).toMatch(/card number/)
    expect(validateCard({ ...good, expMonth: 0 }, NOW)).toMatch(/month/)
    expect(validateCard({ ...good, expMonth: 13 }, NOW)).toMatch(/month/)
    expect(validateCard({ ...good, expYear: 1800 }, NOW)).toMatch(/year/)
    expect(validateCard({ ...good, expYear: 31 }, NOW)).toBeNull()
  })
})

describe('labels and summaries', () => {
  const card = {
    id: 'card_1',
    number: '4242424242424242',
    expMonth: 3,
    expYear: 2027,
    name: 'Ada Lovelace',
    nickname: '',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null
  }

  it('masks the number, names the network and formats the expiry', () => {
    expect(maskedCardNumber('4242 4242 4242 4242')).toBe('•••• 4242')
    expect(expiryLabel(3, 2027)).toBe('03/27')
    expect(cardLabel({ network: 'visa', last4: '4242', nickname: '' })).toBe('Visa •••• 4242')
    expect(cardLabel({ network: 'visa', last4: '4242', nickname: 'Work card' })).toBe('Work card')
  })

  it('summarises a card without its number', () => {
    const summary = cardSummary(card, NOW)
    expect(summary).not.toHaveProperty('number')
    expect(summary).toMatchObject({
      id: 'card_1',
      last4: '4242',
      network: 'visa',
      expired: false,
      name: 'Ada Lovelace'
    })
    expect(cardSummary({ ...card, expYear: 2025 }, NOW).expired).toBe(true)
  })
})

describe('cardFromForm', () => {
  it('reads a form with one expiry field', () => {
    expect(
      cardFromForm(
        { 'cc-number': '4242 4242 4242 4242', 'cc-exp': '12/27', 'cc-name': ' Ada ' },
        NOW
      )
    ).toEqual({
      number: '4242424242424242',
      expMonth: 12,
      expYear: 2027,
      name: 'Ada',
      nickname: ''
    })
  })

  it('reads split month / year selects by value or by label, and two-digit years', () => {
    expect(
      cardFromForm(
        {
          'cc-number': '5555555555554444',
          'cc-exp-month': '4|April',
          'cc-exp-year': '29|2029',
          name: 'Bob'
        },
        NOW
      )
    ).toEqual({ number: '5555555555554444', expMonth: 4, expYear: 2029, name: 'Bob', nickname: '' })
    expect(
      cardFromForm(
        { 'cc-number': '5555555555554444', 'cc-exp-month': 'apr|Apr', 'cc-exp-year': '2029|2029' },
        NOW
      )
    ).toMatchObject({ expMonth: 4, expYear: 2029 })
  })

  it('returns null for a bad number or a missing expiry', () => {
    expect(cardFromForm({ 'cc-number': '4242424242424241', 'cc-exp': '12/27' }, NOW)).toBeNull()
    expect(cardFromForm({ 'cc-number': '4242424242424242' }, NOW)).toBeNull()
    expect(cardFromForm({ 'cc-number': '4242424242424242', 'cc-exp': 'never' }, NOW)).toBeNull()
    expect(cardFromForm({}, NOW)).toBeNull()
  })
})
