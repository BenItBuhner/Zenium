package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceRegionTest {
    @Test
    fun `the network's country comes first, then the SIM's, then the locale's`() {
        assertEquals("DE", DeviceRegion.resolve(null, "de", "fr", "US"))
        // No network at boot (airplane mode, no signal): the SIM's home market.
        assertEquals("FR", DeviceRegion.resolve(null, "", "fr", "US"))
        assertEquals("FR", DeviceRegion.resolve(null, null, "fr", "US"))
        // A Wi-Fi tablet without telephony: the locale's region alone.
        assertEquals("US", DeviceRegion.resolve(null, null, null, "US"))
        // Nothing on the device names a country: null, never in the EEA.
        assertNull(DeviceRegion.resolve(null, "", "", ""))
        assertNull(DeviceRegion.resolve(null, null, null, null))
    }

    @Test
    fun `answers are two upper-case letters or passed over`() {
        // The emulator's SIM answers in lower case; the payload carries upper case.
        assertEquals("US", DeviceRegion.resolve(null, "us", null, null))
        // A three-letter or junk answer is not a region: the next source answers.
        assertEquals("AT", DeviceRegion.resolve(null, "---", "at", null))
        assertEquals("AT", DeviceRegion.resolve(null, "USA", null, "at"))
        assertEquals("AT", DeviceRegion.resolve(null, " at ", null, null))
        assertNull(DeviceRegion.normalize("1A"))
        assertNull(DeviceRegion.normalize(""))
        assertNull(DeviceRegion.normalize(null))
        assertEquals("NO", DeviceRegion.normalize("no"))
    }

    @Test
    fun `the tester's override stands in the device's place`() {
        // `setprop debug.zenium.region DE` on a device whose network says the US.
        assertEquals("DE", DeviceRegion.resolve("DE", "us", "us", "US"))
        assertEquals("DE", DeviceRegion.resolve(" de ", "us", "us", "US"))
        // `-` names no region at all, over a device that has one.
        assertNull(DeviceRegion.resolve("-", "de", "de", "DE"))
        // An override of another shape is ignored and the device answers.
        assertEquals("US", DeviceRegion.resolve("germany", "us", null, null))
        assertEquals("US", DeviceRegion.resolve("", "us", null, null))
    }

    @Test
    fun `the property's name is the one the drivers set`() {
        assertEquals("debug.zenium.region", DeviceRegion.OVERRIDE_PROPERTY)
        assertEquals("-", DeviceRegion.OVERRIDE_NONE)
    }
}
