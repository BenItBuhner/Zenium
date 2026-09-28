package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The host's reply for an app-restrictions bundle (TB-13, `ManagedRestrictions.summarize`): the
 * keys the bundle carries and the organisation's name when `EnterpriseCustomLabel` gives one,
 * never a value – the Android read itself is the emulator's (`ManagedDemo`).
 */
class ManagedRestrictionsTest {
    private fun keysOf(reply: JSONObject): List<String> {
        val arr = reply.getJSONArray("keys")
        return (0 until arr.length()).map { arr.getString(it) }
    }

    @Test
    fun `an empty bundle is unmanaged - no keys, no name`() {
        val reply = ManagedRestrictions.summarize(emptyMap())
        assertEquals(emptyList<String>(), keysOf(reply))
        assertTrue(reply.isNull("by"))
    }

    @Test
    fun `the keys come back trimmed, each once, sorted, and the values stay behind`() {
        val reply = ManagedRestrictions.summarize(
            linkedMapOf(
                "URLBlocklist" to listOf("example.com"),
                " HomepageLocation " to "https://intranet.example",
                "URLBlocklist" to null,
                "" to "nothing",
                "IncognitoModeAvailability" to 1
            )
        )
        assertEquals(listOf("HomepageLocation", "IncognitoModeAvailability", "URLBlocklist"), keysOf(reply))
        assertTrue(reply.isNull("by"))
        val text = reply.toString()
        assertTrue(text, !text.contains("example.com") && !text.contains("intranet"))
        assertEquals(setOf("by", "keys"), reply.keys().asSequence().toSet())
    }

    @Test
    fun `EnterpriseCustomLabel names the organisation - trimmed, a string only, never on its own`() {
        val named = ManagedRestrictions.summarize(
            mapOf(ManagedRestrictions.ORG_KEY to "  Example Corp ", "URLBlocklist" to "x")
        )
        assertEquals("Example Corp", named.getString("by"))
        assertEquals(listOf("EnterpriseCustomLabel", "URLBlocklist"), keysOf(named))
        // The label is one of the bundle's keys: the label alone still makes the browser managed.
        val alone = ManagedRestrictions.summarize(mapOf(ManagedRestrictions.ORG_KEY to "Example Corp"))
        assertEquals("Example Corp", alone.getString("by"))
        assertEquals(listOf("EnterpriseCustomLabel"), keysOf(alone))
        // A blank label, or one that is not a string, names nobody.
        assertTrue(ManagedRestrictions.summarize(mapOf(ManagedRestrictions.ORG_KEY to "  ")).isNull("by"))
        assertTrue(ManagedRestrictions.summarize(mapOf(ManagedRestrictions.ORG_KEY to 7)).isNull("by"))
    }
}
