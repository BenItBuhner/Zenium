package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExternalLaunchPolicyTest {
    private val zxing = "intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;" +
        "S.browser_fallback_url=https%3A%2F%2Fzxing.org%2Fw%2Fdecode%3Fu%3Dhttps%253A%252F%252Fexample.com;end"

    @Test
    fun webSchemesStayInTheWebView() {
        for (url in listOf("https://a.example/", "HTTP://a.example", "about:blank", "data:text/html,hi", "blob:https://a/1", "javascript:void(0)")) {
            assertFalse(url, ExternalLaunchPolicy.leavesBrowser(url))
        }
        for (url in listOf("tel:+123", "mailto:a@b.c", "zoommtg://join", "intent://x#Intent;scheme=y;end", "market://details?id=a")) {
            assertTrue(url, ExternalLaunchPolicy.leavesBrowser(url))
        }
        // Not a URL at all: nothing to leave for.
        assertFalse(ExternalLaunchPolicy.leavesBrowser("no scheme here"))
        assertNull(ExternalLaunchPolicy.schemeOf("/relative/path"))
    }

    @Test
    fun filesAndContentProvidersNeverLeave() {
        assertTrue(ExternalLaunchPolicy.neverLaunched("file"))
        assertTrue(ExternalLaunchPolicy.neverLaunched("CONTENT"))
        assertFalse(ExternalLaunchPolicy.neverLaunched("tel"))
        assertFalse(ExternalLaunchPolicy.neverLaunched(null))
        // An intent: URL whose data would be a content URI is refused whatever else it carries.
        assertTrue(ExternalLaunchPolicy.refusesIntentUrl("intent://media/external/images/1#Intent;scheme=content;action=android.intent.action.VIEW;end"))
        assertTrue(ExternalLaunchPolicy.refusesIntentUrl("intent:///data/data/app/secret#Intent;scheme=file;end"))
        assertFalse(ExternalLaunchPolicy.refusesIntentUrl(zxing))
        assertFalse(ExternalLaunchPolicy.refusesIntentUrl("tel:+1"))
    }

    @Test
    fun grantFlagsAreStrippedAndOthersKept() {
        val activityNewTask = 0x10000000
        val grantRead = 0x1
        val grantWrite = 0x2
        val grantPersistable = 0x40
        val grantPrefix = 0x80
        val flags = activityNewTask or grantRead or grantWrite or grantPersistable or grantPrefix
        assertEquals(activityNewTask, ExternalLaunchPolicy.stripGrantFlags(flags))
        assertEquals(0, ExternalLaunchPolicy.stripGrantFlags(ExternalLaunchPolicy.GRANT_FLAGS))
    }

    @Test
    fun intentUrlIsReadTheWayParseUriReadsIt() {
        val parsed = ExternalLaunchPolicy.parseIntentUrl(zxing)
        assertNotNull(parsed)
        assertEquals("zxing", parsed!!.scheme)
        assertEquals("com.google.zxing.client.android", parsed.packageName)
        assertNull(parsed.action)
        assertFalse(parsed.targeted)
        assertEquals(0, parsed.launchFlags)
        // One level of decoding, like Uri.decode: the inner URL keeps its own escapes.
        assertEquals("https://zxing.org/w/decode?u=https%3A%2F%2Fexample.com", parsed.rawFallback)
    }

    @Test
    fun componentsSelectorsAndFlagsAreNoticed() {
        val targeted = ExternalLaunchPolicy.parseIntentUrl(
            "intent:#Intent;action=android.intent.action.MAIN;component=com.evil/.Launcher;launchFlags=0x10000003;end"
        )!!
        assertTrue(targeted.targeted)
        assertEquals("android.intent.action.MAIN", targeted.action)
        assertEquals(0x10000003, targeted.launchFlags)
        val withSelector = ExternalLaunchPolicy.parseIntentUrl(
            "intent:#Intent;action=android.intent.action.VIEW;SEL;component=com.evil/.Hidden;scheme=leak;end"
        )!!
        assertTrue(withSelector.targeted)
        // Selector parameters do not become the main intent's.
        assertNull(withSelector.scheme)
        assertEquals("android.intent.action.VIEW", withSelector.action)
        // Decimal flags parse too; garbage is zero.
        assertEquals(268435456, ExternalLaunchPolicy.parseIntentUrl("intent:#Intent;launchFlags=268435456;end")!!.launchFlags)
        assertEquals(0, ExternalLaunchPolicy.parseIntentUrl("intent:#Intent;launchFlags=lots;end")!!.launchFlags)
    }

    @Test
    fun malformedIntentUrlsStillParseToSomethingHarmless() {
        val bare = ExternalLaunchPolicy.parseIntentUrl("intent://nothing")!!
        assertNull(bare.scheme)
        assertNull(bare.rawFallback)
        assertNull(ExternalLaunchPolicy.parseIntentUrl("https://not.an.intent/#Intent;scheme=x;end"))
        val unterminated = ExternalLaunchPolicy.parseIntentUrl("intent://x#Intent;scheme=abc;junk;=nokey")!!
        assertEquals("abc", unterminated.scheme)
    }

    @Test
    fun targetSchemeIsWhatTheSiteRuleIsKeyedOn() {
        assertEquals("tel", ExternalLaunchPolicy.targetScheme("tel:+1"))
        assertEquals("zoommtg", ExternalLaunchPolicy.targetScheme("ZoomMtg://join"))
        assertEquals("zxing", ExternalLaunchPolicy.targetScheme(zxing))
        assertEquals("com.example.app", ExternalLaunchPolicy.targetScheme("intent:#Intent;package=com.example.app;end"))
        assertEquals("intent", ExternalLaunchPolicy.targetScheme("intent:#Intent;action=a;end"))
        assertEquals("", ExternalLaunchPolicy.targetScheme("garbage"))
    }

    @Test
    fun onlyWebFallbacksCount() {
        assertEquals("https://zxing.org/w/decode?u=https%3A%2F%2Fexample.com", ExternalLaunchPolicy.fallbackUrl(zxing))
        assertNull(ExternalLaunchPolicy.fallbackUrl("intent://x#Intent;scheme=y;S.browser_fallback_url=intent%3A%2F%2Fother%23Intent%3Bend;end"))
        assertNull(ExternalLaunchPolicy.fallbackUrl("intent://x#Intent;scheme=y;S.browser_fallback_url=javascript%3Aalert(1);end"))
        assertNull(ExternalLaunchPolicy.fallbackUrl("intent://x#Intent;scheme=y;end"))
        assertNull(ExternalLaunchPolicy.fallbackUrl("tel:+1"))
    }

    @Test
    fun percentDecodingMatchesUriDecode() {
        assertEquals("a b+c", ExternalLaunchPolicy.percentDecode("a%20b+c"))
        assertEquals("caf\u00e9", ExternalLaunchPolicy.percentDecode("caf%C3%A9"))
        assertEquals("100%", ExternalLaunchPolicy.percentDecode("100%"))
        assertEquals("%zz", ExternalLaunchPolicy.percentDecode("%zz"))
        assertEquals("plain", ExternalLaunchPolicy.percentDecode("plain"))
    }
}
