package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UserAgentTest {
    /** What a Pixel 6 on Android 14 reports before any change. */
    private val phone =
        "Mozilla/5.0 (Linux; Android 14; Pixel 6 Build/AP1A.240305.019.A1; wv) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36"

    /** Chrome's own reduced user agent on the same phone (`GetReducedUserAgent`, M110 and later). */
    private val chrome =
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"

    /** A tablet's WebView: no `Mobile` token, as Chrome on a tablet sends none. */
    private val tablet =
        "Mozilla/5.0 (Linux; Android 14; SM-X910 Build/UP1A.231005.007; wv) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Safari/537.36"

    @Test
    fun normalizeIsChromesReducedUserAgent() {
        assertEquals(chrome, UserAgent.normalize(phone))
        assertEquals(
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            UserAgent.normalize(tablet)
        )
    }

    @Test
    fun normalizeReadsOnlyTheMajorAndTheMobileTokenFromTheWebView() {
        // A WebView that reduces its own string (`kWebViewReduceUAAndroidVersionDeviceModel`,
        // `kWebViewReduceUserAgentMinorVersion`) and one that does not come out the same.
        val reducedByWebView =
            "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/135.0.0.0 Mobile Safari/537.36"
        assertEquals(
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
            UserAgent.normalize(reducedByWebView)
        )
        val bare = "Mozilla/5.0 (Linux; Android 14; Build/AP1A.240305.019.A1; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36"
        assertEquals(chrome, UserAgent.normalize(bare))
        assertEquals(UserAgent.reduced("122", mobile = true), chrome)
    }

    @Test
    fun normalizedUserAgentNamesNeitherTheDeviceNorTheOsNorTheWebView() {
        val normalized = UserAgent.normalize(phone)
        assertFalse(normalized.contains("wv"))
        assertFalse(normalized.contains("Version/"))
        assertFalse(normalized.contains("Build/"))
        assertFalse(normalized.contains("Pixel"))
        assertFalse(normalized.contains("Android 14"))
        assertFalse(normalized.contains("6261"))
        assertTrue(normalized.contains("(Linux; Android 10; K)"))
        assertTrue(normalized.contains("Chrome/122.0.0.0 Mobile Safari/537.36"))
    }

    @Test
    fun normalizeLeavesBrowserUserAgentsAlone() {
        assertEquals(chrome, UserAgent.normalize(chrome))
        assertEquals(UserAgent.normalize(phone), UserAgent.normalize(UserAgent.normalize(phone)))
    }

    @Test
    fun aWebViewWithoutAChromeTokenLosesOnlyTheEmbeddedViewMarkers() {
        val odd = "Mozilla/5.0 (Linux; Android 14; Pixel 6 Build/AP1A.240305.019.A1; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Mobile Safari/537.36"
        assertEquals(
            "Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36",
            UserAgent.normalize(odd)
        )
    }

    @Test
    fun chromeVersionComesFromTheProductToken() {
        assertEquals("122.0.6261.119", UserAgent.chromeVersion(phone))
        assertEquals("122.0.0.0", UserAgent.chromeVersion(chrome))
        assertEquals("122", UserAgent.major("122.0.6261.119"))
        assertNull(UserAgent.chromeVersion("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Safari/537.36"))
        assertEquals("135.0.0.0", UserAgent.fullVersion("135"))
        assertEquals("122.0.6261.119", UserAgent.fullVersion("122.0.6261.119"))
    }

    @Test
    fun brandsAreChromiumsForAChromiumBrandedBuild() {
        // `GenerateBrandVersionList` seeded by the major: `Not(A:Brand` (chars 122 % 11 and
        // 123 % 11), version 24 (122 % 3), the GREASE entry first (122 % 2 == 0).
        val brands = UserAgent.brands("122.0.6261.119")
        assertEquals(
            listOf(UserAgent.Brand("Not(A:Brand", "24", "24.0.0.0"), UserAgent.Brand("Chromium", "122", "122.0.6261.119")),
            brands
        )
        assertFalse(brands.any { it.brand.contains("WebView") || it.brand == "Zenium" })
        for (brand in brands) {
            assertTrue("${brand.brand} major", brand.major.all(Char::isDigit) && brand.major.isNotEmpty())
            assertTrue("${brand.brand} full", brand.full.startsWith(brand.major + "."))
        }
    }

    @Test
    fun brandsMatchTheDesktopsListEntryForEntry() {
        // The fixtures of `src/shared/__tests__/browserIdentity.test.ts` (`chromiumBrands`).
        assertEquals(
            listOf("Not?A_Brand" to "24", "Chromium" to "152"),
            UserAgent.brands("152.0.7977.78").map { it.brand to it.major }
        )
        assertEquals(
            listOf("24.0.0.0", "152.0.7977.78"),
            UserAgent.brands("152.0.7977.78").map { it.full }
        )
        assertEquals(
            listOf("Chromium" to "153", "Not_A Brand" to "8"),
            UserAgent.brands("153.0.1.2").map { it.brand to it.major }
        )
        assertEquals(
            listOf("Chromium" to "131", "Not_A Brand" to "24"),
            UserAgent.brands("131.0.6778.85").map { it.brand to it.major }
        )
        assertEquals(
            listOf("Not_A Brand" to "8", "Chromium" to "120"),
            UserAgent.brands("120.0.6099.109").map { it.brand to it.major }
        )
        // A reduced string's major alone still seeds the same list, with a padded full version.
        assertEquals(
            listOf(UserAgent.Brand("Chromium", "135", "135.0.0.0"), UserAgent.Brand("Not-A.Brand", "8", "8.0.0.0")),
            UserAgent.brands("135")
        )
    }

    @Test
    fun platformVersionIsChromesMajorMinorBugfix() {
        assertEquals("14.0.0", UserAgent.platformVersion("14"))
        assertEquals("4.4.2", UserAgent.platformVersion("4.4.2"))
        assertEquals("16.1.0", UserAgent.platformVersion("16.1"))
        assertEquals("0.0.0", UserAgent.platformVersion("Baklava"))
        assertEquals("0.0.0", UserAgent.platformVersion(""))
    }

    @Test
    fun desktopIsChromeOnLinuxWithTheSameEngineVersion() {
        assertEquals(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            UserAgent.desktop(UserAgent.normalize(phone))
        )
        // Tablets already lack the Mobile token; only the platform section changes.
        assertEquals(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            UserAgent.desktop(UserAgent.normalize(tablet))
        )
    }

    @Test
    fun desktopIsIdempotentAndKeepsTheChromeVersion() {
        val desktop = UserAgent.desktop(UserAgent.normalize(phone))
        assertEquals(desktop, UserAgent.desktop(desktop))
        assertEquals("122.0.0.0", UserAgent.chromeVersion(desktop))
        assertFalse(desktop.contains("Android"))
        assertFalse(desktop.contains("Mobile"))
    }
}
