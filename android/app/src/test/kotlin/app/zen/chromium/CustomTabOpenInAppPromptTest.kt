package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The custom tab's Open in <App>? confirmation on the native sheet (W6-S11, the lead's ruling on
 * the worker's ask): the browser window's `ExternalProtocolSheet.tsx` twin – its title with and
 * without the app's name, its sentence per kind of link (a web address a site's app offers to
 * open; a scheme's object, "a phone number", with the site or "This page"), the decoded address
 * on its own line with the full URL as its accessible name, Not now | Open with Open the accent
 * primary, no Always open row – and no Material dialog left in the host. The words are read from
 * the browser sheet's source so the twin cannot drift; the pure functions are run; the host's
 * wiring is read from the sources, as `CustomTabPermissionPromptTest` reads the permission ask's.
 */
class CustomTabOpenInAppPromptTest {
    private val root = repoRoot()
    private val strings = File(root, "android/app/src/main/res/values/strings.xml").readText()
    private val browserSheet = File(root, "src/renderer/src/components/protocol/ExternalProtocolSheet.tsx").readText()

    /** The title, the sentences and the pair are the browser sheet's own words, in the `%n$s` shapes the host fills. */
    @Test
    fun theWordsAreTheBrowserSheetsWords() {
        assertTrue(browserSheet.contains("`Open in \${request.appName}?`"))
        assertEquals("Open in %1\$s?", string("cct_open_in_app"))
        assertTrue(browserSheet.contains("'Open in another app?'"))
        assertEquals("Open in another app?", string("cct_open_in_another_app"))
        assertTrue(browserSheet.contains("`This link can also open in \${request.appName ?? 'an app'}`"))
        assertEquals("This link can also open in %1\$s", string("cct_open_link_also_in_app"))
        assertEquals("This link can also open in an app", string("cct_open_link_also_in_an_app"))
        assertTrue(browserSheet.contains("`\${site} wants to open \${wordsFor(request.scheme).object}`"))
        assertEquals("%1\$s wants to open %2\$s", string("cct_open_wants"))
        assertTrue(browserSheet.contains("request.site || 'This page'"))
        assertEquals("This page", string("cct_this_page"))
        // §9.11's pair, the browser sheet's words for it: Not now the secondary, Open the primary.
        assertTrue(Regex(""">\s*Not now\s*</button>""").containsMatchIn(browserSheet))
        assertTrue(Regex("""data-primary[\s\S]*?>\s*Open\s*</button>""").containsMatchIn(browserSheet))
        assertEquals("Not now", string("cct_not_now"))
        assertEquals("Open", string("cct_open"))
    }

    /** Every scheme the browser sheet names has its object words here, one resource per object; an unnamed scheme reads "a <scheme>: link". */
    @Test
    fun eachSchemeTheBrowserNamesHasItsObjectWords() {
        val named = Regex("""^\s*'?([a-z-]+)'?: \{ object: '([^']+)'""", RegexOption.MULTILINE)
            .findAll(browserSheet.substringAfter("const SCHEME_WORDS").substringBefore("}\n\n"))
            .associate { it.groupValues[1] to it.groupValues[2] }
        assertEquals("the browser sheet names ten schemes", 10, named.size)
        val resources = mapOf(
            "mailto" to ("cct_open_object_mailto" to R.string.cct_open_object_mailto),
            "tel" to ("cct_open_object_tel" to R.string.cct_open_object_tel),
            "sms" to ("cct_open_object_sms" to R.string.cct_open_object_sms),
            "smsto" to ("cct_open_object_sms" to R.string.cct_open_object_sms),
            "mms" to ("cct_open_object_sms" to R.string.cct_open_object_sms),
            "mmsto" to ("cct_open_object_sms" to R.string.cct_open_object_sms),
            "market" to ("cct_open_object_market" to R.string.cct_open_object_market),
            "geo" to ("cct_open_object_geo" to R.string.cct_open_object_geo),
            "intent" to ("cct_open_object_app" to R.string.cct_open_object_app),
            "android-app" to ("cct_open_object_app" to R.string.cct_open_object_app)
        )
        assertEquals(named.keys, resources.keys)
        for ((scheme, words) in named) {
            val (name, id) = resources.getValue(scheme)
            assertEquals("$scheme maps to $name", id, CustomTabOpenInAppPrompt.objectFor(scheme))
            assertEquals("$name reads as the browser sheet's words for $scheme", words, string(name))
        }
        assertTrue(browserSheet.contains("object: `a \${scheme}: link`"))
        assertEquals("a %1\$s: link", string("cct_open_object_other"))
        assertNull(CustomTabOpenInAppPrompt.objectFor("foo"))
        assertNull(CustomTabOpenInAppPrompt.objectFor(""))
    }

