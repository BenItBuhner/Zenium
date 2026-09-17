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

    /** Chrome's own reduced user agent on the same phone. */
    private val chrome =
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"

    @Test
    fun normalizeDropsTheEmbeddedViewMarkersAndKeepsTheVersions() {
        assertEquals(
            "Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/122.0.6261.119 Mobile Safari/537.36",
            UserAgent.normalize(phone)
        )
    }

    @Test
    fun normalizeHandlesTabletsAndReducedPlatformSections() {
        val tablet =
            "Mozilla/5.0 (Linux; Android 14; SM-X910 Build/UP1A.231005.007; wv) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Safari/537.36"
        assertEquals(
            "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Safari/537.36",
            UserAgent.normalize(tablet)
        )
        // A WebView that already reduces the Android version and model the way Chrome does.
        val reduced =
            "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/135.0.0.0 Mobile Safari/537.36"
        assertEquals(
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
            UserAgent.normalize(reduced)
        )
        // No model at all: no separator is left dangling before the closing bracket.
        val bare = "Mozilla/5.0 (Linux; Android 14; Build/AP1A.240305.019.A1; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36"
        assertEquals(
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36",
            UserAgent.normalize(bare)
        )
    }

    @Test
    fun normalizeLeavesBrowserUserAgentsAlone() {
        assertEquals(chrome, UserAgent.normalize(chrome))
        assertEquals(UserAgent.normalize(phone), UserAgent.normalize(UserAgent.normalize(phone)))
    }

    @Test
    fun normalizedUserAgentCarriesNoEmbeddedViewMarker() {
        val normalized = UserAgent.normalize(phone)
        assertFalse(normalized.contains("wv"))
        assertFalse(normalized.contains("Version/"))
        assertFalse(normalized.contains("Build/"))
        assertTrue(normalized.contains("Android 14"))
        assertTrue(normalized.contains("Chrome/122.0.6261.119"))
    }

    @Test
    fun chromeVersionComesFromTheProductToken() {
        assertEquals("122.0.6261.119", UserAgent.chromeVersion(phone))
        assertEquals("122.0.0.0", UserAgent.chromeVersion(chrome))
        assertEquals("122", UserAgent.major("122.0.6261.119"))
        assertNull(UserAgent.chromeVersion("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Safari/537.36"))
    }

    @Test
    fun brandsNameTheEngineAndTheProductButNotTheWebView() {
        val brands = UserAgent.brands("122.0.6261.119", "0.2.0")
        assertEquals(listOf("Chromium", "Zenium", "Not;A=Brand"), brands.map { it.brand })
        assertEquals(UserAgent.Brand("Chromium", "122", "122.0.6261.119"), brands[0])
        assertEquals(UserAgent.Brand("Zenium", "0", "0.2.0"), brands[1])
        assertFalse(brands.any { it.brand.contains("WebView") })
        for (brand in brands) {
            assertTrue("${brand.brand} major", brand.major.all(Char::isDigit) && brand.major.isNotEmpty())
            assertTrue("${brand.brand} full", brand.full.startsWith(brand.major + "."))
        }
    }

    @Test
    fun productBrandUsesTheReleaseVersionOnly() {
        val brands = UserAgent.brands("135.0.0.0", "0.3.0-beta.2+build.7")
        assertEquals(UserAgent.Brand("Zenium", "0", "0.3.0"), brands[1])
    }
}
