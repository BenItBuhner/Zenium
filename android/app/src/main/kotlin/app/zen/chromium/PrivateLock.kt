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
 * before the chrome's next report ([Host.onStop]). The regular tabs, Settings and the bar are
 * not locked: only what is private is behind the cover.
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
     * Answers whether the lock went on now.
     */
    fun onLeave(screenLock: Boolean): Boolean {
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
}