    /** The scheme as the core reads it (lower-case, before the colon) and the two kinds of link. */
    @Test
    fun theSchemeIsReadAsTheCoreReadsIt() {
        assertEquals("tel", CustomTabOpenInAppPrompt.schemeOf("tel:+15551234567"))
        assertEquals("mailto", CustomTabOpenInAppPrompt.schemeOf("MAILTO:someone@example.com"))
        assertEquals("https", CustomTabOpenInAppPrompt.schemeOf("https://example.com/app"))
        assertEquals("android-app", CustomTabOpenInAppPrompt.schemeOf("android-app://com.example/https/example.com"))
        assertEquals("intent", CustomTabOpenInAppPrompt.schemeOf("intent://scan/#Intent;scheme=zxing;end"))
        assertEquals("", CustomTabOpenInAppPrompt.schemeOf("no scheme here"))
        assertEquals("", CustomTabOpenInAppPrompt.schemeOf(":leading"))
        assertEquals("", CustomTabOpenInAppPrompt.schemeOf("1abc:digits first"))
        assertEquals("", CustomTabOpenInAppPrompt.schemeOf(""))
        assertTrue(CustomTabOpenInAppPrompt.isWeb("http") && CustomTabOpenInAppPrompt.isWeb("https"))
        assertFalse(CustomTabOpenInAppPrompt.isWeb("tel") || CustomTabOpenInAppPrompt.isWeb(""))
    }

    /** The sentence's site is the tab's host as the core's `getHost` reads it, `www.` trimmed – and nothing (so "This page") for a tab without one, never the URL itself. */
    @Test
    fun theSentencesSiteIsTheTabsHostOrNothing() {
        assertEquals("example.com", CustomTabOpenInAppPrompt.siteOf("https://www.example.com/news/2026?ref=tel#call"))
        assertEquals("en.wikipedia.org", CustomTabOpenInAppPrompt.siteOf("https://en.wikipedia.org/wiki/Damping"))
        assertEquals("the port is not the site", "127.0.0.1", CustomTabOpenInAppPrompt.siteOf("http://127.0.0.1:8137/story.html"))
        assertEquals("nor the user", "auth.test", CustomTabOpenInAppPrompt.siteOf("http://user:pw@auth.test:8443/login#x"))
        assertEquals("an IPv6 host keeps its brackets, as `hostname` does", "[::1]", CustomTabOpenInAppPrompt.siteOf("http://[::1]:8080/"))
        assertEquals("a bare host with a query", "example.com", CustomTabOpenInAppPrompt.siteOf("https://example.com?x=1"))
        assertEquals("an authority is a host whatever the scheme, as `hostname` reads it", "scan", CustomTabOpenInAppPrompt.siteOf("intent://scan/#Intent;scheme=zxing;end"))
        val core = File(root, "src/shared/url.ts").readText()
        assertTrue("the core's getHost is `new URL(url).hostname`, '' where there is none", Regex("""export function getHost\(url: string\): string \{\s*try \{\s*const u = new URL\(url\)\s*return u\.hostname\s*\} catch \{\s*return ''""").containsMatchIn(core))
        for (hostless in listOf("about:blank", "data:text/html,hi", "file:///sdcard/Download/page.html", "tel:+15551234567", "mailto:someone@example.com", "not a url", "")) {
            assertEquals("$hostless names no site: the sentence says This page", "", CustomTabOpenInAppPrompt.siteOf(hostless))
        }
        assertEquals("no tab at all", "", CustomTabOpenInAppPrompt.siteOf(null))
        assertEquals("an unclosed IPv6 bracket is no host", "", CustomTabOpenInAppPrompt.siteOf("http://[::1/"))
    }

    /** The address reads as the browser's `displayAddress` shows it: `decodeURIComponent`, the URL as it came when that would throw. */
    @Test
    fun theAddressReadsAsTheBrowserShowsIt() {
        assertEquals("tel:+15551234567", CustomTabOpenInAppPrompt.displayAddress("tel:+15551234567"))
        assertEquals("mailto:someone@example.com?subject=Hi there", CustomTabOpenInAppPrompt.displayAddress("mailto:someone%40example.com?subject=Hi%20there"))
        assertEquals("geo:0,0?q=Zürich", CustomTabOpenInAppPrompt.displayAddress("geo:0,0?q=Z%C3%BCrich"))
        assertEquals("a plus is not a space", "sms:+15551234567?body=a+b", CustomTabOpenInAppPrompt.displayAddress("sms:+15551234567?body=a+b"))
        assertEquals("intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;end", CustomTabOpenInAppPrompt.displayAddress("intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;end"))
        for (malformed in listOf("https://example.com/%E0%A4%A", "https://example.com/%", "https://example.com/%ZZ", "https://example.com/%C3%28", "https://example.com/%ED%A0%80")) {
            assertEquals("$malformed is shown as it came", malformed, CustomTabOpenInAppPrompt.displayAddress(malformed))
        }
        assertEquals("", CustomTabOpenInAppPrompt.displayAddress(""))
    }

