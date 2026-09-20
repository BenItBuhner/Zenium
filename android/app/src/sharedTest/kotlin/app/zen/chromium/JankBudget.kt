package app.zen.chromium

/**
 * The jank budget behind `DemoHarness.measureFrames`: how many janky frames and how long a 95th
 * percentile frame a scene of each kind may have on the shared emulator recipe before the gate
 * speaks up. ONE place for the numbers; the harness applies them, the workflow's summary shows
 * them next to every scene, and `JankBudgetTest` pins the evaluation.
 *
 * The numbers are RECIPE-RELATIVE. They are read on the shared recipe alone (`.github/workflows/
 * android-emulator-demo.yml`: a `pixel_6` image – API 34 for most demos, API 35 for the sheet
 * recede demo –, `-gpu swangle`, the display at 720x1600 and density 280) and mean nothing on a
 * phone: the hosted runner has no GPU, so ANGLE over SwiftShader renders every frame on the CPU,
 * which inflates the render thread's issue and swap stages many times over and stretches most
 * frames past their deadline. What the gate catches is a CHANGE against the fixed baseline read
 * on the same recipe – a scene whose 95th percentile or janky share climbs past what the fixed
 * chrome measured in the same driver on the same image – not an absolute frame time. The
 * main-thread stages (input, animation, layout, draw) are representative all the same; the GPU-side
 * ones are the caveat, stated in every report.
 *
 * PROVISIONAL VALUES. The budgets below are seeded from PERF-3's own baseline run of the two
 * adopted scenes on the UNFIXED chrome (`BarHideDemo`'s scroll and snap, `SheetRecedeDemo`'s menu
 * open and close), with headroom, so that the gate reports without failing anything while PERF-1
 * (the bar-hide scroll) and PERF-2 (the menu sheet) profile and fix. Once they hand over the
 * FIXED baselines, the coordinator replaces the three [Budget]s with those numbers plus the
 * agreed headroom, sets `provisional = false`, and flips the gate to hard (`JANK_GATE=hard`
 * through the shared workflow's `jank-gate` input or the driver script's environment).
 *
 * The gate: SOFT reports every scene and fails nothing; HARD fails the SCENE whose budget is
 * breached – a jank fault the harness raises at the end of the run with the scene's table in the
 * message, like a touch fault – never the run as a whole mid-sequence, so the recording and the
 * other claims are still made.
 */
object JankBudget {
    /** What a scene is: the kinds have budgets of their own because their frames are different work. */
    enum class Kind(val key: String) {
        /** A finger-driven motion: a scroll with the bar following, a sheet dragged by its handle. */
        GESTURE("gesture"),

        /** A release settling: the bar snapping home, a sheet springing back after a drag. */
        SPRING("spring"),

        /** A surface coming up or going: the menu sheet opening or closing (mount, spring and swap). */
        OPEN("open");

        companion object {
            fun parse(key: String?): Kind? = values().firstOrNull { it.key == key }
        }
    }

    /** How the gate acts on a breach. */
    enum class Gate(val key: String) {
        /** Report only: the scene's numbers and the breach go to the record and the summary, nothing fails. */
        SOFT("soft"),

        /** A breach fails the scene (a jank fault at the end of the run), the run's other claims are still made. */
        HARD("hard");

        companion object {
            /** `soft` unless the argument reads `hard` (any case); an unknown or missing value is soft. */
            fun parse(key: String?): Gate = if (key?.trim()?.lowercase() == HARD.key) HARD else SOFT
        }
    }

    /**
     * The budget of one scene kind: the janky share (0 to 1) and the 95th percentile frame time
     * (ms) the scene may reach on the shared recipe. `provisional` says the numbers are PERF-3's
     * seed, not the fixed baseline.
     */
    data class Budget(val jankyShare: Double, val p95Ms: Int, val provisional: Boolean) {
        fun describe(): String =
            "janky <= ${(jankyShare * 100).toInt()}%, p95 <= $p95Ms ms" + if (provisional) " (provisional)" else ""
    }

