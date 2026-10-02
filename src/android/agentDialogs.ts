import type {
  AgentDialogAnswer,
  AgentDialogRuleScope,
  PageDialogAnswered,
  PageDialogKind
} from '@shared/types'

/**
 * The Android side of an AI agent's dialog policy (`browser_dialog_policy`,
 * `HostCapabilities.agentDialogPolicy`): Kotlin's `WebChromeClient` answers the page's `alert`
 * / `confirm` / `prompt` and its "Leave site?" itself – the WebView's one renderer waits in
 * the call for every page and for the chrome, so nothing the core draws could hold a dialog
 * for `browser_handle_dialog` – and so the policy goes DOWN to the view ahead of the action
 * (`view.setDialogPolicy`, the core's `AgentDialogPolicy` as it is) and every answer comes
 * back UP as the `pageDialogAnswered` view event (`DialogPolicyAnswer.kt` builds it), which the
 * core turns into the agent's Notice and the spending of a `once` rule. Kept pure so the
 * decode is tested without a bridge.
 */

const KINDS: readonly PageDialogKind[] = ['alert', 'confirm', 'prompt', 'beforeunload']
const RULES: readonly AgentDialogRuleScope[] = ['tab', 'session', 'default']

/** The answer as Kotlin's report carries it, or null for one the core cannot read. */
function answerOf(value: unknown): AgentDialogAnswer | null {
  if (value === 'accept' || value === 'dismiss' || value === 'leave' || value === 'stay')
    return value
  if (typeof value === 'object' && value !== null) {
    const { text } = value as { text?: unknown }
    if (typeof text === 'string') return { text }
  }
  return null
}

/**
 * Kotlin's `pageDialogAnswered` view event as the core's `PageDialogAnswered`, or null for a
 * report the core cannot read (an older or a newer APK's shape): a report that is dropped
 * costs the agent one Notice, a report misread would spend the wrong rule. The answer is
 * checked against the kind as the core's own path keeps it (`sanitizeResponse`): an alert
 * is only ever accepted, a "Leave site?" only left or stayed, text only with a prompt. The
 * message is capped where the core quotes it (500 characters); `defaultValue` rides with a
 * prompt only.
 */
export function pageDialogAnsweredOf(payload: unknown): PageDialogAnswered | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  const kind = KINDS.find((k) => k === p.kind)
  if (!kind || typeof p.url !== 'string' || typeof p.message !== 'string') return null
  const rule = RULES.find((r) => r === p.rule)
  if (!rule) return null
  const answer = answerOf(p.answer)
  if (!answer) return null
  if (kind === 'alert' && answer !== 'accept') return null
  const leaving = answer === 'leave' || answer === 'stay'
  if (leaving !== (kind === 'beforeunload')) return null
  if (typeof answer === 'object' && kind !== 'prompt') return null
  const report: PageDialogAnswered = {
    kind,
    url: p.url,
    message: p.message.slice(0, 500),
    answer,
    rule
  }
  if (kind === 'prompt' && typeof p.defaultValue === 'string') report.defaultValue = p.defaultValue
  return report
}
