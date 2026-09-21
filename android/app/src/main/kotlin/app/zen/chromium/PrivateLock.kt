package app.zen.chromium

/**
 * "Lock private tabs when you leave Zenium" (INC-05 / SET-17; Chrome's "Lock Incognito tabs
 * when you leave Chrome"): the host's half, kept free of Android types so it runs under plain
 * JUnit (`PrivateLockTest`); [Host] arms it from the activity's lifecycle.
 *
 * The switch is the chrome's (Settings › Privacy and Security, device-local in the core's
 * `state.privateDevice`) and is mirrored here (`private.setLockOnLeave`), as is the count of
 * private tabs open (`private.setOpenTabs`, the private session's card reads the same). The lock
 * itself lives here and in memory only: it goes on as the window leaves the screen ([onLeave],
 * `Activity.onStop` – Home, another app, the screen turning off; Chrome locks on return without
 * a grace period, so the moment of leaving is the moment to arm) with the switch on, private
 * tabs open and a screen lock to pass; it comes off when the user passes the device's screen
 * lock ([release], `BiometricPrompt` with `BIOMETRIC_WEAK or DEVICE_CREDENTIAL`), when the last
 * private tab closes ([setOpenTabs]: nothing is left to lock; the private session's wipe and
 * its notification behave as before), or when the switch is turned off ([setEnabled]). A device
 * that loses its screen lock while the app is away cannot verify anyone: [onReturn] lets go.
 *
 * While on, the chrome draws the lock cover over private content – a private tab in front, the
 * overview's Private pane – and reports that content hidden; the host hides the private page
 * views itself the moment the lock goes on, so the app's first frame back shows no private page
 * before the chrome's next report ([Host.onStop]), and shows none while the lock holds, whatever
 * the chrome's layout asks ([refusesShow]; a card under the cover, the media notification's tap).
 * The regular tabs, Settings and the bar are not locked: only what is private is behind the cover.
 *
 * A stop under a prompt of ours (the switch's confirmation, Unlock's) is not read as a departure
 * on its own: on Android 11 and later the system's prompt is an overlay that never stops the
 * window, so a stop then is the user leaving with the prompt open (Home, a call, the screen
 * timing out), and the system takes the prompt down as the task leaves – the answer settles it
 * ([onPromptAnswered]: not passed, the lock goes on; passed, the user was there). On Android 10
 * and under the device-credential fallback is an activity that stops the window itself, so a
 * prompt cancelled there locks too: the two cannot be told apart from here, and the promise the
 * switch makes wins.
 */
class PrivateLock {
    /** The switch, as the chrome mirrors it (off by default, as Chrome's). */
    var enabled = false
        private set

    /** Private tabs open, as the chrome counts them. */
    var openTabs = 0
        private set

    /** The private tabs are locked: their content is covered until the screen lock is passed. */
    var locked = false
        private set

    /** The window stopped while a prompt of ours was up ([onLeave]); the prompt's answer settles what it meant ([onPromptAnswered]). */
    var stoppedUnderPrompt = false
        private set

    /**
     * The private page views the host hid on the lock's account, by tab id: the ones on screen as
     * the lock went on ([hide]) and the ones a show was refused for under it ([refusesShow]). The
     * release hands them back to be shown ([takeHidden]); the core's own word on one, or its
     * destruction, drops it ([forget]). While any is held the screenshot guard stays up whatever
     * the chrome says of the surface (`PrivateBrowsing.guard`'s `lockedContent`).
     */
    private val hidden = LinkedHashSet<String>()

    /** The views held hidden under the lock ([hidden]). */
    val hiddenViews: Set<String> get() = hidden

    /** Whether any private page view is held hidden under the lock: the guard's second reason. */
    val holdsHiddenViews: Boolean get() = hidden.isNotEmpty()

    /** The chrome's switch changed. Off releases a lock that is on: nothing is locked with the switch off. Answers whether [locked] changed. */
    fun setEnabled(on: Boolean): Boolean {
        enabled = on
        return if (!on) release() else false
    }

    /** The count of private tabs changed. None left releases the lock. Answers whether [locked] changed. */
    fun setOpenTabs(count: Int): Boolean {
        openTabs = count
        return if (count <= 0) release() else false
    }

    /**
     * The window left the screen. The lock goes on with the switch on, private tabs open and a
     * screen lock on the device to pass later (`screenLock`); a device without one never locks –
     * the switch is disabled in Settings on such a device, this is the same rule at the source.
     * With `prompting` – a prompt of ours has the window – the stop is only noted, and the
     * prompt's answer decides ([onPromptAnswered]). Answers whether the lock went on now.
     */
    fun onLeave(screenLock: Boolean, prompting: Boolean = false): Boolean {
        if (prompting) {
            stoppedUnderPrompt = true
            return false
        }
        return arm(screenLock)
    }

    /**
     * A prompt of ours answered. Passed: the user was there for it, nothing was a departure (a
     * switch flipped follows by its own message). Not passed, with the window stopped while the
     * prompt was up: the user left with the prompt open, and the lock goes on now – as late as
     * the answer, still ahead of any frame back. Not passed with no stop seen: a cancel in place,
     * nothing. Answers whether the lock went on now.
     */
    fun onPromptAnswered(ok: Boolean, screenLock: Boolean): Boolean {
        val stopped = stoppedUnderPrompt
        stoppedUnderPrompt = false
        return !ok && stopped && arm(screenLock)
    }

    private fun arm(screenLock: Boolean): Boolean {
        if (locked || !enabled || openTabs <= 0 || !screenLock) return false
        locked = true
        return true
    }

    /**
     * The window is back on screen. A lock that nothing can open – the screen lock was removed
     * while the app was away – comes off, or the cover would never lift. Answers whether [locked] changed.
     */
    fun onReturn(screenLock: Boolean): Boolean = if (!screenLock) release() else false

    /** The lock comes off (the screen lock passed, or nothing left to lock). Answers whether it was on. */
    fun release(): Boolean {
        if (!locked) return false
        locked = false
        return true
    }

    /** A private page view the host hid as the lock went on: held for the release. */
    fun hide(tabId: String) {
        hidden.add(tabId)
    }

    /**
     * A show asked of a page view (`view.setVisible(true)`). A private view while the lock holds
     * is refused and held for the release – the chrome's cover is over it meanwhile; any other
     * view shows. Answers whether the show is refused.
     */
    fun refusesShow(tabId: String, private: Boolean): Boolean {
        if (!locked || !private) return false
        hidden.add(tabId)
        return true
    }

    /**
     * The host's hold on a view ends: the core showed or hid it itself (its word replaces the
     * host's), or the view is gone with its tab. Answers whether it was held – the guard's reason
     * may have gone with it.
     */
    fun forget(tabId: String): Boolean = hidden.remove(tabId)

    /** The lock came off: the views the host hid, to be shown again; none is held after. */
    fun takeHidden(): Set<String> {
        val views = hidden.toSet()
        hidden.clear()
        return views
    }
}
