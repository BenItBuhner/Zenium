package app.zen.chromium.ext

import org.json.JSONObject

/**
 * `chrome.privacy`'s document-start layer, as the core's `ext.privacy.apply` carries it
 * (`extensionPrivacy.ts`, `WebViewPrivacyLayer`): whether `navigator.doNotTrack` reads `'1'` in
 * regular tabs' documents and in private tabs', with the two scripts that set a document's value
 * – `on` registered at document start on every tab view of a kind that holds it and run in its
 * open documents when the value comes, `off` run in the open documents when it goes (a view whose
 * kind stops holding it drops the document-start script; the next document reads the WebView's own
 * `null`). The `DNT: 1` header itself travels through the blocking engine as a rule set the core
 * installs (`builtin:extension-privacy`), not through here.
 */
data class ExtensionPrivacyLayer(
    val doNotTrack: Boolean,
    val doNotTrackPrivate: Boolean,
    val on: String,
    val off: String
) {
    /** Whether the extensions hold nothing for either kind of tab. */
    val isEmpty: Boolean
        get() = !doNotTrack && !doNotTrackPrivate

    /** Whether a tab of the kind (private or regular) reads `'1'`. */
    fun holds(privateTab: Boolean): Boolean = if (privateTab) doNotTrackPrivate else doNotTrack

    /** The script that moves an open document of the kind to this layer's value, or null when there is nothing to run. */
    fun scriptFor(privateTab: Boolean): String? = (if (holds(privateTab)) on else off).ifEmpty { null }

    /** One line for the log. */
    fun summary(): String = when {
        isEmpty -> "none"
        doNotTrack && doNotTrackPrivate -> "doNotTrack on (regular and private tabs)"
        doNotTrack -> "doNotTrack on (regular tabs)"
        else -> "doNotTrack on (private tabs)"
    }

    companion object {
        val EMPTY = ExtensionPrivacyLayer(false, false, "", "")

        /** The core's payload; a missing or malformed field reads as "not held" / no script. */
        fun fromJson(json: JSONObject): ExtensionPrivacyLayer {
            val script = json.optJSONObject("script")
            return ExtensionPrivacyLayer(
                doNotTrack = json.optBoolean("doNotTrack", false),
                doNotTrackPrivate = json.optBoolean("doNotTrackPrivate", false),
                on = script?.optString("on", "") ?: "",
                off = script?.optString("off", "") ?: ""
            )
        }
    }
}
