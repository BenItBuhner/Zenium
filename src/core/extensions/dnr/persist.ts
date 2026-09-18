import type { DnrPersistedState } from './state'

/**
 * A persisted declarativeNetRequest record (`DnrPersistedState`) read back from its JSON
 * document, or undefined when the document is not one (the host then seeds the record from the
 * manifest again). Shared by the hosts' `DnrStateIO` implementations: the desktop's file under
 * `<userData>/zen/extension-dnr/`, Android's document in the profile store.
 */
export function parsePersistedState(text: string): DnrPersistedState | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (record.version !== 1) return undefined
  const enabled = Array.isArray(record.enabledStaticRulesetIds)
    ? record.enabledStaticRulesetIds.filter((id): id is string => typeof id === 'string')
    : []
  const disabled: Record<string, number[]> = {}
  if (record.disabledStaticRuleIds && typeof record.disabledStaticRuleIds === 'object') {
    for (const [id, ids] of Object.entries(
      record.disabledStaticRuleIds as Record<string, unknown>
    )) {
      if (Array.isArray(ids)) {
        disabled[id] = ids.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
      }
    }
  }
  return {
    version: 1,
    enabledStaticRulesetIds: enabled,
    disabledStaticRuleIds: disabled,
    dynamicRules: Array.isArray(record.dynamicRules)
      ? (record.dynamicRules as DnrPersistedState['dynamicRules'])
      : [],
    displayActionCountAsBadgeText: record.displayActionCountAsBadgeText === true
  }
}
