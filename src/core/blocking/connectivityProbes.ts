/**
 * The builtin exception for connectivity and captive-portal probes.
 *
 * Operating systems and browsers find out whether the network answers by fetching a URL that
 * returns an empty 204 (Google's `generate_204`, Microsoft's `connecttest.txt`, Apple's
 * `hotspot-detect.html`), and Google's sign-in pages fetch `accounts.google.com/generate_204`
 * for the same reason. EasyPrivacy blocks `/generate_204?` as a tracking-pixel heuristic, so the
 * Balanced level shows "1 blocked" on every Google sign-in and the page's own telemetry trips
 * on `ERR_BLOCKED_BY_CLIENT`. Chrome's own lists leave these probes alone; so does Zenium, with
 * one `allow` rule per probe in the {@link BUILTIN_RULE_SETS.connectivityProbes} set.
 *
 * The set is structured (no filter text), so the store writes its summary into
 * `blocking/index.json` and its rules into its `blocking/sets/` document, and the Kotlin engine
 * on Android evaluates the very same rules. It sits
 * in its own priority band above the lists and below the user's, is always enabled and is not a
 * user list: Settings does not show it.
 */
import { BUILTIN_RULE_SETS, RULE_SET_PRIORITY, type Rule, type RuleSet } from './rules'

/**
 * `host/path` of every probe. `||host/path^` allows the path on the host and its subdomains,
 * with or without a query string, and nothing else on the host.
 */
export const CONNECTIVITY_PROBES: readonly string[] = [
  'accounts.google.com/generate_204',
  'www.gstatic.com/generate_204',
  'connectivitycheck.gstatic.com/generate_204',
  'clients3.google.com/generate_204',
  'play.googleapis.com/generate_204',
  'www.google.com/generate_204',
  'android.clients.google.com/generate_204',
  'www.msftconnecttest.com/connecttest.txt',
  'captive.apple.com/hotspot-detect.html'
]

/** One `allow` rule per probe, ids 1..n in the order of {@link CONNECTIVITY_PROBES}. */
export function connectivityProbeRules(): Rule[] {
  return CONNECTIVITY_PROBES.map((probe, index) => ({
    id: index + 1,
    action: { type: 'allow' },
    condition: { urlFilter: `||${probe}^` }
  }))
}

/** The builtin set as the blocking service registers it. */
export function connectivityProbesRuleSet(): RuleSet & { rules: Rule[] } {
  return {
    id: BUILTIN_RULE_SETS.connectivityProbes,
    source: 'builtin',
    priority: RULE_SET_PRIORITY.connectivityProbes,
    enabled: true,
    rules: connectivityProbeRules()
  }
}
