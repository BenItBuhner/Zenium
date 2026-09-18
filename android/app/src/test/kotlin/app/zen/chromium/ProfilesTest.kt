package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProfilesTest {
    @Test
    fun everyContainerHasAProfileOfItsOwn() {
        assertEquals("Default", Profiles.nameFor(Profiles.DEFAULT_CONTAINER))
        assertEquals("zen-private", Profiles.nameFor(Profiles.PRIVATE_CONTAINER))
        assertEquals("zen-container-work", Profiles.nameFor("work"))
        // The core's PRIVATE_CONTAINER_ID (shared/types.ts).
        assertEquals("private", Profiles.PRIVATE_CONTAINER)
    }

    @Test
    fun onlyThePrivateContainerIsPrivate() {
        assertTrue(Profiles.isPrivate(Profiles.PRIVATE_CONTAINER))
        assertFalse(Profiles.isPrivate(Profiles.DEFAULT_CONTAINER))
        assertFalse(Profiles.isPrivate("work"))
    }

    // --- whose profile a wipe may empty -----------------------------------------------------------

    @Test
    fun aProfileIsAContainersOwnOnlyUnderItsOwnNameAndNeverTheDefault() {
        assertTrue(Profiles.isOwnProfile("private", "zen-private"))
        assertTrue(Profiles.isOwnProfile("work", "zen-container-work"))
        // The lookup came back as the default profile, or as nothing: not the container's.
        assertFalse(Profiles.isOwnProfile("private", "Default"))
        assertFalse(Profiles.isOwnProfile("private", null))
        assertFalse(Profiles.isOwnProfile("work", "zen-private"))
        // The default container's profile is the default one by design, never "its own" to wipe as a container's.
        assertFalse(Profiles.isOwnProfile("default", "Default"))
    }

    @Test
    fun withoutProfilesNoContainerHasOneOfItsOwnWhateverTheStoreLists() {
        val store = FakeStore(multiProfile = false, "Default", "zen-private")
        assertNull(Profiles.ownProfile("private", store))
        assertNull(Profiles.ownProfile("work", store))
        assertNull(Profiles.ownProfile("default", store))
    }

    @Test
    fun withProfilesAContainerOwnsTheOneCreatedForIt() {
        val store = FakeStore(multiProfile = true, "Default", "zen-private")
        assertEquals("zen-private", Profiles.ownProfile("private", store))
        assertNull(Profiles.ownProfile("work", store))
        assertNull(Profiles.ownProfile("default", store))
    }

    // --- the private clear (the last private tab closed) ----------------------------------------

    @Test
    fun onAWebViewWithoutProfilesThePrivateClearIsANoOpAndTheDefaultProfileKeepsItsData() {
        // WebView 113: one profile, the default, and every container – the private one too – on it.
        val store = FakeStore(multiProfile = false, "Default")
        store.cookies("Default").addAll(listOf("sid=1", "theme=dark"))
        store.storage("Default").add("https://mail.example")
        var done = 0

        val wiped = Profiles.clear("private", store) { done++ }

        assertFalse(wiped)
        assertEquals(1, done)
        assertEquals(emptyList<String>(), store.cleared)
        assertEquals(emptyList<String>(), store.deleted)
        assertEquals(setOf("sid=1", "theme=dark"), store.cookies("Default"))
        assertEquals(setOf("https://mail.example"), store.storage("Default"))
        assertEquals(1, store.logged.size)
        assertTrue(store.logged.single(), store.logged.single().contains("private"))
    }

    @Test
    fun withProfilesThePrivateClearEmptiesAndDeletesThePrivateProfileAlone() {
        val store = FakeStore(multiProfile = true, "Default", "zen-private")
        store.cookies("Default").add("sid=1")
        store.cookies("zen-private").add("tracker=x")
        store.storage("zen-private").add("https://shop.example")
        var done = 0

        val wiped = Profiles.clear("private", store) { done++ }

        assertTrue(wiped)
        assertEquals(1, done)
        assertEquals(listOf("private"), store.cleared)
        assertEquals(listOf("zen-private"), store.deleted)
        assertEquals(emptySet<String>(), store.cookies("zen-private"))
        assertEquals(emptySet<String>(), store.storage("zen-private"))
        assertEquals(setOf("sid=1"), store.cookies("Default"))
        assertEquals(listOf("Default"), store.names())
        assertEquals(emptyList<String>(), store.logged)
    }

    @Test
    fun aLookupThatComesBackAsTheDefaultProfileIsRefusedLikeNoProfileAtAll() {
        val store = FakeStore(multiProfile = true, "Default", "zen-private")
        store.cookies("Default").add("sid=1")
        store.resolver = { "Default" }
        var done = 0

        assertFalse(Profiles.clear("private", store) { done++ })

        assertEquals(1, done)
        assertEquals(emptyList<String>(), store.cleared)
        assertEquals(emptyList<String>(), store.deleted)
        assertEquals(setOf("sid=1"), store.cookies("Default"))
        assertEquals(1, store.logged.size)
    }

    @Test
    fun aPrivateProfileNeverCreatedIsNothingToClear() {
        val store = FakeStore(multiProfile = true, "Default")
        var done = 0
        assertFalse(Profiles.clear("private", store) { done++ })
        assertEquals(1, done)
        assertEquals(emptyList<String>(), store.cleared)
        assertEquals(emptyList<String>(), store.deleted)
    }

    @Test
    fun aDeletedContainerIsWipedOnlyWhereItHadAProfileOfItsOwn() {
        val old = FakeStore(multiProfile = false, "Default")
        old.cookies("Default").add("sid=1")
        assertFalse(Profiles.clear("work", old))
        assertEquals(setOf("sid=1"), old.cookies("Default"))
        assertEquals(emptyList<String>(), old.cleared)

        val current = FakeStore(multiProfile = true, "Default", "zen-container-work")
        current.cookies("zen-container-work").add("wid=2")
        assertTrue(Profiles.clear("work", current))
        assertEquals(listOf("work"), current.cleared)
        assertEquals(listOf("zen-container-work"), current.deleted)
        assertEquals(emptySet<String>(), current.cookies("zen-container-work"))
    }

    @Test
    fun theDefaultContainersClearEmptiesTheDefaultProfileAndKeepsIt() {
        val store = FakeStore(multiProfile = true, "Default", "zen-private")
        store.cookies("Default").add("sid=1")
        store.cookies("zen-private").add("tracker=x")
        var done = 0

        assertTrue(Profiles.clear("default", store) { done++ })

        assertEquals(1, done)
        assertEquals(listOf("default"), store.cleared)
        assertEquals(emptyList<String>(), store.deleted)
        assertEquals(emptySet<String>(), store.cookies("Default"))
        assertEquals(setOf("tracker=x"), store.cookies("zen-private"))
    }

    // --- the wipe at start ----------------------------------------------------------------------

    @Test
    fun theWipeAtStartTouchesNothingOnAWebViewWithoutProfiles() {
        val store = FakeStore(multiProfile = false, "Default")
        store.cookies("Default").add("sid=1")
        var done = 0

        assertFalse(Profiles.wipePrivate(store) { done++ })

        assertEquals(1, done)
        assertEquals(emptyList<String>(), store.cleared)
        assertEquals(emptyList<String>(), store.emptied)
        assertEquals(emptyList<String>(), store.deleted)
        assertEquals(setOf("sid=1"), store.cookies("Default"))
        assertEquals(1, store.logged.size)
    }

    @Test
    fun theWipeAtStartCostsNothingWithoutAPrivateProfileAndTakesOneThatIsThere() {
        val clean = FakeStore(multiProfile = true, "Default")
        var done = 0
        assertFalse(Profiles.wipePrivate(clean) { done++ })
        assertEquals(1, done)
        assertEquals(emptyList<String>(), clean.cleared)
        assertEquals(emptyList<String>(), clean.logged)

        val crashed = FakeStore(multiProfile = true, "Default", "zen-private")
        crashed.cookies("zen-private").add("tracker=x")
        crashed.cookies("Default").add("sid=1")
        done = 0
        assertTrue(Profiles.wipePrivate(crashed) { done++ })
        assertEquals(1, done)
        assertEquals(listOf("private"), crashed.cleared)
        assertEquals(listOf("zen-private"), crashed.deleted)
        assertEquals(emptySet<String>(), crashed.cookies("zen-private"))
        assertEquals(setOf("sid=1"), crashed.cookies("Default"))
    }

    @Test
    fun theWipeAtStartTakesTheLegacyPrivateProfileWithItOnlyUnderItsOwnName() {
        val store = FakeStore(multiProfile = true, "Default", "zen-container-private")
        store.cookies("zen-container-private").add("old=1")
        var done = 0
        assertTrue(Profiles.wipePrivate(store) { done++ })
        assertEquals(1, done)
        assertEquals(listOf("zen-container-private"), store.emptied)
        assertEquals(listOf("zen-container-private"), store.deleted)
        assertEquals(emptyList<String>(), store.cleared)

        val odd = FakeStore(multiProfile = true, "Default", "zen-container-private")
        odd.resolver = { "Default" }
        done = 0
        assertFalse(Profiles.wipePrivate(odd) { done++ })
        assertEquals(1, done)
        assertEquals(emptyList<String>(), odd.emptied)
        assertEquals(emptyList<String>(), odd.deleted)
    }

    /**
     * A profile store as the JVM can have one: the WebView's flag, its profiles with a cookie set
     * and a storage set each, and a record of every wipe. `clearData` empties the stores the WebView
     * hands out for a container – its own profile's, or the default profile's when it has none of
     * its own there, as `Profiles.cookieManager` / `webStorage` do – which is the hazard the guards
     * in [Profiles] exist for.
     */
    private class FakeStore(override val multiProfile: Boolean, vararg names: String) : Profiles.Store {
        private val profiles = names.toMutableList()
        private val cookieSets = HashMap<String, MutableSet<String>>()
        private val storageSets = HashMap<String, MutableSet<String>>()
        /** Container ids whose data was cleared. */
        val cleared = ArrayList<String>()
        /** Profiles emptied by name (the legacy private profile). */
        val emptied = ArrayList<String>()
        val deleted = ArrayList<String>()
        val logged = ArrayList<String>()
        /** What the store hands out for a profile name: the profile of that name when it exists. */
        var resolver: (String) -> String? = { name -> name.takeIf { it in profiles } }

        fun cookies(profile: String): MutableSet<String> = cookieSets.getOrPut(profile) { LinkedHashSet() }
        fun storage(profile: String): MutableSet<String> = storageSets.getOrPut(profile) { LinkedHashSet() }

        override fun names(): List<String> = profiles.toList()
        override fun resolve(name: String): String? = resolver(name)

        override fun clearData(containerId: String, done: () -> Unit) {
            val own = Profiles.nameFor(containerId).takeIf { multiProfile && it in profiles }
            val profile = own ?: "Default"
            cookies(profile).clear()
            storage(profile).clear()
            cleared += containerId
            done()
        }

        override fun clearProfile(name: String) {
            cookies(name).clear()
            storage(name).clear()
            emptied += name
        }

        override fun delete(name: String): Boolean {
            deleted += name
            return profiles.remove(name)
        }

        override fun log(message: String) {
            logged += message
        }
    }
}
