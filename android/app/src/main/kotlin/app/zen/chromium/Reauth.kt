package app.zen.chromium

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * The system "confirm it's you" sheet (`androidx.biometric`): fingerprint or face where enrolled,
 * else the device PIN, pattern or password. Used before a saved password is shown, copied or
 * exported (`reauth.verify`), and to satisfy the authentication-bound vault key (`VaultKeystore`).
 */
class Reauth(private val activity: FragmentActivity) {
    private val executor = ContextCompat.getMainExecutor(activity)

    /** Something on this device can verify the user right now. */
    fun available(): Boolean = canAuthenticate(WEAK_OR_CREDENTIAL)

    private fun canAuthenticate(authenticators: Int): Boolean =
        BiometricManager.from(activity).canAuthenticate(authenticators) == BiometricManager.BIOMETRIC_SUCCESS

    /**
     * Show the prompt (main thread). `strong` limits it to what satisfies an authentication-bound
     * Keystore key: Class 3 biometrics and the device credential. The callback runs exactly once.
     */
    fun authenticate(reason: String, strong: Boolean, callback: (Boolean) -> Unit) {
        val authenticators = if (strong) STRONG_OR_CREDENTIAL else WEAK_OR_CREDENTIAL
        if (!canAuthenticate(authenticators)) {
            callback(false)
            return
        }
        var answered = false
        val once = { ok: Boolean ->
            if (!answered) {
                answered = true
                callback(ok)
            }
        }
        val prompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = once(true)
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = once(false)
            // onAuthenticationFailed: one attempt did not match; the sheet stays up for another.
        })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Zenium")
            .setSubtitle(reason)
            .setAllowedAuthenticators(authenticators)
            .setConfirmationRequired(false)
            .build()
        runCatching { prompt.authenticate(info) }.onFailure { once(false) }
    }

    companion object {
        private const val WEAK_OR_CREDENTIAL = Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL
        private const val STRONG_OR_CREDENTIAL = Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL
    }
}
