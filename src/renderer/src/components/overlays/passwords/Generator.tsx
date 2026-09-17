import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Copy, RefreshCw } from 'lucide-react'
import type { GeneratorOptions } from '@shared/types'
import { cmd } from '@renderer/lib/api'
import { pushToast } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Slider } from '../../ui/slider'
import {
  Btn,
  CheckRow,
  Description,
  IconBtn,
  Menulist,
  RadioRow,
  Secret,
  SettingRow
} from './shared'

const DEFAULT_OPTIONS: GeneratorOptions = {
  mode: 'password',
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  words: 4,
  separator: '-',
  capitalize: true,
  includeDigit: true
}

const SEPARATORS: Array<{ value: string; label: string }> = [
  { value: '-', label: 'Hyphen' },
  { value: '.', label: 'Period' },
  { value: ' ', label: 'Space' },
  { value: '_', label: 'Underscore' }
]

/** The last options used, so the generator opens the way it was left within a session. */
let remembered: GeneratorOptions = DEFAULT_OPTIONS

/**
 * Strong password generator: character classes and length, or an EFF-wordlist passphrase. With
 * a `domain` the site's published rules (apple/password-manager-resources) are applied and named.
 * The output sits in an inner box; the options are Proton radios, checkboxes and a menulist.
 */
export function Generator({
  domain,
  onUse,
  className
}: {
  domain?: string
  /** Offered when the generator sits next to a password field (the form keeps the primary). */
  onUse?: (password: string) => void
  className?: string
}): JSX.Element {
  const [options, setOptions] = useState<GeneratorOptions>(remembered)
  const [password, setPassword] = useState('')
  const [rules, setRules] = useState<string | null>(null)
  const [spin, setSpin] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    remembered = options
    const id = ++seq.current
    void cmd('passwords.generate', { options, domain }).then((result) => {
      if (seq.current !== id) return
      setPassword(result.password)
      setRules(result.rules)
    })
  }, [options, domain, spin])

  const set = (patch: Partial<GeneratorOptions>): void => setOptions((o) => ({ ...o, ...patch }))
  const classes = [options.upper, options.lower, options.digits, options.symbols].filter(Boolean)
  const toggleClass = (key: 'upper' | 'lower' | 'digits' | 'symbols', on: boolean): void => {
    // At least one class stays on, otherwise there is nothing to draw from.
    if (!on && classes.length <= 1) return
    set({ [key]: on })
  }
  const copy = (): void => {
    void navigator.clipboard?.writeText(password)
    pushToast('Password copied')
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="zen-v2-pw-inner-box flex items-center gap-2">
        <output aria-label="Generated password" className="min-w-0 flex-1 py-1">
          <Secret value={password} />
        </output>
        <IconBtn label="Generate another" onClick={() => setSpin((n) => n + 1)}>
          <RefreshCw />
        </IconBtn>
        <IconBtn label="Copy" onClick={copy}>
          <Copy />
        </IconBtn>
      </div>

      <div role="radiogroup" aria-label="Kind" className="flex flex-col">
        <RadioRow
          checked={options.mode === 'password'}
          onSelect={() => set({ mode: 'password' })}
          label="Password"
          description="Letters, digits and symbols"
        />
        <RadioRow
          checked={options.mode === 'passphrase'}
          onSelect={() => set({ mode: 'passphrase' })}
          label="Passphrase"
          description="Words from the EFF list, easier to type"
        />
      </div>

      {options.mode === 'password' ? (
        <div className="flex flex-col">
          <SettingRow label="Length">
            <Slider
              min={8}
              max={64}
              step={1}
              aria-label="Length"
              className="w-40"
              value={[options.length]}
              onValueChange={([v]) => v !== undefined && set({ length: v })}
            />
            <span className="w-7 text-right tabular-nums">{options.length}</span>
          </SettingRow>
          <CheckRow
            label="Uppercase letters"
            checked={options.upper}
            onChange={(v) => toggleClass('upper', v)}
          />
          <CheckRow
            label="Lowercase letters"
            checked={options.lower}
            onChange={(v) => toggleClass('lower', v)}
          />
          <CheckRow
            label="Digits"
            checked={options.digits}
            onChange={(v) => toggleClass('digits', v)}
          />
          <CheckRow
            label="Symbols"
            checked={options.symbols}
            onChange={(v) => toggleClass('symbols', v)}
          />
        </div>
      ) : (
        <div className="flex flex-col">
          <SettingRow label="Words">
            <Slider
              min={3}
              max={10}
              step={1}
              aria-label="Words"
              className="w-40"
              value={[options.words]}
              onValueChange={([v]) => v !== undefined && set({ words: v })}
            />
            <span className="w-7 text-right tabular-nums">{options.words}</span>
          </SettingRow>
          <CheckRow
            label="Capitalise words"
            checked={options.capitalize}
            onChange={(v) => set({ capitalize: v })}
          />
          <CheckRow
            label="Include a digit"
            checked={options.includeDigit}
            onChange={(v) => set({ includeDigit: v })}
          />
          <SettingRow label="Separator">
            <Menulist
              label="Separator"
              value={options.separator}
              options={SEPARATORS}
              onChange={(separator) => set({ separator })}
            />
          </SettingRow>
        </div>
      )}

      {rules && <Description>Site rules from {rules}</Description>}

      {onUse && (
        <div className="flex justify-end">
          <Btn onClick={() => onUse(password)} disabled={!password}>
            Use this password
          </Btn>
        </div>
      )}
    </div>
  )
}
