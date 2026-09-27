package app.zen.chromium

import app.zen.chromium.TwaScope.Verification
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class TwaVerifierTest {
    private val client = "com.example.client"
    private val fingerprint = "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5"
    private val statement = """
        [{
          "relation": ["delegate_permission/common.handle_all_urls"],
          "target": {
            "namespace": "android_app",
            "package_name": "$client",
            "sha256_cert_fingerprints": ["$fingerprint"]
          }
        }]
    """.trimIndent()

    @Test
    fun theStatementLivesUnderTheOriginsWellKnownPath() {
        assertEquals("https://app.example/.well-known/assetlinks.json", DigitalAssetLinks.statementUrl("https://app.example"))
        assertEquals("https://pay.example:8443/.well-known/assetlinks.json", DigitalAssetLinks.statementUrl("https://pay.example:8443"))
        assertEquals("http://localhost:8080/.well-known/assetlinks.json", DigitalAssetLinks.statementUrl("http://localhost:8080"))
    }

    @Test
    fun onlyHttpsAndHttpLocalhostCanBeVerified() {
        assertTrue(TwaVerifier.verifiable("https://app.example"))
        assertTrue(TwaVerifier.verifiable("https://pay.example:8443"))
        assertTrue(TwaVerifier.verifiable("http://localhost"))
        assertTrue(TwaVerifier.verifiable("http://localhost:8080"))
        // Chrome's gate is the one word `localhost`: the loopback address and a subdomain are not it.
        assertFalse(TwaVerifier.verifiable("http://app.example"))
        assertFalse(TwaVerifier.verifiable("http://127.0.0.1:8080"))
        assertFalse(TwaVerifier.verifiable("http://app.localhost"))
        assertFalse(TwaVerifier.verifiable("ftp://app.example"))
        assertFalse(TwaVerifier.verifiable("about:blank"))
        assertFalse(TwaVerifier.verifiable(""))
    }

    @Test
    fun aLaunchWithoutAClientOrACertificateFailsBeforeAnyFetch() {
        assertEquals("the launch names no client package", TwaVerifier.refusal("https://app.example", null, emptyList()))
        assertEquals("not https or localhost", TwaVerifier.refusal("http://app.example", client, listOf(fingerprint)))
        assertNotNull(TwaVerifier.refusal("https://app.example", client, emptyList()))
        assertTrue(TwaVerifier.refusal("https://app.example", client, emptyList())!!.contains(client))
        // The fetch is due only with a client, a certificate and a verifiable origin.
        assertNull(TwaVerifier.refusal("https://app.example", client, listOf(fingerprint)))
        assertNull(TwaVerifier.refusal("http://localhost:8080", client, listOf(fingerprint)))
        // The reasons are read in order: no client is the first word even for an http origin.
        assertEquals("the launch names no client package", TwaVerifier.refusal("http://app.example", null, emptyList()))
    }

    @Test
    fun theStatementDecidesTheVerdict() {
        val verified = TwaVerifier.verdict(statement, client, listOf(fingerprint))
        assertEquals(Verification.VERIFIED, verified.verification)
        assertNull(verified.reason)
        // Any case, colons or not, on the device's side.
        assertEquals(Verification.VERIFIED, TwaVerifier.verdict(statement, client, listOf(fingerprint.lowercase().replace(":", ""))).verification)

        val missing = TwaVerifier.verdict(null, client, listOf(fingerprint))
        assertEquals(Verification.FAILED, missing.verification)
        assertTrue(missing.reason!!.contains("assetlinks.json"))

        val otherPackage = TwaVerifier.verdict(statement, "com.example.other", listOf(fingerprint))
        assertEquals(Verification.FAILED, otherPackage.verification)
        assertNotNull(otherPackage.reason)
        assertEquals(Verification.FAILED, TwaVerifier.verdict(statement, client, listOf("AA:BB:CC")).verification)
        assertEquals(Verification.FAILED, TwaVerifier.verdict("<html>", client, listOf(fingerprint)).verification)
        assertEquals(Verification.FAILED, TwaVerifier.verdict("", client, listOf(fingerprint)).verification)
        val otherRelation = statement.replace("delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds")
        assertEquals(Verification.FAILED, TwaVerifier.verdict(otherRelation, client, listOf(fingerprint)).verification)
    }

    // --- the store across launches (Chrome's VerificationResultStore) --------------------------------

    private val origin = "https://app.example"
    private val claimant = TwaVerifier.Claimant(client, listOf(fingerprint))
    private val offline: (String) -> String? = { throw IOException("Unable to resolve host app.example") }

    @Test
    fun aRevokedStatementIsCaughtOnTheNextLaunch() {
        val store = TwaVerifier.Store()
        // Launch 1: the statement grants; the origin is remembered for this claimant.
        var fetched = 0
        assertEquals(Verification.VERIFIED, TwaVerifier.check(origin, claimant, store) { fetched++; statement }.verification)
        assertTrue(store.remembers(claimant, origin))
        // Launch 2: the check runs again – the remembered origin does not skip it – and the site
        // has taken the statement down: FAILED, and the saved success is gone with it.
        assertEquals(Verification.FAILED, TwaVerifier.check(origin, claimant, store) { fetched++; null }.verification)
        assertEquals(2, fetched)
        assertFalse(store.remembers(claimant, origin))
        assertTrue(store.verifiedOrigins(claimant).isEmpty())
        // Launch 3, offline: nothing saved to stand in.
        assertEquals(Verification.FAILED, TwaVerifier.check(origin, claimant, store, offline).verification)
        // A statement that names another package on the next launch forgets the success too.
        assertEquals(Verification.VERIFIED, TwaVerifier.check(origin, claimant, store) { statement }.verification)
        assertEquals(Verification.FAILED, TwaVerifier.check(origin, claimant, store) { statement.replace(client, "com.example.other") }.verification)
        assertFalse(store.remembers(claimant, origin))
    }

    @Test
    fun anOfflineLaunchReadsTheSavedSuccess() {
        val store = TwaVerifier.Store()
        assertEquals(Verification.VERIFIED, TwaVerifier.check(origin, claimant, store) { statement }.verification)
        // Chrome's NO_CONNECTION branch: the saved result decides, and the log says how.
        val saved = TwaVerifier.check(origin, claimant, store, offline)
        assertEquals(Verification.VERIFIED, saved.verification)
        assertTrue(saved.reason!!.contains("could not be fetched") && saved.reason!!.contains("earlier launch"))
        // The saved success is kept, not consumed: a second offline launch reads it again.
        assertEquals(Verification.VERIFIED, TwaVerifier.check(origin, claimant, store, offline).verification)
        assertTrue(store.remembers(claimant, origin))
        // The saved result speaks for its own origin alone.
        assertEquals(Verification.FAILED, TwaVerifier.check("https://pay.example:8443", claimant, store, offline).verification)
    }

    @Test
    fun anOfflineLaunchWithNoSavedResultFails() {
        val store = TwaVerifier.Store()
        val cold = TwaVerifier.check(origin, claimant, store, offline)
        assertEquals(Verification.FAILED, cold.verification)
        assertTrue(cold.reason!!.contains("could not be fetched") && cold.reason!!.contains("no earlier launch"))
        assertFalse(store.remembers(claimant, origin))
        // The gate still comes first, without a fetch: an http origin off localhost is refused,
        // a launch with no client names no claimant, and neither touches the store.
        var fetched = 0
        assertEquals("not https or localhost", TwaVerifier.check("http://app.example", claimant, store) { fetched++; statement }.reason)
        assertEquals("the launch names no client package", TwaVerifier.check(origin, null, store) { fetched++; statement }.reason)
        assertEquals(0, fetched)
        assertTrue(store.verifiedOrigins(claimant).isEmpty())
    }

    @Test
    fun aReinstallUnderAnotherCertificateIsANewClaimant() {
        val store = TwaVerifier.Store()
        assertEquals(Verification.VERIFIED, TwaVerifier.check(origin, claimant, store) { statement }.verification)
        // The same package signed by another certificate inherits nothing saved: offline, it fails.
        val resigned = TwaVerifier.Claimant(client, listOf("AA:BB:CC"))
        assertEquals(Verification.FAILED, TwaVerifier.check(origin, resigned, store, offline).verification)
        assertFalse(store.remembers(resigned, origin))
        assertTrue(store.remembers(claimant, origin))
        // Nor does another package under the same certificate.
        assertFalse(store.remembers(TwaVerifier.Claimant("com.example.other", listOf(fingerprint)), origin))
        // The certificates in another order are the same claimant (Chrome sorts them into the key).
        val twoCerts = TwaVerifier.Claimant(client, listOf(fingerprint, "AA:BB:CC"))
        assertEquals(twoCerts, TwaVerifier.Claimant(client, listOf("AA:BB:CC", fingerprint)))
        assertEquals(twoCerts.hashCode(), TwaVerifier.Claimant(client, listOf("AA:BB:CC", fingerprint)).hashCode())
        assertEquals(listOf(fingerprint, "AA:BB:CC"), twoCerts.fingerprints)
        assertEquals(Verification.VERIFIED, TwaVerifier.check(origin, twoCerts, store) { statement }.verification)
        assertTrue(store.remembers(TwaVerifier.Claimant(client, listOf("AA:BB:CC", fingerprint)), origin))
        assertEquals(setOf(origin), store.verifiedOrigins(twoCerts))
    }
}
