import type { PrivacySettings, ProtectionCheck } from '@shared/privacy'
import { cmd } from './api'
import { customResolverProblem, isValidApiKey, PROTECTION_TEXT } from './protectionUi'

/**
 * The two commits behind Settings > Privacy and Security's busy forms (design-language-v2-draft
 * §9.30), shared by the desktop pane's fields (`overlays/ProtectionSection.tsx`) and the phone's
 * field sheets (`pages/settings/protectionRows.tsx`): a value is refused at once when it is
 * malformed, kept at once when it is the stored value or empty, and otherwise tried – the key
 * against Google's API, the resolver with one DNS question – before it is kept. A string is the
 * field's validation text; `undefined` accepts; a promise is the form's busy time.
 */
export type Commit = string | undefined | Promise<string | undefined>

type SetPrivacy = (patch: Partial<PrivacySettings>) => void

/** A `ProtectionCheck` answer read as a field's validation text: nothing for a value that passed. */
function refusal(check: ProtectionCheck | null | undefined): string | undefined {
  return check && !check.ok ? check.problem : undefined
}

/** The Google Safe Browsing key as typed: kept once the API takes it, removed when cleared. */
export function commitApiKey(current: string, value: string, setP: SetPrivacy): Commit {
  const key = value.trim()
  if (!isValidApiKey(key)) return PROTECTION_TEXT.safeBrowsing.apiKey.invalid
  if (key === current) return undefined
  if (!key) {
    setP({ safeBrowsingApiKey: '' })
    return undefined
  }
  return cmd('protection.checkApiKey', { key }).then((check) => {
    const problem = refusal(check)
    if (!problem) setP({ safeBrowsingApiKey: key })
    return problem
  })
}

/** The custom resolver's DNS-over-HTTPS address: kept once the resolver answers, removed when cleared. */
export function commitCustomResolver(current: string, value: string, setP: SetPrivacy): Commit {
  const url = value.trim()
  const problem = customResolverProblem(url)
  if (problem) return problem
  if (url === current) return undefined
  if (!url) {
    setP({ secureDnsCustomUrl: '' })
    return undefined
  }
  return cmd('protection.checkResolver', { url }).then((check) => {
    const refused = refusal(check)
    if (!refused) setP({ secureDnsCustomUrl: url })
    return refused
  })
}