    /** The host asks on the chassis in the browser sheet's form: the title, the sentence per kind, the address line and its name, the pair, no glyph, no remember row. */
    @Test
    fun theCustomTabsConfirmationIsTheSheetNotAnAlert() {
        val host = File(root, "android/app/src/main/kotlin/app/zen/chromium/CustomTabHost.kt").readText()
        assertFalse("no alert dialog is left in the custom tab's host", host.contains("MaterialAlertDialogBuilder") || host.contains("AlertDialog"))
        val ask = Regex("""private fun askExternal\(args: JSONObject\) \{([\s\S]*?)\n    \}""").find(host)?.groupValues?.get(1) ?: error("CustomTabHost.kt has no askExternal")
        assertTrue("the confirmation is the native sheet in the tab's scheme", ask.contains("NativePromptSheet(") && ask.contains("V2Ink(activity, themeDark)"))
        assertTrue("the title names the app, or another app", ask.contains("activity.getString(R.string.cct_open_in_app, appName) else activity.getString(R.string.cct_open_in_another_app)"))
        assertTrue("a web address: the browser sheet's sentence, the page loading regardless", ask.contains("CustomTabOpenInAppPrompt.isWeb(scheme)") && ask.contains("activity.getString(R.string.cct_open_link_also_in_app, appName) else activity.getString(R.string.cct_open_link_also_in_an_app)"))
        assertTrue("a scheme: the site (or This page) wants to open the scheme's object", ask.contains("activity.getString(R.string.cct_open_wants, site.ifEmpty { activity.getString(R.string.cct_this_page) }, obj)"))
        assertTrue("an unnamed scheme reads as a <scheme>: link", ask.contains("CustomTabOpenInAppPrompt.objectFor(scheme)?.let(activity::getString) ?: activity.getString(R.string.cct_open_object_other, scheme)"))
        assertTrue("the site is the tab's host or nothing – never the raw URL", ask.contains("val site = CustomTabOpenInAppPrompt.siteOf(tabs.get(args.str(\"tabId\"))?.url)"))
        assertFalse("hostOf's raw-URL fallback stays with the permission title", ask.contains("hostOf("))
        assertTrue("the address line shows the decoded address with the full URL as its accessible name", ask.contains("detail = CustomTabOpenInAppPrompt.displayAddress(url)") && ask.contains("detailName = url"))
        assertTrue("the title stands on one line, truncated, as the browser's does", ask.contains("titleOneLine = true"))
        assertTrue("Not now the secondary", ask.contains("secondary = activity.getString(R.string.cct_not_now)"))
        assertTrue("Open the accent primary", ask.contains("primary = NativePromptSheet.Peer(activity.getString(R.string.cct_open), NativePromptSheet.Tone.ACCENT)"))
        assertFalse("no glyph: a confirmation of the user's own tap, the app named in the words", ask.contains("glyph"))
        assertFalse("no Always open row: nothing to remember with", ask.contains("check =") || ask.contains("Always"))
        assertTrue("Open lets the request go; Not now, the scrim and the back refuse it", ask.contains("externalProtocols.respond(requestId, answer.accepted)"))
        assertTrue("one answer per sheet", ask.contains("if (answered) return@NativePromptSheet"))
        assertTrue("with no app at all the request is refused and the deliberate fallback runs, as the browser window's core does (W6-D2; ExternalProtocolsNoHandlerTest has the order)", Regex("""if \(args\.str\("handler"\) == "none"\) \{\s*externalProtocols\.refuseWithFallback\(requestId\)""").containsMatchIn(ask))
        assertFalse("nothing is started for a link no app can open", Regex("""if \(args\.str\("handler"\) == "none"\) \{\s*externalProtocols\.respond\(requestId, true\)""").containsMatchIn(ask))
        assertTrue("a window on its way out asks nothing", ask.contains("if (activity.isFinishing || activity.isDestroyed) {\n            externalProtocols.respond(requestId, false)"))
        assertTrue("a newer request under a tap takes the sheet over, the one it replaces answered false; one without a tap is refused", ask.contains("if (!args.optBoolean(\"userGesture\", false)) {\n                externalProtocols.respond(requestId, false)") && ask.contains("externalProtocols.respond(standing, false)"))
        for (memory in listOf("SharedPreferences", "getSharedPreferences", "externalProtocols[", "remember(")) {
            assertFalse("a custom tab remembers no scheme ($memory)", host.contains(memory))
        }
        val destroy = Regex("""fun destroy\(\) \{([\s\S]*?)\n    \}""").find(host)?.groupValues?.get(1) ?: error("CustomTabHost.kt has no destroy")
        assertTrue("the window's end takes the sheet down without an answer", destroy.contains("externalPrompt?.dismiss()"))
    }

    private fun string(name: String): String =
        Regex("""<string name="$name">([^<]*)</string>""").find(strings)?.groupValues?.get(1) ?: error("strings.xml has no $name")

    private companion object {
        fun repoRoot(): File {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            while (dir != null) {
                if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
                dir = dir.parentFile
            }
            error("not inside the repository")
        }
    }
}
