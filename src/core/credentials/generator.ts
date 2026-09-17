import type { GeneratorOptions } from '../../shared/types'
import { randomInt, shuffle } from './crypto'
import {
  DIGITS,
  LOWER,
  SPECIAL,
  UPPER,
  charactersOf,
  emptyRules,
  type CharacterClass,
  type PasswordRules
} from './rules'

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  mode: 'password',
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  words: 4,
  separator: '-',
  capitalize: true,
  includeDigit: false
}

export const MIN_LENGTH = 6
export const MAX_LENGTH = 128
export const MIN_WORDS = 3
export const MAX_WORDS = 12

/** Symbols offered when a site publishes no rules: the ones every form we know of accepts. */
export const DEFAULT_SYMBOLS = '!@#$%^&*-_=+?'

/** Without site rules, Apple's `special` class would put spaces and quotes in every password. */
const GENERIC_SYMBOL_CLASS: CharacterClass = { kind: 'custom', chars: DEFAULT_SYMBOLS }

function sanitizeLength(value: number, rules: PasswordRules): number {
  let length = Number.isFinite(value) ? Math.round(value) : DEFAULT_GENERATOR_OPTIONS.length
  length = Math.max(MIN_LENGTH, Math.min(MAX_LENGTH, length))
  if (rules.minLength !== null) length = Math.max(length, rules.minLength)
  if (rules.maxLength !== null) length = Math.min(length, rules.maxLength)
  return Math.max(1, length)
}

function unique(chars: string): string {
  return [...new Set(chars)].join('')
}

function intersect(a: string, b: string): string {
  const set = new Set(b)
  return [...a].filter((c) => set.has(c)).join('')
}

function classChars(cls: CharacterClass): string {
  return cls.kind === 'named' && cls.name === 'special' ? SPECIAL : charactersOf(cls)
}

/**
 * A random password. The user's class toggles choose the alphabet; a site's rules narrow it
 * (`allowed`), extend it and add mandatory picks (`required`), and bound the length. Every
 * required group and every enabled class that fits is represented at least once; the result never
 * repeats one character more than `max-consecutive` times.
 */
export function generatePassword(
  options: GeneratorOptions,
  rules: PasswordRules = emptyRules()
): string {
  const length = sanitizeLength(options.length, rules)
  const chosen: CharacterClass[] = []
  if (options.upper) chosen.push({ kind: 'named', name: 'upper' })
  if (options.lower) chosen.push({ kind: 'named', name: 'lower' })
  if (options.digits) chosen.push({ kind: 'named', name: 'digit' })
  if (options.symbols) chosen.push(GENERIC_SYMBOL_CLASS)
  if (chosen.length === 0) chosen.push({ kind: 'named', name: 'lower' })

  const allowed = rules.allowed.length ? unique(rules.allowed.map(classChars).join('')) : null
  const requiredGroups = rules.required.map((group) => unique(group.map(classChars).join('')))

  // The alphabet: what the user asked for, cut down to what the site allows, plus anything the
  // site demands (required classes are implicitly allowed).
  let pool = unique(chosen.map(classChars).join(''))
  if (allowed !== null) pool = intersect(pool, allowed)
  const userChars = unique(chosen.map(classChars).join(''))
  const mandatory: string[] = []
  for (const group of requiredGroups) {
    if (!group) continue
    // Prefer the user's taste within a required group, then friendly symbols (a required
    // `special` should not put spaces and quotes into the password), then anything that fits.
    const preferred = intersect(group, userChars) || intersect(group, DEFAULT_SYMBOLS) || group
    mandatory.push(preferred)
    if (!intersect(group, pool)) pool = unique(pool + preferred)
  }
  // Each enabled class that the site allows must show up at least once too.
  for (const cls of chosen) {
    const chars = intersect(classChars(cls), pool)
    if (chars && !mandatory.some((m) => intersect(m, chars) === m)) mandatory.push(chars)
  }
  // A site that allows none of the user's classes (digits only, say) gets its own alphabet.
  if (!pool) pool = allowed || LOWER + UPPER + DIGITS
  const maxConsecutive = rules.maxConsecutive ?? 2

  for (let attempt = 0; attempt < 64; attempt++) {
    const picks: string[] = []
    for (const group of mandatory.slice(0, length)) picks.push(group[randomInt(group.length)])
    while (picks.length < length) picks.push(pool[randomInt(pool.length)])
    const password = shuffle(picks).join('')
    if (
      !exceedsConsecutive(password, maxConsecutive) &&
      mandatory.slice(0, length).every((group) => [...password].some((c) => group.includes(c)))
    )
      return password
  }
  // Statistically unreachable; still never return nothing.
  return shuffle([...pool].slice(0, length)).join('')
}

function exceedsConsecutive(text: string, max: number): boolean {
  let run = 1
  for (let i = 1; i < text.length; i++) {
    run = text[i] === text[i - 1] ? run + 1 : 1
    if (run > max) return true
  }
  return false
}

/**
 * A passphrase of random words from the EFF large wordlist (7776 words, about 12.9 bits each),
 * joined by `separator`. `capitalize` upper-cases each word; `includeDigit` appends a digit to
 * one word, which many sites insist on.
 */
export function generatePassphrase(options: GeneratorOptions, wordlist: readonly string[]): string {
  if (wordlist.length < 2) throw new Error('The passphrase wordlist is empty')
  const count = Math.max(
    MIN_WORDS,
    Math.min(MAX_WORDS, Math.round(options.words) || DEFAULT_GENERATOR_OPTIONS.words)
  )
  const words: string[] = []
  for (let i = 0; i < count; i++) {
    let word = wordlist[randomInt(wordlist.length)]
    if (options.capitalize) word = word[0].toUpperCase() + word.slice(1)
    words.push(word)
  }
  if (options.includeDigit) {
    const at = randomInt(count)
    words[at] = `${words[at]}${DIGITS[randomInt(DIGITS.length)]}`
  }
  return words.join(options.separator)
}

/** Whether a password satisfies a site's rules (used by the tests and the generator preview). */
export function satisfiesRules(password: string, rules: PasswordRules): boolean {
  if (rules.minLength !== null && password.length < rules.minLength) return false
  if (rules.maxLength !== null && password.length > rules.maxLength) return false
  if (rules.maxConsecutive !== null && exceedsConsecutive(password, rules.maxConsecutive))
    return false
  for (const group of rules.required) {
    const chars = group.map(classChars).join('')
    if (![...password].some((c) => chars.includes(c))) return false
  }
  if (rules.allowed.length) {
    const permitted =
      rules.allowed.map(classChars).join('') + rules.required.flat().map(classChars).join('')
    if (![...password].every((c) => permitted.includes(c))) return false
  }
  return true
}
