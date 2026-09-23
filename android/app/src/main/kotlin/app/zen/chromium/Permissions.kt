package app.zen.chromium

import android.Manifest
import android.content.pm.PackageManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * A runtime permission the app asked for in its own name (voice search's microphone, `Voice.kt`;
 * the scanner's camera, `QrScan.kt`) once the system prompt has answered. A refusal for this once
 * and one for good are told apart by `shouldShowRequestPermissionRationale` read AFTER the
 * refusal: true while the system would show the prompt once more, false once it would not (the
 * user chose "Don't ask again", refused twice on Android 11+, or a device policy holds the
 * permission), when only the app's settings screen can turn it on.
 */
enum class RuntimeGrant {
    GRANTED,
    /** Refused this once: asking again shows the system prompt again. */
    DENIED,
    /** Refused for good: the prompt will not show again, Settings is the way on. */
    DENIED_PERMANENTLY;

    companion object {
        fun of(granted: Boolean, canAskAgain: Boolean): RuntimeGrant = when {
            granted -> GRANTED
            canAskAgain -> DENIED
            else -> DENIED_PERMANENTLY
        }
    }
}

/**
 * Bridges WebView permission prompts to the core's per-site decisions (which prompt the user once
 * and remember the answer), then to Android's runtime permissions; and asks for the permissions
 * the app needs in its own name ([requestForApp]).
 */
class Permissions(private val host: PageHost) {
    private var seq = 0
    private val pending = HashMap<String, (Boolean) -> Unit>()

    /** The core decided (`permission.respond`). */
    fun respond(requestId: String, allow: Boolean) {
        pending.remove(requestId)?.invoke(allow)
    }

    /**
     * A permission the app itself needs (voice search's microphone, the scanner's camera), unlike
     * a page's: no per-site decision of the core's and no remembered answer, straight to the system
     * prompt when it is not granted, and the prompt's answer read as a [RuntimeGrant]. `then` runs
     * on the main thread.
     */
    fun requestForApp(permission: String, then: (RuntimeGrant) -> Unit) {
        val activity = host.activity
        if (ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED) {
            then(RuntimeGrant.GRANTED)
            return
        }
        activity.requestRuntimePermissions(listOf(permission)) { results ->
            // An empty map is a request overtaken by another: not granted, and not for good either.
            val granted = results[permission] == true
            val canAskAgain = results.isEmpty() || ActivityCompat.shouldShowRequestPermissionRationale(activity, permission)
            then(RuntimeGrant.of(granted, canAskAgain))
        }
    }

    private fun ask(
        permission: String,
        url: String,
        tabId: String,
        mediaTypes: List<String> = emptyList(),
        then: (Boolean) -> Unit
    ) {
        val id = "perm_${++seq}"
        pending[id] = then
        val payload = json("requestId" to id, "permission" to permission, "url" to url, "tabId" to tabId)
        if (mediaTypes.isNotEmpty()) payload.put("mediaTypes", org.json.JSONArray(mediaTypes))
        host.hostEvent("permission.request", payload)
    }

    fun onPermissionRequest(view: TabWebView, request: PermissionRequest) {
        val resources = request.resources
        val wanted = ArrayList<String>()
        val runtime = ArrayList<String>()
        val mediaTypes = ArrayList<String>()
        var permissionName = "media"
        for (r in resources) {
            when (r) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> { wanted += r; runtime += Manifest.permission.CAMERA; mediaTypes += "video" }
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> { wanted += r; runtime += Manifest.permission.RECORD_AUDIO; mediaTypes += "audio" }
                PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID -> { wanted += r; permissionName = "mediaKeySystem" }
                PermissionRequest.RESOURCE_MIDI_SYSEX -> { /* denied, like the desktop */ }
            }
        }
        if (wanted.isEmpty()) {
            request.deny()
            return
        }
        if (wanted.size == 1 && wanted[0] == PermissionRequest.RESOURCE_VIDEO_CAPTURE) permissionName = "camera"
        if (wanted.size == 1 && wanted[0] == PermissionRequest.RESOURCE_AUDIO_CAPTURE) permissionName = "microphone"
        val url = request.origin.toString().ifEmpty { view.url ?: "" }
        val capture = captureUseOf(wanted)
        ask(permissionName, url, view.tabId, if (permissionName == "mediaKeySystem") emptyList() else mediaTypes) { allow ->
            if (!allow) {
                request.deny()
                return@ask
            }
            ensureRuntime(runtime) { granted ->
                if (!granted) {
                    request.deny()
                    return@ensureRuntime
                }
                request.grant(wanted.toTypedArray())
                // The page may capture now: the "<site> is using your microphone" card and the
                // service that keeps the capture alive behind other apps start here, while the
                // app is in front (NOT-13; the page's own report confirms or ends it).
                if (capture.any) host.capture?.granted(view.tabId, view.url ?: url, capture, Profiles.isPrivate(view.containerId))
            }
        }
    }

    /** The page took a capture request back before it was answered: an arm it had is dropped. */
    fun onPermissionRequestCanceled(view: TabWebView, request: PermissionRequest) {
        if (captureUseOf(request.resources?.toList() ?: emptyList()).any) host.capture?.cancelled(view.tabId)
    }

    fun onGeolocation(view: TabWebView, origin: String, callback: GeolocationPermissions.Callback) {
        ask("geolocation", origin, view.tabId) { allow ->
            if (!allow) {
                callback.invoke(origin, false, false)
                return@ask
            }
            ensureRuntime(listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) { granted ->
                callback.invoke(origin, granted, false)
            }
        }
    }

    private fun captureUseOf(resources: List<String>): CaptureUse = CaptureUse(
        camera = PermissionRequest.RESOURCE_VIDEO_CAPTURE in resources,
        microphone = PermissionRequest.RESOURCE_AUDIO_CAPTURE in resources
    )

    private fun ensureRuntime(permissions: List<String>, then: (Boolean) -> Unit) {
        val missing = permissions.filter {
            ContextCompat.checkSelfPermission(host.activity, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            then(true)
            return
        }
        host.activity.requestRuntimePermissions(missing) { results ->
            // Location: coarse alone is still a grant.
            then(results.values.any { it } && (permissions.size > 1 || results.values.all { it }))
        }
    }
}
