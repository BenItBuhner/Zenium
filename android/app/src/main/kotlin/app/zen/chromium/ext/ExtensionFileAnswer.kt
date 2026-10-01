package app.zen.chromium.ext

import java.io.File
import java.net.URLDecoder

/**
 * The runtime's file service behind a content script's request for a file of its own extension
 * (`fetch(chrome.runtime.getURL('locales/en.json'))`, an `XMLHttpRequest` of the same URL). In
 * Chrome the isolated world's request carries the extension's origin: the page's
 * Content-Security-Policy (`connect-src`) never sees it and the file answers as a same-origin
 * response. A WebView's isolated world runs under the document's policy, and the `with`
 * fallback's request is the page's outright, so the content scripts' `fetch` and
 * `XMLHttpRequest` ask the host over the bridge first (`extensionFetchRelay.ts`,
 * `extensionXhrRelay.ts`; [Extensions.extensionFetch] the glue) and the host answers here as the
 * served origin would answer a page's request for the file: the web-accessible file's bytes and
 * type – a stylesheet localized –, or the reason it cannot, which sends the request back to the
 * page's own `fetch` (the served origin's answer under the page's policy, as before the relay).
 */
object ExtensionFileAnswer {
    /** The file's bytes and type, or the reason ([error]) the request was not answered. */
    class Answer(val body: ByteArray?, val mime: String?, val error: String?) {
        val ok: Boolean get() = error == null
    }

    /** The largest file answered over the bridge: base64 over `postMessage` has a price. */
    const val MAX_BYTES = 16 * 1024 * 1024

    /**
     * The path (no leading slash, percent-escapes decoded, query and fragment dropped) a URL
     * names on the extension's own origin – the served spelling
     * `https://<id>.ext.zenium.invalid/p` or Chrome's `chrome-extension://<id>/p`, which the
     * relay maps before asking but the host reads too –, or null when the URL is not this
     * extension's own.
     */
    fun ownPath(url: String, extId: String): String? {
        val served = ExtensionUrls.toServed(url)
        val prefix = "https://$extId${Extensions.ORIGIN_SUFFIX}"
        if (served.length < prefix.length || !served.regionMatches(0, prefix, 0, prefix.length, ignoreCase = true)) return null
        val rest = served.substring(prefix.length)
        if (rest.isNotEmpty() && rest[0] != '/' && rest[0] != '?' && rest[0] != '#') return null
        val raw = rest.substringBefore('#').substringBefore('?').trimStart('/')
        return percentDecoded(raw)
    }

    /**
     * The served origin's answer for `path` inside `dir`: the reason when the file is not
     * web-accessible, missing, unreadable or over [maxBytes]; the bytes and type otherwise, a
     * stylesheet's `__MSG_` placeholders substituted as the origin substitutes them.
     */
    fun answer(
        dir: File,
        path: String,
        webAccessible: List<Regex>,
        cssMessages: Map<String, String>,
        maxBytes: Int = MAX_BYTES
    ): Answer {
        if (!webAccessible.any { it.matches(path) }) return refused("$path is not a web-accessible resource")
        val file = fileIn(dir, path)?.takeIf { it.isFile } ?: return refused("$path was not found")
        val length = file.length()
        if (length > maxBytes) return refused("$path is $length bytes, more than the bridge carries ($maxBytes)")
        val bytes = runCatching { file.readBytes() }.getOrNull() ?: return refused("$path could not be read")
        val mime = ExtensionScripts.mimeType(path)
        if (mime == "text/css" && cssMessages.isNotEmpty()) {
            return Answer(ExtensionFiles.localizeCss(String(bytes, Charsets.UTF_8), cssMessages).toByteArray(), mime, null)
        }
        return Answer(bytes, mime, null)
    }

    fun refused(reason: String): Answer = Answer(null, null, reason)

    /** `path` resolved inside `dir`, or null when it escapes it (`..`, symlinks). */
    fun fileIn(dir: File, path: String): File? {
        val file = File(dir, path.trimStart('/'))
        val canonical = runCatching { file.canonicalPath }.getOrNull() ?: return null
        val root = runCatching { dir.canonicalPath }.getOrNull() ?: return null
        if (!canonical.startsWith(root + File.separator)) return null
        return file
    }

    /** Percent-escapes decoded as a URL's path decodes them (`+` is a plus, not a space); a malformed escape leaves the text as it is. */
    private fun percentDecoded(text: String): String {
        if (!text.contains('%')) return text
        return runCatching { URLDecoder.decode(text.replace("+", "%2B"), "UTF-8") }.getOrDefault(text)
    }
}
