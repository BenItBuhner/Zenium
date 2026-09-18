/**
 * Where the declarativeNetRequest translator's rule sets go on desktop: the shared engine sink
 * (`core/extensions/dnr/engineSink.ts`), which feeds the core's request-blocking engine behind
 * the session's `webRequest` multiplexer (`platform/blocking.ts`) and scopes every set to the
 * partitions its extension is loaded into. Redirects to an extension's `use_dynamic_url`
 * resources are rewritten on the way in to the origin Zenium serves them from
 * (`resourceOrigin.ts`, the sink's `RuleSetRewriter`); Chromium refuses them at the static
 * `chrome-extension://<id>/` URL. Decisions come back through `ElectronBlocking.onDecision`
 * into `DeclarativeNetRequestHostApi.decided`.
 */
export {
  createDnrSink,
  InMemoryRuleSink,
  type DnrSinkScope,
  type EngineDecisionReport,
  type RuleSetRewriter,
  type ScopedRuleSink
} from '../../../core/extensions/dnr/engineSink'
