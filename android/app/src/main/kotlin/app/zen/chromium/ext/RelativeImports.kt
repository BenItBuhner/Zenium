package app.zen.chromium.ext

import java.util.regex.Pattern

/**
 * A content script's dynamic `import()` calls, rewritten as the file is copied into its unit:
 * the keyword to the bootstrap's helper, a relative specifier to the file's own URL on the
 * extension's served origin.
 *
 * THE SPECIFIER. Chrome injects a content script as a classic script whose source URL is the
 * file's `chrome-extension://<id>/<path>` and whose base URL is unset, and Blink resolves a
 * dynamic `import()` from such a script against the source URL (`referrer_script_info.cc`, "If
 * base URL is null, defer to `script_origin_resource_name`"): `import("../../../assets/js/x.js")`
 * in `src/pages/contentInject/index.js` asks for `chrome-extension://<id>/assets/js/x.js`, a
 * web-accessible resource. A unit of ours is one document-start script of the WebView's with no
 * source URL of the extension's, so the same specifier resolved against the page, and the page's
 * server answered 404: eJOY's Vite loader did exactly that and its root never mounted ("Failed
 * to fetch dynamically imported module", compat round 13 row 32, both WebViews). Rewritten, the
 * call has the shape `import(chrome.runtime.getURL('x.js'))` has, which the module-graph
 * machinery of rounds 11-12 serves (`ExtensionScripts.isPageModuleGraph`, `chunkStub`,
 * `extensionChunkRelay.ts`). Only a string literal that starts `./`, `../` or `/` (not `//`) is
 * touched; an absolute URL, a bare specifier, a template literal, a computed argument
 * (`chrome.runtime.getURL(...)`) and a member call (`loader.import(...)`) are left as written.
 * The literal's query and fragment ride along.
 *
 * THE KEYWORD. Chrome judges a content script's `import()` of its own web-accessible module by
 * the extension's policy; a WebView's world runs under the page's, whose `script-src` refuses
 * the served origin, and the promise the script awaits rejects (Web Scrobbler's `main.js` on
 * m.youtube.com: `await import(getURL('connectors/youtube.js'))`, then its observer – never
 * reached, both WebViews, compat round 25 rank 640). A dynamic `import()` is syntax, not a
 * function a bootstrap could wrap, so every `import(` of the file that is the keyword – not a
 * member (`loader.import(`), not part of a longer name, not `import.meta`, not a static
 * `import` declaration – becomes `[HELPER](`, a binding of the extension's scope the bootstrap
 * points at its recovery (`extensionScriptRecovery.ts`, `importModule`): the world's own
 * `import()` first, and the page-origin alias in its place when the page's policy refused the
 * extension's URL, the namespace handed back to the `await`. An identifier in the keyword's
 * place keeps the statement's parse: after a line without a semicolon `foo\n__zenExtImport(x)`
 * is still two statements, as `foo\nimport(x)` was, where a parenthesised expression there
 * would have become a call of `foo`. A `world: "MAIN"` script's `import()` is the page's own in
 * Chrome as well, so a group of that isolation keeps the keyword (`ownImport` false); the
 * bootstrap makes it no binding. A `userScripts` code entry has no path and is not looked at.
 */
object RelativeImports {
    /** The scope binding a content script's `import(` keyword is rewritten to; `IMPORT_HELPER` in `extensionScriptRecovery.ts` must agree. */
    const val HELPER = "__zenExtImport"

    /** One span of the text to replace (the quotes of a literal excluded) and the text that goes in its place. */
    class Edit(val start: Int, val end: Int, val replacement: String)

    /** The keyword followed by its call's open paren: a dynamic `import()`. */
    private val KEYWORD: Pattern = Pattern.compile("""import\s*\(""")

    /** At [KEYWORD]'s match: a `'`/`"` literal that is relative or root-relative, then the closing paren or a second argument. */
    private val CALL: Pattern = Pattern.compile("""import\s*\(\s*(["'])((?:\.\.?/|/(?!/))[^"'\\\n\r]*)\1\s*(?=[,)])""")

