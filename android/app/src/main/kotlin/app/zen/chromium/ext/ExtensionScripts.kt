package app.zen.chromium.ext

import org.json.JSONObject
import java.io.File

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

    /**
     * The `//# sourceURL` of the scripts the host runs in a tab's main world (the document-start
     * script, the `executeScript` wrapper): a location no page script can carry, so the bootstrap's
     * Trusted Types shield can tell an extension's DOM write from the page's by its stack frame
     * (`extensionIsolation.ts`, `ownScriptMatcher`). Also what DevTools and error events name them.
     */
    const val SOURCE_URL = "zenium-ext://content-scripts/boot.js"

    /** The magic comment that names a script [SOURCE_URL]; last in the text, so a file's own magic comment does not win. */
    private const val SOURCE_URL_TAIL = "\n//# sourceURL=$SOURCE_URL"

    /** The [guarded] shell around an expression, and the close of the [exec] function literal. */
    private const val GUARD_HEAD = "(function(){try{return {v:"
    private const val GUARD_TAIL = "}}catch(e){return {e:String(e&&e.message||e)}}})()"
    private const val EXEC_TAIL = "\n})"

    /** Between two injected files: a file ending in a line comment cannot swallow the next one. */
    private const val FILE_JOIN = "\n;\n"

    /** `script` named [SOURCE_URL] for stack frames (the `executeScript` wrapper; a document-start script is born named). */
    fun named(script: String): String = script + SOURCE_URL_TAIL

    /**
     * The document-start script, named [SOURCE_URL]. Assembled in one builder sized for the whole
     * text and copied out once: an extension's units can run to ten million characters (Grammarly),
     * and a 192 MB debug heap that holds the sources, the builder's `char[]` and the string at once
     * has no room for a second builder growing by doubling on top of them (a `named(toString())`
     * pass did that, and a 37 MB `char[]` for it was the allocation that failed on the emulator).
     */
    fun documentStart(
        bootstrap: String,
        configJson: String,
        groups: List<Group>,
        css: Map<String, String>,
        debug: Boolean
    ): String {
        val sb = StringBuilder(
            bootstrap.length + configJson.length + groups.sumOf { g -> g.sources.sumOf { it.length } } +
                css.entries.sumOf { (key, text) -> key.length + text.length + 8 } + SOURCE_URL_TAIL.length + 4096
        )
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
        sb.append("}};\n").append(bootstrap).append("\n})();").append(SOURCE_URL_TAIL)
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
    fun exec(token: String, extensionId: String, kind: String, payload: JSONObject, code: String?, funcSource: String?, argsJson: String?): String =
        execHead(token, extensionId, kind, payload) + execBody(code, funcSource, argsJson) + EXEC_TAIL

    /**
     * A document without the extension's bootstrap (one the runtime could not reach: loaded
     * before the extension was attached, or a scheme it does not inject into) has no
     * `__zenExtExec`; the caller hears Chrome's refusal for a page it cannot script, not
     * `__zenExtExec is not a function`.
     */
    const val NO_ACCESS = "Cannot access contents of the page. Extension manifest must request permission to access the respective host."

    private fun execHead(token: String, extensionId: String, kind: String, payload: JSONObject): String =
        "(typeof __zenExtExec===\"function\"?__zenExtExec:function(){throw new Error(${JSONObject.quote(NO_ACCESS)})})" +
            "(${JSONObject.quote(token)},${JSONObject.quote(extensionId)},${JSONObject.quote(kind)},$payload," +
            "function(window,self,globalThis,chrome,browser){\n"

    private fun execBody(code: String?, funcSource: String?, argsJson: String?): String = when {
        funcSource != null -> "return (${funcSource}).apply(null,${argsJson ?: "[]"});"
        code != null -> code
        else -> ""
    }

    /**
     * `expression`, evaluated so that its outcome always comes back as JSON the host can read:
     * `{"v": <value>}` when it returned, `{"e": "<message>"}` when it threw (`evaluateJavascript`
     * alone answers an exception with a bare `null`, indistinguishable from a script returning null).
     */
    fun guarded(expression: String): String = GUARD_HEAD + expression + GUARD_TAIL

    /**
     * The whole script one `ext.exec` evaluates – [exec] inside [guarded], after `prefix` (a late
     * boot) when there is one, named like the document-start script when `named` – assembled in
     * one builder sized for its parts and copied out once. The extension's own files (MV3 `files`,
     * MV2 `file`) are streamed into it here, in order, joined the way [exec]'s code joins them,
     * instead of travelling through the bridge as text: Loom injects a 13 MB `content.js` on its
     * action click, and that text as a `readFile` answer, an `exec` argument, a parsed JSON
     * string, a template, a guard and a name was six copies of it on a 192 MB heap (the sweep's
     * process died on the fifth). This way it is on the heap twice: the builder and the string
     * the WebView takes. A file's size in bytes bounds its length in chars, so the builder never
     * grows.
     */
    fun execScript(
        token: String,
        extensionId: String,
        kind: String,
        payload: JSONObject,
        code: String?,
        files: List<File>,
        funcSource: String?,
        argsJson: String?,
        prefix: String?,
        named: Boolean
    ): String {
        val head = execHead(token, extensionId, kind, payload)
        val body = execBody(code, funcSource, argsJson)
        val capacity = (prefix?.length ?: -1) + 1 + GUARD_HEAD.length + head.length + body.length +
            files.sumOf { it.length().toInt() + FILE_JOIN.length } + EXEC_TAIL.length + GUARD_TAIL.length +
            (if (named) SOURCE_URL_TAIL.length else 0)
        val sb = StringBuilder(capacity)
        if (prefix != null) sb.append(prefix).append('\n')
        sb.append(GUARD_HEAD).append(head).append(body)
        var joined = body.isNotEmpty()
        val buffer = CharArray(64 * 1024)
        for (file in files) {
            if (joined) sb.append(FILE_JOIN)
            joined = true
            file.bufferedReader().use { reader ->
                while (true) {
                    val n = reader.read(buffer)
                    if (n < 0) break
                    sb.append(buffer, 0, n)
                }
            }
        }
        sb.append(EXEC_TAIL).append(GUARD_TAIL)
        if (named) sb.append(SOURCE_URL_TAIL)
        return sb.toString()
    }

    /**
     * A late boot: the content bootstrap with the extension's late config and no sources,
     * evaluated by the host into the main world of a document that predates the extension's
     * world (or on a WebView without worlds) so that a following `exec` finds a scope. The
     * bootstrap is idempotent in a document that booted already.
     */
    fun lateBoot(bootstrap: String, lateConfigJson: String, debug: Boolean): String =
        documentStart(bootstrap, lateConfigJson, emptyList(), emptyMap(), debug)

    /** True for a file the runtime serves as a script (`.js`, `.mjs`). */
    fun isScriptPath(path: String): Boolean = mimeType(path) == "text/javascript"

    /**
     * A served module's text bracketed for a one-realm WebView: `globalThis.__zenExtModule(id)`
     * shares the text's first line (line numbers, and so source maps, stay) and
     * `__zenExtModuleEnd(id)` takes a line of its own after whatever the file ended in. While
     * the module's body evaluates, the page's real `chrome` answers with the extension's (the
     * bootstrap's accessor, `extensionModuleChrome.ts`); both calls are guarded, so the same
     * text also runs where the brackets were never installed. The TypeScript twin is
     * `wrapModuleText`; `extensionModuleChrome.test.ts` and `ExtensionScriptsTest` pin the shape.
     */
    fun moduleChromeWrap(text: String, extensionId: String): String {
        val id = JSONObject.quote(extensionId)
        return "globalThis.__zenExtModule&&globalThis.__zenExtModule($id);" + text +
            "\n;globalThis.__zenExtModuleEnd&&globalThis.__zenExtModuleEnd($id);"
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