    // --- THE NUMBERS -----------------------------------------------------------------------------
    //
    // PROVISIONAL: seeded from PERF-3's baseline run of the two adopted drivers on the UNFIXED
    // chrome at e59cb52e (2026-09-20; bar hide on API 34: run 35540006687, sheet recede on API 35:
    // run 35540006663), with headroom for the recipe's noise (HWUI's histogram is 50 ms wide up
    // there and a scene has 4 to 14 frames, so a run moves a scene's 95th by a bucket or two).
    // Read on that run, per kind: gesture p95 500 / 700 ms (scroll, top / bottom dock), spring
    // 650 / 700 ms (the snap home), open 700 / 900 ms (the menu sheet closing / opening); the
    // janky share 100 percent in every scene.
    //
    // THE SHARE IS 100 PERCENT BY CONSTRUCTION on this recipe: ANGLE over SwiftShader needs
    // 100 ms and more to composite a 720x1600 frame, so every frame misses HWUI's 16.7 ms
    // deadline and the share cannot fall below 1.0 here whatever the chrome does. On the shared
    // recipe the 95TH PERCENTILE is the number that moves (a fix that paints less or drops a
    // blur shows there and in the `commands` / `swap` means); the share's half of the budget
    // bites on a hardware recipe or a phone. The main-thread stages (input, animation, layout,
    // draw: 0 to 6 ms mean on the baseline) are in every record for the eye, not in the budget.
    //
    // PERF-1 and PERF-2 hand over the FIXED baselines: replace the three [Budget]s with the fixed
    // scene's janky share plus 10 points (capped at 1.0) and its 95th percentile plus 25 percent,
    // so a chrome that regresses to the unfixed numbers fails; set `provisional = false`; flip the
    // gate to hard (`JANK_GATE=hard`).

    /** A finger-driven scene (the bar-hide scroll under the finger): baseline p95 500 to 700 ms. */
    val GESTURE_BUDGET = Budget(jankyShare = 1.0, p95Ms = 1_000, provisional = true)

    /** A release settling (the bar's snap home after the finger lifts): baseline p95 650 to 700 ms. */
    val SPRING_BUDGET = Budget(jankyShare = 1.0, p95Ms = 1_000, provisional = true)

    /** A surface coming or going (the menu sheet's open and close): baseline p95 700 to 900 ms. */
    val OPEN_BUDGET = Budget(jankyShare = 1.0, p95Ms = 1_300, provisional = true)

    /** The budget of a kind. */
    fun budgetFor(kind: Kind): Budget = when (kind) {
        Kind.GESTURE -> GESTURE_BUDGET
        Kind.SPRING -> SPRING_BUDGET
        Kind.OPEN -> OPEN_BUDGET
    }

    /**
     * The gate's word on one scene: `within` when every number is inside its budget, else the
     * breaches by name. A scene that could not be measured (no frames in the dump) is a breach of
     * its own: a gate that lets an unmeasured scene through is no gate.
     */
    data class Verdict(val within: Boolean, val breaches: List<String>) {
        /** `within`, or the breaches joined. */
        fun describe(): String = if (within) "within" else "over: " + breaches.joinToString("; ")
    }

    /**
     * Hold a scene's janky share (0 to 1) and 95th percentile (ms) against `budget`. `frames` is
     * the number of frames the scene rendered: none means the scene was not measured.
     */
    fun evaluate(budget: Budget, frames: Int, jankyShare: Double, p95Ms: Int): Verdict {
        if (frames <= 0) return Verdict(within = false, breaches = listOf("no frames were recorded for the scene"))
        val breaches = ArrayList<String>()
        if (jankyShare > budget.jankyShare + EPSILON) {
            breaches += "janky ${(jankyShare * 100).toInt()}% > ${(budget.jankyShare * 100).toInt()}%"
        }
        if (p95Ms > budget.p95Ms) breaches += "p95 $p95Ms ms > ${budget.p95Ms} ms"
        return Verdict(within = breaches.isEmpty(), breaches = breaches)
    }

    /** Whether the gate makes a breach a fault: only a hard gate does. */
    fun enforces(gate: Gate, verdict: Verdict): Boolean = gate == Gate.HARD && !verdict.within

    /** A share read as `janky / frames` is a ratio of integers: no rounding of it may count as a breach. */
    private const val EPSILON = 1e-9
}
