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

    @Test
    fun `the reply is capped as the core caps it - over-long keys dropped, the list and the name cut`() {
        // The core's numbers (shared/managed.ts): the two sides must agree on one bundle.
        assertEquals(512, ManagedRestrictions.KEYS_MAX)
        assertEquals(200, ManagedRestrictions.KEY_MAX)
        assertEquals(120, ManagedRestrictions.BY_MAX)
        val long = "K".repeat(ManagedRestrictions.KEY_MAX + 1)
        val entries = LinkedHashMap<String, Any?>()
        entries[long] = "x"
        for (i in 0 until ManagedRestrictions.KEYS_MAX + 5) entries["Key" + i.toString().padStart(4, '0')] = i
        entries[ManagedRestrictions.ORG_KEY] = "N".repeat(ManagedRestrictions.BY_MAX + 10)
        val reply = ManagedRestrictions.summarize(entries)
        val keys = keysOf(reply)
        assertEquals(ManagedRestrictions.KEYS_MAX, keys.size)
        assertTrue(long !in keys)
        // The cut comes after the sort: the first keys of the sorted list, as the core keeps them.
        assertEquals("EnterpriseCustomLabel", keys[0])
        assertEquals("Key0000", keys[1])
        assertEquals(ManagedRestrictions.BY_MAX, reply.getString("by").length)
        // At the caps exactly, nothing is touched.
        val edge = "E".repeat(ManagedRestrictions.KEY_MAX)
        val exact = ManagedRestrictions.summarize(
            mapOf(edge to 1, ManagedRestrictions.ORG_KEY to "B".repeat(ManagedRestrictions.BY_MAX))
        )
        assertEquals(listOf(edge, ManagedRestrictions.ORG_KEY), keysOf(exact))
        assertEquals("B".repeat(ManagedRestrictions.BY_MAX), exact.getString("by"))
    }
}
