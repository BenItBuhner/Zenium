package app.zen.chromium

import app.zen.chromium.TwaScope.Verification
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
