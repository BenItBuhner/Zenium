package app.zen.chromium

import android.Manifest
import android.content.pm.PackageManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import androidx.core.content.ContextCompat

/**
 * Bridges WebView permission prompts to the core's per-site decisions (which prompt the user once
 * and remember the answer), then to Android's runtime permissions.
 */
class Permissions(private val host: PageHost) {
    private var seq = 0
    private val pending = HashMap<String, (Boolean) -> Unit>()

    /** The core decided (`permission.respond`). */
    fun respond(requestId: String, allow: Boolean) {
        pending.remove(requestId)?.invoke(allow)
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
        ask(permissionName, url, view.tabId, if (permissionName == "mediaKeySystem") emptyList() else mediaTypes) { allow ->
            if (!allow) {
                request.deny()
                return@ask
            }
            ensureRuntime(runtime) { granted ->
                if (granted) request.grant(wanted.toTypedArray()) else request.deny()
            }
        }
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
