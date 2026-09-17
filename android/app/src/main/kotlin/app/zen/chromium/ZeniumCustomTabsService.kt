package app.zen.chromium

import android.net.Uri
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsService
import androidx.browser.customtabs.CustomTabsSessionToken
import java.util.concurrent.ConcurrentHashMap

/**
 * The Custom Tabs provider endpoint. Sessions are deliberately lightweight: WebView has no
 * Chromium-style speculative renderer, but retaining the likely URL makes the association valid
 * and leaves a prewarm seam for a future WebView implementation.
 */
class ZeniumCustomTabsService : CustomTabsService() {
    private val sessions = ConcurrentHashMap.newKeySet<CustomTabsSessionToken>()
    private val likelyUrls = ConcurrentHashMap<CustomTabsSessionToken, Uri>()

    override fun warmup(flags: Long): Boolean = true

    override fun newSession(sessionToken: CustomTabsSessionToken): Boolean {
        sessions += sessionToken
        return true
    }

    override fun mayLaunchUrl(
        sessionToken: CustomTabsSessionToken,
        url: Uri?,
        extras: Bundle?,
        otherLikelyBundles: List<Bundle>?
    ): Boolean {
        if (sessionToken !in sessions) return false
        if (url?.scheme in setOf("http", "https")) likelyUrls[sessionToken] = url
        return true
    }

    override fun extraCommand(commandName: String, args: Bundle?): Bundle? = null

    override fun updateVisuals(sessionToken: CustomTabsSessionToken, bundle: Bundle?): Boolean =
        sessionToken in sessions

    override fun requestPostMessageChannel(
        sessionToken: CustomTabsSessionToken,
        postMessageOrigin: Uri
    ): Boolean = false

    override fun postMessage(
        sessionToken: CustomTabsSessionToken,
        message: String,
        extras: Bundle?
    ): Int = CustomTabsService.RESULT_FAILURE_DISALLOWED

    override fun validateRelationship(
        sessionToken: CustomTabsSessionToken,
        relation: Int,
        origin: Uri,
        extras: Bundle?
    ): Boolean = false

    override fun receiveFile(
        sessionToken: CustomTabsSessionToken,
        uri: Uri,
        purpose: Int,
        extras: Bundle?
    ): Boolean = false

    override fun cleanUpSession(sessionToken: CustomTabsSessionToken): Boolean {
        likelyUrls.remove(sessionToken)
        return sessions.remove(sessionToken)
    }
}
