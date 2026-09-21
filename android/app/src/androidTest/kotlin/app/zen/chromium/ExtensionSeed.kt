package app.zen.chromium

import app.zen.chromium.ext.ExtensionFiles
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * How a driver turns the unpacked extensions a workflow pushed under `files/zen/extensions/<id>/`
 * into what the store attaches on start: `<root>/<id>/<version>/` install directories and the
 * records of `extensions.json` pointing at them (the desktop's registry schema, version 2). Shared
 * by [ExtensionDemo] (every folder under the root, enabled) and [ExtensionScrollBudget] (a named
 * set, attached one scene at a time).
 */
object ExtensionSeed {
    /**
     * `<root>/<id>/manifest.json` (an unpacked folder) becomes `<root>/<id>/<version>/`, which is
     * returned; a folder already laid out as an install returns its version directory; null when
     * the folder holds neither.
     */
    fun layOutInstall(idDir: File): File? {
        val flat = File(idDir, "manifest.json")
        if (!flat.isFile) return idDir.listFiles()?.firstOrNull { it.isDirectory && File(it, "manifest.json").isFile }
        val version = runCatching { JSONObject(flat.readText()).optString("version", "") }.getOrDefault("")
        val moving = File(idDir.parentFile, "${idDir.name}.moving")
        moving.deleteRecursively()
        if (!idDir.renameTo(moving)) return null
        if (!idDir.mkdirs()) return null
        val target = File(idDir, ExtensionFiles.versionDirName(version))
        return if (moving.renameTo(target)) target else null
    }

    /** A registry record for an install laid out at `dir`, from its manifest. */
    fun record(id: String, dir: File, manifest: JSONObject, enabled: Boolean = true): JSONObject {
        val now = System.currentTimeMillis()
        val action = manifest.optJSONObject("action") ?: manifest.optJSONObject("browser_action")
        val options = manifest.optJSONObject("options_ui")?.optString("page", "")?.ifEmpty { null } ?: manifest.optString("options_page", "").ifEmpty { null }
        val permissions = JSONArray()
        val hostPermissions = JSONArray()
        manifest.optJSONArray("permissions")?.let { a ->
            for (i in 0 until a.length()) {
                val p = a.optString(i, "")
                if (p.contains("://") || p == "<all_urls>") hostPermissions.put(p) else if (p.isNotEmpty()) permissions.put(p)
            }
        }
        manifest.optJSONArray("host_permissions")?.let { a -> for (i in 0 until a.length()) hostPermissions.put(a.optString(i, "")) }
        return JSONObject()
            .put("id", id)
            .put("source", "unpacked")
            .put("path", dir.absolutePath)
            .put("version", manifest.optString("version", ""))
            .put("publisher", JSONObject.NULL)
            .put("updateUrl", JSONObject.NULL)
            .put("installedAt", now)
            .put("updatedAt", now)
            .put("enabled", enabled)
            .put("pinned", false)
            .put("allowFileAccess", false)
            .put("manifestVersion", manifest.optInt("manifest_version", 2))
            .put("name", manifest.optString("name", "").takeUnless { it.startsWith("__MSG_") } ?: "")
            .put("description", manifest.optString("description", "").takeUnless { it.startsWith("__MSG_") } ?: "")
            .put("permissions", permissions)
            .put("hostPermissions", hostPermissions)
            .put("optionsPage", options ?: JSONObject.NULL)
            .put("popup", action?.optString("default_popup", "")?.ifEmpty { null } ?: JSONObject.NULL)
            .put("pendingWarnings", JSONObject.NULL)
    }

    /** The registry document (`extensions.json`, version 2) for `records`. */
    fun registry(records: JSONArray): JSONObject =
        JSONObject().put("version", 2).put("extensions", records).put("lastUpdateCheck", JSONObject.NULL)
}
