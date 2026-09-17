package app.zen.chromium.ext

import org.json.JSONObject

/**
 * Assembles the scripts the extension layer injects (pure string work, unit-tested):
 *
 *  - the document-start script for tab WebViews: the boot config, every content-script group of
 *    every enabled extension as a real function literal, the CSS texts, then the bundled
 *    bootstrap (`assets/ext.js`). Function literals – not eval – so a page's Content-Security-Policy
 *    cannot block them, and the files of one declaration share one scope like the files of one
 *    isolated world share their global;
 *  - the page bootstrap for background pages, popups and options pages (config only);
 *  - the `scripting.executeScript` wrapper the host evaluates in a tab.
 */
object ExtensionScripts {
    /** One content-script group: the extension id, the group index and its files' sources in order. */
    class Group(val extensionId: String, val index: Int, val sources: List<String>, val isolation: String)

    fun documentStart(
        bootstrap: String,
        configJson: String,
        groups: List<Group>,
        css: Map<String, String>,
        debug: Boolean
    ): String {
        val sb = StringBuilder(bootstrap.length + configJson.length + groups.sumOf { g -> g.sources.sumOf { it.length } } + 4096)
        sb.append("(function(){var __zenExtBoot={config:").append(configJson).append(",debug:").append(debug)
        sb.append(",css:{")
        var first = true
        for ((key, text) in css) {
            if (!first) sb.append(',')
            first = false
            sb.append(JSONObject.quote(key)).append(':').append(JSONObject.quote(text))
        }
        sb.append("},sources:{")
        first = true
        for (group in groups) {
            if (!first) sb.append(',')
            first = false
            sb.append(JSONObject.quote("${group.extensionId}/${group.index}")).append(':')
            appendGroupFunction(sb, group)
        }
        sb.append("}};\n").append(bootstrap).append("\n})();")
        return sb.toString()
    }

    /**
     * `function (window, self, globalThis, chrome, browser) { <files> }`. Each file ends with a
     * newline (a trailing `//` comment must not swallow the next file) and a `;` (a file ending in
     * an expression must not become a call of the next file's leading parenthesis).
     */
    fun appendGroupFunction(sb: StringBuilder, group: Group) {
        sb.append("function(window,self,globalThis,chrome,browser){")
        if (group.isolation == "with") sb.append("with(window){")
        for (source in group.sources) {
            sb.append('\n').append(source).append("\n;")
        }
        if (group.isolation == "with") sb.append('}')
        sb.append("\n}")
    }

    /** The bootstrap for an extension page (background, popup, options): config only. */
    fun page(bootstrap: String, configJson: String): String =
        "(function(){var __zenExtBoot={config:$configJson,debug:false,css:{},sources:{}};\n$bootstrap\n})();"

    /**
     * What the host evaluates in a tab for `scripting.executeScript` / `tabs.executeScript`: the
     * code becomes a function literal handed to the bootstrap's `__zenExtExec`, which runs it in
     * the extension's scope. `funcSource` + `args` (MV3 `func`) returns the function's value.
     */
    fun exec(token: String, extensionId: String, kind: String, payload: JSONObject, code: String?, funcSource: String?, argsJson: String?): String {
        val body = when {
            funcSource != null -> "return (${funcSource}).apply(null,${argsJson ?: "[]"});"
            code != null -> code
            else -> ""
        }
        return "__zenExtExec(${JSONObject.quote(token)},${JSONObject.quote(extensionId)},${JSONObject.quote(kind)},$payload," +
            "function(window,self,globalThis,chrome,browser){\n$body\n})"
    }

    /** `Content-Type` for a file inside the extension directory, by extension. */
    fun mimeType(path: String): String {
        val ext = path.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "html", "htm" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json", "map" -> "application/json"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "svg" -> "image/svg+xml"
            "webp" -> "image/webp"
            "ico" -> "image/x-icon"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            "ttf" -> "font/ttf"
            "otf" -> "font/otf"
            "txt" -> "text/plain"
            "xml" -> "application/xml"
            "wasm" -> "application/wasm"
            "mp3" -> "audio/mpeg"
            "mp4" -> "video/mp4"
            "webm" -> "video/webm"
            "ogg" -> "audio/ogg"
            "pdf" -> "application/pdf"
            else -> "application/octet-stream"
        }
    }
}
