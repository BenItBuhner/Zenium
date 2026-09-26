package app.zen.chromium

import androidx.annotation.StringRes
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * The words of a custom tab's Open in <App>? confirmation – the browser window's
 * `ExternalProtocolSheet.tsx` (`titleOf`, `subtitleOf`, `wordsFor`, `displayAddress`) as string
 * resources and pure functions, so the two windows ask the one question in the one form and the
 * JVM test holds the twin to the original. [CustomTabHost.askExternal] puts them on the native
 * sheet.
 *
 * The title names the app that would open the link ("Open in Phone?") or, where the handler's
 * name is not to hand, another app. The sentence under it is the browser sheet's: for a web
 * address – a site's own app offering to open a page that loads regardless – "This link can also
 * open in <App>"; for a scheme, "<site> wants to open <object>" with the object the scheme names
 * (a phone number, an email address …), "This page" standing in for a site the tab cannot name.
 * The address goes on a line of its own, decoded as the browser shows it, the full URL its
 * accessible name.
 */
object CustomTabOpenInAppPrompt {
    /** The scheme of `url`, lower-case, or the empty string when it has none (`schemeOf`). */
    fun schemeOf(url: String): String {
        val colon = url.indexOf(':')
        if (colon <= 0) return ""
        val scheme = url.substring(0, colon)
        if (!scheme[0].isLetter() || !scheme.all { it.isLetterOrDigit() || it == '+' || it == '-' || it == '.' }) return ""
        return scheme.lowercase()
    }

    /** A web address: a site's own app offered for a page that loads regardless (`kind: 'web'`). */
    fun isWeb(scheme: String): Boolean = scheme == "http" || scheme == "https"

    /**
     * What the link is, with its article (`SCHEME_WORDS[scheme].object`): the browser sheet's
     * words for the schemes it names, one resource per object; null for a scheme it does not,
     * whose words are [R.string.cct_open_object_other] with the scheme filled in ("a foo: link").
     */
    @StringRes
    fun objectFor(scheme: String): Int? = when (scheme) {
        "mailto" -> R.string.cct_open_object_mailto
        "tel" -> R.string.cct_open_object_tel
        "sms", "smsto", "mms", "mmsto" -> R.string.cct_open_object_sms
        "market" -> R.string.cct_open_object_market
        "geo" -> R.string.cct_open_object_geo
        "intent", "android-app" -> R.string.cct_open_object_app
        else -> null
    }

    /**
     * The address as the page gave it, readable: percent-escapes undone where that is safe – the
     * browser sheet's `decodeURIComponent(url)`, which decodes every `%XX` run as UTF-8 and
     * throws on a malformed escape or an invalid sequence, the URL then shown as it came.
     * (`URLDecoder` would also turn `+` into a space, which `decodeURIComponent` does not.)
     */
    fun displayAddress(url: String): String {
        if ('%' !in url) return url
        val bytes = ByteArrayOutputStream(url.length)
        var i = 0
        var runStart = 0
        while (i < url.length) {
            if (url[i] != '%') {
                i++
                continue
            }
            if (i + 2 >= url.length || !isHex(url[i + 1]) || !isHex(url[i + 2])) return url
            if (runStart < i) bytes.write(url.substring(runStart, i).toByteArray(Charsets.UTF_8))
            bytes.write(url.substring(i + 1, i + 3).toInt(16))
            i += 3
            runStart = i
        }
        if (runStart < url.length) bytes.write(url.substring(runStart).toByteArray(Charsets.UTF_8))
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            decoder.decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
        } catch (e: CharacterCodingException) {
            url
        }
    }

    private fun isHex(c: Char): Boolean = c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'
}
