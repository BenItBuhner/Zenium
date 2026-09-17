package app.zen.chromium

/**
 * Which launcher aliases to flip so that exactly one – the chosen colour – stays enabled. Pure,
 * so the order and the no-op behaviour are unit-tested without a device.
 */
object LauncherIconPlan {
    data class Change(val id: String, val enabled: Boolean)

    /**
     * The component state changes that take `variants` from the states `isOn` reports to "only
     * `chosen` enabled":
     *
     *  - the chosen alias is enabled *first*, so the launcher never sees the package without a
     *    launcher entry (that is when launchers drop the app from the home screen for good);
     *  - aliases already in the right state are left alone – every change is a package-changed
     *    broadcast the launcher reacts to;
     *  - a `chosen` that is not a variant (an old profile, a typo) selects `default`.
     */
    fun changes(variants: List<String>, default: String, chosen: String, isOn: (String) -> Boolean): List<Change> {
        val target = if (chosen in variants) chosen else default
        val changes = ArrayList<Change>()
        if (!isOn(target)) changes += Change(target, true)
        for (variant in variants) {
            if (variant != target && isOn(variant)) changes += Change(variant, false)
        }
        return changes
    }

    /** The variant currently on: the first enabled one, or the default when none reports enabled. */
    fun current(variants: List<String>, default: String, isOn: (String) -> Boolean): String =
        variants.firstOrNull(isOn) ?: default
}
