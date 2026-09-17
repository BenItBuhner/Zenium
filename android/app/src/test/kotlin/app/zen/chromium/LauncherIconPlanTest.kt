package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

class LauncherIconPlanTest {
    private val variants = listOf("indigo", "purple", "ocean", "graphite")
    private val default = "indigo"

    private fun on(vararg ids: String): (String) -> Boolean = { it in ids }

    @Test
    fun switchingEnablesTheNewAliasBeforeDisablingTheOld() {
        val changes = LauncherIconPlan.changes(variants, default, "ocean", on("indigo"))
        assertEquals(
            listOf(LauncherIconPlan.Change("ocean", true), LauncherIconPlan.Change("indigo", false)),
            changes
        )
    }

    @Test
    fun choosingTheCurrentIconChangesNothing() {
        assertEquals(emptyList<LauncherIconPlan.Change>(), LauncherIconPlan.changes(variants, default, "purple", on("purple")))
    }

    @Test
    fun everyStrayEnabledAliasIsDisabled() {
        // Two aliases on at once (an interrupted switch): the chosen one is kept, the rest go.
        val changes = LauncherIconPlan.changes(variants, default, "purple", on("indigo", "purple", "graphite"))
        assertEquals(
            listOf(LauncherIconPlan.Change("indigo", false), LauncherIconPlan.Change("graphite", false)),
            changes
        )
    }

    @Test
    fun noAliasEnabledStillEndsWithExactlyOne() {
        assertEquals(
            listOf(LauncherIconPlan.Change("graphite", true)),
            LauncherIconPlan.changes(variants, default, "graphite", on())
        )
    }

    @Test
    fun unknownIdsFallBackToTheDefault() {
        val changes = LauncherIconPlan.changes(variants, default, "magenta", on("ocean"))
        assertEquals(
            listOf(LauncherIconPlan.Change("indigo", true), LauncherIconPlan.Change("ocean", false)),
            changes
        )
        assertEquals(emptyList<LauncherIconPlan.Change>(), LauncherIconPlan.changes(variants, default, "", on("indigo")))
    }

    @Test
    fun currentIsTheEnabledAliasOrTheDefault() {
        assertEquals("ocean", LauncherIconPlan.current(variants, default, on("ocean")))
        assertEquals("indigo", LauncherIconPlan.current(variants, default, on()))
        // Manifest order decides when two are on (the first listed wins, deterministic).
        assertEquals("purple", LauncherIconPlan.current(variants, default, on("graphite", "purple")))
    }

    @Test
    fun generatedTableHasTheDefaultAndUniqueAliases() {
        val ids = LauncherIconVariants.ALIASES.keys
        assert(LauncherIconVariants.DEFAULT in ids)
        assertEquals(ids.size, LauncherIconVariants.ALIASES.values.toSet().size)
        for ((id, cls) in LauncherIconVariants.ALIASES) {
            assert(cls.startsWith("app.zen.chromium.icon.")) { cls }
            assertEquals(id, cls.substringAfterLast('.').lowercase())
        }
    }
}