    /** How long the keyword is: the span [HELPER] replaces. */
    private const val KEYWORD_LENGTH = "import".length

    /**
     * The edits of `text` – the file at extension-relative `path` of extension `extensionId` –
     * in order of position: for every dynamic `import(` the keyword's rewrite to [HELPER] (when
     * `ownImport`; a `world: "MAIN"` group keeps the keyword) and, for a relative literal
     * specifier, the literal's resolution. Empty for a file without a dynamic import (most files).
     */
    fun edits(text: String, extensionId: String, path: String, ownImport: Boolean = true): List<Edit> {
        val m = KEYWORD.matcher(text)
        var out: ArrayList<Edit>? = null
        while (m.find()) {
            val at = m.start()
            if (at > 0 && isNamePart(text[at - 1])) continue
            if (ownImport) {
                val list = out ?: ArrayList<Edit>().also { out = it }
                list.add(Edit(at, at + KEYWORD_LENGTH, HELPER))
            }
            val call = CALL.matcher(text).region(at, text.length)
            if (!call.lookingAt()) continue
            val url = resolve(extensionId, path, call.group(2) ?: continue)
            // A path that could not sit inside the literal (a quote, a backslash, a line break in the file's own path) is left alone.
            if (url.any { it == '"' || it == '\'' || it == '\\' || it == '\n' || it == '\r' }) continue
            val list = out ?: ArrayList<Edit>().also { out = it }
            list.add(Edit(call.start(2), call.end(2), url))
        }
        return out ?: emptyList()
    }

    /** Whether `import` after this character is a member or a longer name rather than the keyword. */
    private fun isNamePart(c: Char): Boolean = c == '.' || c == '$' || c == '_' || c.isLetterOrDigit()

    /**
     * `spec` (`./a`, `../a`, `/a`, with any query and fragment) resolved against
     * `https://<extensionId>.ext.zenium.invalid/<path>` the way a URL parser resolves it: `.` and
     * empty segments dropped, `..` taking the segment before it and dropped at the root.
     */
    fun resolve(extensionId: String, path: String, spec: String): String {
        val cut = spec.indexOfFirst { it == '?' || it == '#' }.let { if (it < 0) spec.length else it }
        val specPath = spec.substring(0, cut)
        val segments = ArrayList<String>()
        if (!specPath.startsWith("/")) {
            val dir = path.trimStart('/').split('/')
            for (i in 0 until dir.size - 1) if (dir[i].isNotEmpty()) segments.add(dir[i])
        }
        for (s in specPath.split('/')) when (s) {
            "", "." -> Unit
            ".." -> if (segments.isNotEmpty()) segments.removeAt(segments.size - 1)
            else -> segments.add(s)
        }
        return "https://$extensionId${Extensions.ORIGIN_SUFFIX}/${segments.joinToString("/")}${spec.substring(cut)}"
    }

    /**
     * `text` as a unit source with `edits` applied as it is copied in – no second copy of the file
     * is made, the builder takes the text in pieces around the spans. The text is released
     * after the copy when `transient` (a file of [UnitCompiler.LARGE_SOURCE_CHARS] or more, held
     * the way [ExtensionScripts.Source.transient] holds it).
     */
    fun source(text: String, edits: List<Edit>, transient: Boolean): ExtensionScripts.Source {
        var length = text.length
        for (e in edits) length += e.replacement.length - (e.end - e.start)
        var held: String? = text
        return ExtensionScripts.Source(length, TopLevelDeclarations.scanSource(text), FrameIdioms.scan(text)) { sb ->
            val t = held ?: throw IllegalStateException("a transient source is appended once")
            var pos = 0
            for (e in edits) {
                sb.append(t, pos, e.start)
                sb.append(e.replacement)
                pos = e.end
            }
            sb.append(t, pos, t.length)
            if (transient) held = null
        }
    }
}
