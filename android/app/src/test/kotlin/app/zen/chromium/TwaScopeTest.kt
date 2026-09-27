package app.zen.chromium

import app.zen.chromium.TwaScope.Verification
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TwaScopeTest {
    private val app = "https://app.example"
    private val trusted = setOf(app, "https://pay.example:8443")

    @Test
    fun originIsSchemeHostAndPortWithTheDefaultFolded() {
        assertEquals("https://app.example", TwaScope.origin("https://app.example/inbox?x=1#y"))
        assertEquals("https://app.example", TwaScope.origin("HTTPS://App.Example:443/"))
        assertEquals("http://app.example", TwaScope.origin("http://app.example:80/"))
        assertEquals("https://app.example:8443", TwaScope.origin("https://app.example:8443/"))
        assertEquals("http://app.example:443", TwaScope.origin("http://app.example:443/"))
        assertEquals("https://app.example", TwaScope.origin("https://user:secret@app.example/"))
        assertEquals("http://localhost:8080", TwaScope.origin("http://localhost:8080/start"))
    }

    @Test
    fun onlyHttpAndHttpsHaveAnOrigin() {
        assertNull(TwaScope.origin("about:blank"))
        assertNull(TwaScope.origin("data:text/html,<p>hi</p>"))
        assertNull(TwaScope.origin("javascript:void(0)"))
        assertNull(TwaScope.origin("ftp://app.example/"))
        assertNull(TwaScope.origin("file:///sdcard/a.html"))
        assertNull(TwaScope.origin("zen://error?u=https://app.example/"))
        assertNull(TwaScope.origin("intent://scan/#Intent;scheme=zxing;end"))
        assertNull(TwaScope.origin(""))
        assertNull(TwaScope.origin(null))
        assertNull(TwaScope.origin("not a url"))
    }

    @Test
    fun theClaimedSetIsTheLaunchOriginAndTheAdditionalOnes() {
        val set = TwaScope.trustedOrigins(
            "https://app.example/start?utm=1",
            listOf("https://pay.example:8443/", "HTTPS://Cdn.Example", "about:blank", "", "nonsense"),
        )
        assertEquals(setOf("https://app.example", "https://pay.example:8443", "https://cdn.example"), set)
        assertEquals(emptySet<String>(), TwaScope.trustedOrigins(null, null))
        assertEquals(setOf("https://app.example"), TwaScope.trustedOrigins("https://app.example/", null))
    }

    @Test
    fun aClaimedOriginIsPendingUntilItsVerdictLands() {
        assertEquals(Verification.PENDING, TwaScope.stateFor("https://app.example/start", trusted, emptyMap(), null))
        assertEquals(
            Verification.VERIFIED,
            TwaScope.stateFor("https://app.example/start", trusted, mapOf(app to Verification.VERIFIED), null),
        )
        assertEquals(
            Verification.FAILED,
            TwaScope.stateFor("https://app.example/start", trusted, mapOf(app to Verification.FAILED), null),
        )
        // The second claimed origin has its own verdict; the first's does not speak for it.
        assertEquals(
            Verification.PENDING,
            TwaScope.stateFor("https://pay.example:8443/checkout", trusted, mapOf(app to Verification.VERIFIED), null),
        )
    }

    @Test
    fun anUnclaimedOriginFailsAtOnceUnlessItWasVerifiedBefore() {
        val verified = mapOf(app to Verification.VERIFIED)
        assertEquals(Verification.FAILED, TwaScope.stateFor("https://other.example/", trusted, verified, Verification.VERIFIED))
        // A subdomain is another origin, as Chrome's OriginVerifier holds: nothing is inherited.
        assertEquals(Verification.FAILED, TwaScope.stateFor("https://www.app.example/", trusted, verified, Verification.VERIFIED))
        assertEquals(Verification.FAILED, TwaScope.stateFor("https://app.example.evil/", trusted, verified, Verification.VERIFIED))
        // The same host on another scheme or port is another origin too.
        assertEquals(Verification.FAILED, TwaScope.stateFor("http://app.example/", trusted, verified, Verification.VERIFIED))
        assertEquals(Verification.FAILED, TwaScope.stateFor("https://app.example:8443/", trusted, verified, Verification.VERIFIED))
        // The claimed origin's port is the one the claim wrote: the default port is another.
        assertEquals(Verification.FAILED, TwaScope.stateFor("https://pay.example/", trusted, verified, Verification.VERIFIED))
        // An origin verified earlier in the session – for this client – stays trusted.
        val remembered = mapOf("https://other.example" to Verification.VERIFIED)
        assertEquals(Verification.VERIFIED, TwaScope.stateFor("https://other.example/x", trusted, remembered, Verification.FAILED))
        // A remembered failure is a failure, not a claim to re-verify.
        val failed = mapOf("https://other.example" to Verification.FAILED)
        assertEquals(Verification.FAILED, TwaScope.stateFor("https://other.example/x", trusted, failed, Verification.VERIFIED))
    }

    @Test
    fun aUrlWithNoOriginLeavesTheStateAsItWas() {
        assertEquals(Verification.VERIFIED, TwaScope.stateFor("about:blank", trusted, emptyMap(), Verification.VERIFIED))
        assertEquals(Verification.FAILED, TwaScope.stateFor("about:blank", trusted, emptyMap(), Verification.FAILED))
        assertEquals(Verification.PENDING, TwaScope.stateFor("data:text/html,x", trusted, emptyMap(), Verification.PENDING))
        assertEquals(Verification.VERIFIED, TwaScope.stateFor("zen://error?u=x", trusted, emptyMap(), Verification.VERIFIED))
        assertNull(TwaScope.stateFor("about:blank", trusted, emptyMap(), null))
        assertNull(TwaScope.stateFor(null, trusted, emptyMap(), null))
    }

    @Test
    fun onlyAFailureLeavesAppMode() {
        assertTrue(TwaScope.appMode(null))
        assertTrue(TwaScope.appMode(Verification.PENDING))
        assertTrue(TwaScope.appMode(Verification.VERIFIED))
        assertFalse(TwaScope.appMode(Verification.FAILED))
    }

    @Test
    fun theNotSecureBadgeIsHttpOffTheLoopbackAndADataDocument() {
        assertTrue(TwaScope.notSecure("http://app.example/"))
        assertTrue(TwaScope.notSecure("HTTP://app.example:8080/x"))
        assertTrue(TwaScope.notSecure("data:text/html,<p>hi</p>"))
        assertFalse(TwaScope.notSecure("https://app.example/"))
        assertFalse(TwaScope.notSecure("http://localhost:8080/"))
        assertFalse(TwaScope.notSecure("http://127.0.0.1/"))
        assertFalse(TwaScope.notSecure("http://app.localhost/"))
        assertFalse(TwaScope.notSecure("about:blank"))
        assertFalse(TwaScope.notSecure("zen://error?u=http://app.example/"))
        assertFalse(TwaScope.notSecure(""))
        assertFalse(TwaScope.notSecure(null))
    }

    @Test
    fun theToolbarShowsOutOfAppModeAndOnANotSecurePage() {
        assertFalse(TwaScope.toolbarShown(Verification.VERIFIED, "https://app.example/"))
        assertFalse(TwaScope.toolbarShown(Verification.PENDING, "https://app.example/"))
        assertFalse(TwaScope.toolbarShown(null, "https://app.example/"))
        assertFalse(TwaScope.toolbarShown(Verification.VERIFIED, "http://localhost:8080/"))
        assertFalse(TwaScope.toolbarShown(Verification.VERIFIED, "about:blank"))
        assertTrue(TwaScope.toolbarShown(Verification.FAILED, "https://other.example/"))
        assertTrue(TwaScope.toolbarShown(Verification.FAILED, "http://localhost:8080/"))
        assertTrue(TwaScope.toolbarShown(Verification.PENDING, "http://app.example/"))
        assertTrue(TwaScope.toolbarShown(Verification.VERIFIED, "http://app.example/"))
        assertTrue(TwaScope.toolbarShown(Verification.VERIFIED, "data:text/html,x"))
    }

    @Test
    fun aRedirectChainIsJudgedByWhereEachHopCommits() {
        val verdicts = mapOf(app to Verification.VERIFIED)
        var state: Verification? = null
        val shown = ArrayList<Boolean>()
        for (url in listOf(
            "https://app.example/start",
            "https://login.example/oauth?client=app",
            "http://login.example/legacy",
            "about:blank",
            "https://app.example/callback?code=1",
            "data:text/html,done",
            "https://app.example/home",
        )) {
            state = TwaScope.stateFor(url, trusted, verdicts, state)
            shown += TwaScope.toolbarShown(state, url)
        }
        // Out at the login hop, still out through its http leg and the blank page it leaves, back
        // in at the callback; the data: document is badged whatever the state, the home page not.
        assertEquals(listOf(false, true, true, true, false, true, false), shown)
        assertEquals(Verification.VERIFIED, state)
    }

    @Test
    fun theCloseButtonReturnsToTheNewestVerifiedPageOrCloses() {
        val verdicts = mapOf(app to Verification.VERIFIED, "https://pay.example:8443" to Verification.FAILED)
        val history = listOf(
            "https://app.example/start",
            "https://app.example/cart",
            "https://pay.example:8443/checkout",
            "https://bank.example/3ds",
        )
        assertEquals(1, TwaScope.landingIndex(history, 3, verdicts))
        assertEquals(1, TwaScope.landingIndex(history, 2, verdicts))
        assertEquals(0, TwaScope.landingIndex(history, 1, verdicts))
        assertNull(TwaScope.landingIndex(history, 0, verdicts))
        assertNull(TwaScope.landingIndex(history, 3, emptyMap()))
        assertNull(TwaScope.landingIndex(emptyList(), 0, verdicts))
        // A current index past the list's end walks from its last entry.
        assertEquals(1, TwaScope.landingIndex(history, 9, verdicts))
    }
}
