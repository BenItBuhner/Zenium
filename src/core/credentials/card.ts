import type {
  CardNetwork,
  PaymentCard,
  PaymentCardInput,
  PaymentCardSummary
} from '../../shared/types'
import type { FormValues } from '../../shared/forms'

/**
 * Payment-card rules shared by the manager, the save prompt and the fill: Luhn, the network from
 * the number's prefix, expiry parsing and the masked rendering. Security codes are never seen
 * here; the page asks the user for them every time.
 */

export const NETWORK_NAMES: Record<CardNetwork, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  maestro: 'Maestro',
  unknown: 'Card'
}

/** Keep the digits of a typed number (`4242 4242-4242 4242` → `4242424242424242`). */
export function cardDigits(text: string): string {
  return text.replace(/\D/g, '')
}

/** The Luhn check every real card number passes; 12 to 19 digits as the networks issue them. */
export function luhnValid(number: string): boolean {
  const digits = cardDigits(number)
  if (digits.length < 12 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

function inRange(prefix: string, from: number, to: number): boolean {
  const width = String(from).length
  const n = parseInt(prefix.slice(0, width), 10)
  return prefix.length >= width && n >= from && n <= to
}

/** The network a number belongs to, from its issuer prefix (Chrome's table). */
export function cardNetwork(number: string): CardNetwork {
  const d = cardDigits(number)
  if (!d) return 'unknown'
  if (d.startsWith('34') || d.startsWith('37')) return 'amex'
  if (inRange(d, 300, 305) || d.startsWith('309') || d.startsWith('36') || d.startsWith('38') || d.startsWith('39'))
    return 'diners'
  if (inRange(d, 3528, 3589)) return 'jcb'
  if (d.startsWith('6011') || inRange(d, 644, 649) || d.startsWith('65')) return 'discover'
  if (d.startsWith('62')) return 'unionpay'
  if (
    ['5018', '5020', '5038', '5893', '6304', '6759', '6761', '6762', '6763'].some((p) =>
      d.startsWith(p)
    )
  )
    return 'maestro'
  if (inRange(d, 51, 55) || inRange(d, 2221, 2720)) return 'mastercard'
  if (d.startsWith('4')) return 'visa'
  return 'unknown'
}

/** Two-digit years are this century's. */
export function fullYear(year: number, now: number = Date.now()): number {
  if (year >= 100) return year
  const century = Math.floor(new Date(now).getFullYear() / 100) * 100
  return century + year
}

/**
 * Read an expiry the way pages write it: `MM/YY`, `MM / YYYY`, `MM-YY`, `MMYY`, `YYYY-MM` (an
 * `<input type=month>`); null when it is not one.
 */
export function parseExpiry(text: string, now: number = Date.now()): { month: number; year: number } | null {
  const t = text.trim()
  let month: number
  let year: number
  let m = /^(\d{4})-(\d{1,2})$/.exec(t)
  if (m) {
    year = parseInt(m[1], 10)
    month = parseInt(m[2], 10)
  } else if ((m = /^(\d{1,2})\s*[/\-.\s]\s*(\d{2}|\d{4})$/.exec(t))) {
    month = parseInt(m[1], 10)
    year = parseInt(m[2], 10)
  } else if ((m = /^(\d{2})(\d{2}|\d{4})$/.exec(t))) {
    month = parseInt(m[1], 10)
    year = parseInt(m[2], 10)
  } else return null
  if (month < 1 || month > 12) return null
  year = fullYear(year, now)
  if (year < 1900 || year > 2200) return null
  return { month, year }
}

/** A card is good through the last day of its expiry month. */
export function cardExpired(month: number, year: number, now: number = Date.now()): boolean {
  const d = new Date(now)
  const current = d.getFullYear() * 12 + d.getMonth() + 1
  return year * 12 + month < current
}

/** Why a card cannot be saved, or null when it can. */
export function validateCard(input: PaymentCardInput, now: number = Date.now()): string | null {
  if (!luhnValid(input.number)) return 'That card number is not valid.'
  if (!Number.isInteger(input.expMonth) || input.expMonth < 1 || input.expMonth > 12)
    return 'The expiry month must be between 1 and 12.'
  const year = fullYear(input.expYear, now)
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return 'The expiry year is not valid.'
  return null
}

export function last4Of(number: string): string {
  return cardDigits(number).slice(-4)
}

/** `•••• 4242`. */
export function maskedCardNumber(number: string): string {
  return `\u2022\u2022\u2022\u2022 ${last4Of(number)}`
}

/** `Visa •••• 4242` (or the nickname when the user gave one). */
export function cardLabel(card: Pick<PaymentCardSummary, 'network' | 'last4' | 'nickname'>): string {
  return card.nickname || `${NETWORK_NAMES[card.network]} \u2022\u2022\u2022\u2022 ${card.last4}`
}

/** `MM/YY`. */
export function expiryLabel(month: number, year: number): string {
  return `${String(month).padStart(2, '0')}/${String(year).slice(-2)}`
}

export function cardSummary(card: PaymentCard, now: number = Date.now()): PaymentCardSummary {
  const { number, ...rest } = card
  return {
    ...rest,
    last4: last4Of(number),
    network: cardNetwork(number),
    expired: cardExpired(card.expMonth, card.expYear, now)
  }
}

/** The `value|label` a submitted `<select>` reports, or a plain value. */
function selectValue(raw: string | undefined): string {
  if (!raw) return ''
  const bar = raw.indexOf('|')
  return (bar >= 0 ? raw.slice(0, bar) : raw).trim()
}

function selectLabel(raw: string | undefined): string {
  if (!raw) return ''
  const bar = raw.indexOf('|')
  return (bar >= 0 ? raw.slice(bar + 1) : raw).trim()
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]

function monthFrom(raw: string | undefined): number | null {
  const value = selectValue(raw)
  const n = parseInt(value, 10)
  if (Number.isFinite(n) && n >= 1 && n <= 12) return n
  const text = (selectLabel(raw) || value).toLowerCase()
  const index = MONTH_NAMES.findIndex((m) => m.startsWith(text.slice(0, 3)))
  return text.length >= 3 && index >= 0 ? index + 1 : null
}

function yearFrom(raw: string | undefined, now: number): number | null {
  const n = parseInt(selectValue(raw), 10)
  if (!Number.isFinite(n)) return null
  return fullYear(n, now)
}

/**
 * The card a submitted payment form carried, or null when the number or expiry is unusable.
 * `cc-exp` (one field) and `cc-exp-month` / `cc-exp-year` (two) are both understood.
 */
export function cardFromForm(values: FormValues, now: number = Date.now()): PaymentCardInput | null {
  const number = cardDigits(values['cc-number'] ?? '')
  if (!luhnValid(number)) return null
  let month: number | null = null
  let year: number | null = null
  if (values['cc-exp']) {
    const parsed = parseExpiry(values['cc-exp'], now)
    if (parsed) ({ month, year } = parsed)
  }
  if (month === null || year === null) {
    month = monthFrom(values['cc-exp-month'])
    year = yearFrom(values['cc-exp-year'], now)
  }
  if (month === null || year === null) return null
  return {
    number,
    expMonth: month,
    expYear: year,
    name: (values['cc-name'] ?? values.name ?? '').trim(),
    nickname: ''
  }
}
