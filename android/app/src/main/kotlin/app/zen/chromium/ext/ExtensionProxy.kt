package app.zen.chromium.ext

import android.util.Log
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import app.zen.chromium.arr
import app.zen.chromium.bool
import org.json.JSONObject
import java.util.concurrent.Executor

/**
 * `chrome.proxy.settings` applied: the one proxy override the WebView takes per app process
 * (`androidx.webkit.ProxyController`), set from the runtime's resolved configuration
 * (`ext.proxy.set`, the rules already in the WebView's terms: a proxy URL per scheme filter,
 * `direct://` for a direct connection, the bypass list and Chrome's two bypass tokens as the
 * builder's flags) and cleared when no extension controls the setting (`ext.proxy.clear`).
 * The override covers every WebView of the process, the private tabs' included, so the runtime
 * applies the regular configuration alone. A WebView without the feature (or a configuration
 * it refuses) answers with the message; the runtime reports it to the extension as Chrome's
 * `onProxyError`.
 */
object ExtensionProxy {
    private const val TAG = "ZenExtProxy"

    /** `direct://` in a rule: a direct connection for the scheme filter (`ProxyConfig.Builder.addDirect`). */
    const val DIRECT = "direct://"

    class Rule(val url: String, val scheme: String)

    /** What `ext.proxy.set` carries, read from the runtime's JSON. */
    class Plan(
        val rules: List<Rule>,
        val bypass: List<String>,
        val bypassSimpleHostnames: Boolean,
        val removeImplicitRules: Boolean
    ) {
        companion object {
            fun of(args: JSONObject): Plan {
                val rules = args.arr("rules").let { a ->
                    List(a.length()) { i ->
                        val rule = a.optJSONObject(i) ?: JSONObject()
                        Rule(rule.optString("url", ""), schemeFilter(rule.optString("scheme", "*")))
                    }
                }.filter { it.url.isNotEmpty() }
                val bypass = args.arr("bypass").let { a -> List(a.length()) { i -> a.optString(i, "") } }.filter { it.isNotEmpty() }
                return Plan(rules, bypass, args.bool("bypassSimpleHostnames"), args.bool("removeImplicitRules"))
            }

            /** The runtime's scheme filter as the builder's constant; anything else is every scheme. */
            fun schemeFilter(scheme: String): String = when (scheme) {
                "http" -> ProxyConfig.MATCH_HTTP
                "https" -> ProxyConfig.MATCH_HTTPS
                else -> ProxyConfig.MATCH_ALL_SCHEMES
            }
        }
    }

    /** Whether this WebView takes a proxy override at all (Chromium 68+; both recipes do). */
    fun supported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)

    /** The builder's configuration for a plan (the rules in order: the WebView tries them first to last for a URL's scheme). */
    fun configOf(plan: Plan): ProxyConfig {
        val builder = ProxyConfig.Builder()
        for (rule in plan.rules) {
            if (rule.url == DIRECT) builder.addDirect(rule.scheme) else builder.addProxyRule(rule.url, rule.scheme)
        }
        for (pattern in plan.bypass) builder.addBypassRule(pattern)
        if (plan.bypassSimpleHostnames) builder.bypassSimpleHostnames()
        if (plan.removeImplicitRules) builder.removeImplicitRules()
        return builder.build()
    }

    /**
     * Apply the plan; `done` hears null once the WebView applied it, or the reason it did not
     * (an unsupported WebView, a rule the builder refuses).
     */
    fun apply(plan: Plan, executor: Executor, done: (String?) -> Unit) {
        if (!supported()) {
            done(UNSUPPORTED)
            return
        }
        try {
            val config = configOf(plan)
            ProxyController.getInstance().setProxyOverride(config, executor) {
                Log.i(TAG, "proxy override applied: ${plan.rules.size} rule(s), ${plan.bypass.size} bypass")
                done(null)
            }
        } catch (e: Exception) {
            Log.w(TAG, "proxy override refused: ${e.message}")
            done(e.message ?: e.javaClass.simpleName)
        }
    }

    /** Back to the system's settings. */
    fun clear(executor: Executor, done: (String?) -> Unit) {
        if (!supported()) {
            done(null)
            return
        }
        try {
            ProxyController.getInstance().clearProxyOverride(executor) {
                Log.i(TAG, "proxy override cleared")
                done(null)
            }
        } catch (e: Exception) {
            Log.w(TAG, "proxy override not cleared: ${e.message}")
            done(e.message ?: e.javaClass.simpleName)
        }
    }

    const val UNSUPPORTED = "This WebView takes no proxy override (androidx.webkit PROXY_OVERRIDE is not supported)."
}
