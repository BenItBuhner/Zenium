import { PASSWORD_RULES } from './data/passwordRules'

/**
 * Apple's password-rules language (https://developer.apple.com/password-rules/), the format the
 * `passwordrules` attribute and password-manager-resources use:
 *
 *     minlength: 8; maxlength: 64; max-consecutive: 2;
 *     required: upper; required: digit; required: [-!?]; allowed: lower, [_.];
 *
 * Named classes are `upper`, `lower`, `digit`, `special` (every other printable ASCII character,
 * space included), `ascii-printable` and `unicode`; `[...]` lists characters literally (a `-` only
 * as the first one, a literal `]` only as `]]` at the end). Each `required` line demands at least
 * one character from the union of its classes; `allowed` widens what may appear.
 */

export type NamedClass = 'upper' | 'lower' | 'digit' | 'special' | 'ascii-printable' | 'unicode'

export type CharacterClass = { kind: 'named'; name: NamedClass } | { kind: 'custom'; chars: string }

export interface PasswordRules {
  minLength: number | null
  maxLength: number | null
  maxConsecutive: number | null
  /** One entry per `required:` line; each is a union of classes. */
  required: CharacterClass[][]
  /** Classes from `allowed:` lines; empty means the author did not restrict the alphabet. */
  allowed: CharacterClass[]
}

export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const LOWER = 'abcdefghijklmnopqrstuvwxyz'
export const DIGITS = '0123456789'
/** Apple's `special`: every printable ASCII character that is not a letter or digit. */
export const SPECIAL = ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
const ASCII_PRINTABLE = UPPER + LOWER + DIGITS + SPECIAL

const NAMED: ReadonlySet<string> = new Set([
  'upper',
  'lower',
  'digit',
  'special',
  'ascii-printable',
  'unicode'
])

/** The characters a class stands for (`unicode` is treated as printable ASCII for generation). */
export function charactersOf(cls: CharacterClass): string {
  if (cls.kind === 'custom') return cls.chars
  switch (cls.name) {
    case 'upper':
      return UPPER
    case 'lower':
      return LOWER
    case 'digit':
      return DIGITS
    case 'special':
      return SPECIAL
    default:
      return ASCII_PRINTABLE
  }
}

export function emptyRules(): PasswordRules {
  return { minLength: null, maxLength: null, maxConsecutive: null, required: [], allowed: [] }
}

/** Parse a rule string; malformed properties are skipped, never thrown. */
export function parsePasswordRules(text: string): PasswordRules {
  const rules = emptyRules()
  let pos = 0
  const n = text.length
  const skipSpace = (): void => {
    while (pos < n && /\s/.test(text[pos])) pos++
  }
  const skipToNextProperty = (): void => {
    while (pos < n && text[pos] !== ';') pos++
    if (pos < n) pos++
  }
  while (pos < n) {
    skipSpace()
    if (pos >= n) break
    if (text[pos] === ';') {
      pos++
      continue
    }
    const nameStart = pos
    while (pos < n && /[a-zA-Z-]/.test(text[pos])) pos++
    const name = text.slice(nameStart, pos).toLowerCase()
    skipSpace()
    if (text[pos] !== ':') {
      skipToNextProperty()
      continue
    }
    pos++
    skipSpace()
    if (name === 'minlength' || name === 'maxlength' || name === 'max-consecutive') {
      const numStart = pos
      while (pos < n && /[0-9]/.test(text[pos])) pos++
      const value = parseInt(text.slice(numStart, pos), 10)
      if (Number.isFinite(value) && value > 0) {
        if (name === 'minlength') rules.minLength = value
        else if (name === 'maxlength') rules.maxLength = value
        else rules.maxConsecutive = value
      }
      skipToNextProperty()
      continue
    }
    if (name !== 'required' && name !== 'allowed') {
      skipToNextProperty()
      continue
    }
    const classes: CharacterClass[] = []
    for (;;) {
      skipSpace()
      if (pos >= n || text[pos] === ';') break
      if (text[pos] === '[') {
        const custom = parseCustomClass(text, pos)
        pos = custom.end
        if (custom.chars) classes.push({ kind: 'custom', chars: custom.chars })
      } else {
        const idStart = pos
        while (pos < n && /[a-zA-Z-]/.test(text[pos])) pos++
        const id = text.slice(idStart, pos).toLowerCase()
        if (NAMED.has(id)) classes.push({ kind: 'named', name: id as NamedClass })
        else if (pos === idStart) pos++
      }
      skipSpace()
      if (text[pos] === ',') pos++
    }
    if (pos < n) pos++
    if (classes.length === 0) continue
    if (name === 'required') rules.required.push(classes)
    else rules.allowed.push(...classes)
  }
  return rules
}

/** `[` … `]` with Apple's quirks: `-` only first, `]]` at the end for a literal `]`. */
function parseCustomClass(text: string, start: number): { chars: string; end: number } {
  let pos = start + 1
  const n = text.length
  const seen: string[] = []
  const first = pos
  while (pos < n) {
    const c = text[pos]
    if (c < ' ' || c > '~') {
      pos++
      continue
    }
    if (c === '-' && pos > first) {
      pos++
      continue
    }
    pos++
    if (c === ']') {
      if (pos < n && text[pos] === ']') {
        // `]]`: the first was a literal, the second closes the class.
        seen.push(']')
        pos++
      }
      break
    }
    if (!seen.includes(c)) seen.push(c)
  }
  return { chars: seen.join(''), end: pos }
}

/**
 * Published rules for a host: the exact hostname first, then each parent domain, so
 * `login.example.com` picks up rules filed under `example.com`.
 */
export function rulesForHost(host: string): { host: string; text: string } | null {
  let h = host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
  while (h) {
    const text = PASSWORD_RULES[h]
    if (text) return { host: h, text }
    const dot = h.indexOf('.')
    if (dot < 0) break
    h = h.slice(dot + 1)
  }
  return null
}

/** Human-readable summary shown next to the generator, e.g. "8 to 15 characters, needs a digit". */
export function describeRules(rules: PasswordRules): string {
  const parts: string[] = []
  if (rules.minLength !== null && rules.maxLength !== null)
    parts.push(`${rules.minLength} to ${rules.maxLength} characters`)
  else if (rules.minLength !== null) parts.push(`at least ${rules.minLength} characters`)
  else if (rules.maxLength !== null) parts.push(`at most ${rules.maxLength} characters`)
  const needs = rules.required.map((group) =>
    group
      .map((cls) => {
        if (cls.kind === 'custom') return `one of ${cls.chars}`
        switch (cls.name) {
          case 'upper':
            return 'an uppercase letter'
          case 'lower':
            return 'a lowercase letter'
          case 'digit':
            return 'a digit'
          case 'special':
            return 'a symbol'
          default:
            return 'any character'
        }
      })
      .join(' or ')
  )
  if (needs.length) parts.push(`needs ${needs.join(', ')}`)
  if (rules.maxConsecutive !== null)
    parts.push(`no more than ${rules.maxConsecutive} identical characters in a row`)
  return parts.join('; ')
}
