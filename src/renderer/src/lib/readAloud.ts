import {
  READ_ALOUD_RATES,
  baseLanguage,
  type ReadAloudState,
  type ReadAloudVoice,
  type ReadAloudVoicesResult
} from '@shared/readAloud'
import { languageName } from '@shared/languageNames'
import { run } from '@renderer/lib/api'
import type { MenulistOption } from '@renderer/components/extensions/V2Menulist'
import type { RowOption, ValueRow } from '@renderer/components/pages/settings/model'

/**
 * What the read-aloud player (`components/content/ReadAloudPanel.tsx`) shows and offers, as
 * pure functions of the model's state (`UIState.readAloud`, services' `ReadAloudService`): the
 * speed chip's ladder, the progress and error lines, and the voice picker's rows. The panel
 * renders these; nothing here holds state.
 */

/** The chip's top rung: Edge's read aloud runs .5× to 2× (the model's ladder goes on to 4×). */
const CHIP_MAX_RATE = 2

/**
 * The speed chip's rungs: the model's ladder (`READ_ALOUD_RATES`, Chrome's 0.5 / 0.8 / 1 / 1.2 /
 * 1.5 / 2 / 3 / 4) up to 2×, so every speed the chip sets is one the model's other controls
 * name too. One tap steps up a rung and wraps from the top to .5×; a rate from elsewhere (3×
 * from the desktop's settings, a value between rungs) steps to the first rung above it, or to
 * .5× past the top.
 */
export const READ_ALOUD_RATE_STEPS: readonly number[] = READ_ALOUD_RATES.filter(
  (r) => r <= CHIP_MAX_RATE
)

export function nextRate(rate: number): number {
  const i = READ_ALOUD_RATE_STEPS.findIndex((r) => Math.abs(r - rate) < 0.001)
  if (i >= 0) return READ_ALOUD_RATE_STEPS[(i + 1) % READ_ALOUD_RATE_STEPS.length]!
  return READ_ALOUD_RATE_STEPS.find((r) => r > rate) ?? READ_ALOUD_RATE_STEPS[0]!
}

/** `1×`, `1.2×`, `0.5×`: the number as typed, no trailing zeros, the multiplication sign. */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`
}

/**
 * The speed chip's accessible name (v2 §9.34): the setting, then the value as it is said –
 * `Speed, 1.2 times` – so a screen reader names what the chip sets and where it stands, where
 * the painted `1.2×` alone would be read as a bare number and a multiplication sign.
 */
export function describeRate(rate: number): string {
  return `Speed, ${Number(rate.toFixed(2))} times`
}

/**
 * The widest of the chip's labels, `0.5×`: what sizes the chip, so it holds one width across the
 * ladder in whatever font the device draws (a `min-width` in pixels is right for one font only).
 * In tabular figures every four-character rung is as wide as this one; `1×` and `2×` are narrower
 * and centre in the same box.
 */
export const READ_ALOUD_RATE_SIZER: string = READ_ALOUD_RATE_STEPS.map(formatRate).reduce(
  (widest, label) => (label.length > widest.length ? label : widest)
)

/**
 * The header's trailing value: the sentence being read over the count, `9 / 42`; empty before
 * the count is known or the first sentence has begun (the model's -1).
 */
export function formatProgress(session: ReadAloudState): string {
  if (session.sentenceCount <= 0 || session.sentenceIndex < 0) return ''
  const current = Math.min(session.sentenceCount, session.sentenceIndex + 1)
  return `${current} / ${session.sentenceCount}`
}

/** The model's error codes as the one line the panel shows in place of the progress. */
export function errorText(error: string | undefined): string {
  switch (error) {
    case 'no-voice':
      return 'No voice for this language'
    case 'no-text':
      return 'Nothing to read on this page'
    default:
      return 'Couldn’t read this page'
  }
}

/**
 * The voice picker as a §9.13 value row: the voices for the text's language first (base
 * language match, `en` for `en-GB`), every other language under one heading; each row the
 * voice's name with where it runs and its quality as the description. Before the list arrives
 * the sheet has one row naming the wait; with none, one row saying so. The current voice is the
 * session's, or the model's per-language default while the session has none yet.
 */
export function voiceRow(session: ReadAloudState, voices: ReadAloudVoicesResult | null): ValueRow {
  const options: RowOption[] = voices
    ? voiceOptions(voices.voices, session.lang)
    : [{ value: '', label: 'Loading voices…' }]
  if (voices && options.length === 0) options.push({ value: '', label: 'No voices installed' })
  const current = session.voiceId ?? voices?.byLanguage[session.lang] ?? ''
  return {
    kind: 'value',
    id: 'read-aloud-voice',
    label: 'Voice',
    sheetDescription:
      'The voices installed on this device. The choice is remembered for the language.',
    value: current,
    options,
    onChange: (voiceId) => {
      if (voiceId) run('readAloud.setVoice', { voiceId })
    }
  }
}

export function voiceOptions(voices: readonly ReadAloudVoice[], lang: string): RowOption[] {
  const base = baseLanguage(lang)
  const same: RowOption[] = []
  const other: RowOption[] = []
  for (const voice of voices) {
    const option: RowOption = {
      value: voice.id,
      label: voice.name,
      description: voiceDescription(voice)
    }
    if (baseLanguage(voice.lang) === base) same.push(option)
    else other.push({ ...option, group: 'Other languages' })
  }
  return [...same, ...other]
}

function voiceDescription(voice: ReadAloudVoice): string {
  const parts = [voice.local ? 'On this device' : 'Needs a network']
  if (voice.quality === 'high') parts.push('High quality')
  else if (voice.quality === 'low') parts.push('Low quality')
  return parts.join(' · ')
}

/** The desktop voice control's label while the list is on its way, and while the session has no voice yet. */
export const VOICE_PLACEHOLDER = 'Voice'

/**
 * The desktop player's voice menulist (§9.13's popover): the voices for the text's language
 * first under their names, then the other languages' voices with their language after the
 * name – the popover has no headings, so the language rides on the label – each with the phone
 * picker's one-line description (where the voice runs, its quality). Before the list arrives,
 * or while the session has no voice among them, one placeholder row holds the control's label.
 */
export function voiceMenulistOptions(
  voices: ReadAloudVoicesResult | null,
  lang: string,
  current: string
): MenulistOption<string>[] {
  const base = baseLanguage(lang)
  const same: MenulistOption<string>[] = []
  const other: MenulistOption<string>[] = []
  for (const voice of voices?.voices ?? []) {
    const description = voiceDescription(voice)
    if (baseLanguage(voice.lang) === base) {
      same.push({ value: voice.id, label: voice.name, description })
    } else {
      other.push({
        value: voice.id,
        label: `${voice.name} · ${languageName(voice.lang)}`,
        description
      })
    }
  }
  const options = [...same, ...other]
  if (!options.some((option) => option.value === current)) {
    options.unshift({ value: '', label: voices ? VOICE_PLACEHOLDER : `${VOICE_PLACEHOLDER}…` })
  }
  return options
}

/** The voice the desktop control shows: the session's, else the model's default for the language, else none. */
export function currentVoiceId(
  session: ReadAloudState,
  voices: ReadAloudVoicesResult | null
): string {
  return session.voiceId ?? voices?.byLanguage[session.lang] ?? ''
}
