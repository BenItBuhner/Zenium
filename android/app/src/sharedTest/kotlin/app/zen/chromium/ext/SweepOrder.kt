package app.zen.chromium.ext

/**
 * The order the compat sweep runs its rows in (CompatSweep.kt `demo()`), kept free of Android so
 * it runs on the JVM (`SweepOrderTest`) and compiled into the unit tests and the instrumentation
 * alike (`src/sharedTest`), never into the app.
 *
 * A sweep runs the table's rows named by `only` (every row when `only` is null) in the TABLE's
 * order with the `last` rows moved behind them: a row that takes the process down loses nothing
 * but the rows behind it. Up to compat round 22 the move was a stable sort on "is it in `last`",
 * which kept the `last` rows in the table's order too – so a lane list that named Reader View
 * last of all (its 156 sink is the lane's recurring death, round 22 §7) had it run wherever the
 * table put it, third of five. Here the `last` rows run in the LIST's order, the ids as the
 * driver's `last` argument (`SWEEP_LAST`) names them; a name without a row, or outside `only`,
 * is ignored, and a row named twice runs once, at its first place.
 */
object SweepOrder {
    fun <T> order(table: List<T>, id: (T) -> String, only: Collection<String>?, last: List<String>): List<T> {
        val selected = table.filter { only == null || id(it) in only }
        val lastIds = last.toSet()
        val byId = selected.associateBy(id)
        return selected.filter { id(it) !in lastIds } + last.distinct().mapNotNull { byId[it] }
    }
}
