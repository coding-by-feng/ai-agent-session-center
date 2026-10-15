// DeviceVaultPlugin.kt — the phone's secrets: Mac device tokens and backend tokens (AASC-17).
//
// Values are AES-256-GCM encrypted with a key that lives in the Android Keystore and can't be
// exported; the entry's name is the GCM associated data, so one entry can't be swapped for
// another. The ciphertext sits in app-private SharedPreferences, which never leave the phone
// (allowBackup=false, backup and data-extraction rules exclude everything), and the Keystore
// key isn't backed up either, so a restored copy couldn't be read anyway.
// Not EncryptedSharedPreferences: androidx.security-crypto is deprecated, and these few lines
// are the same Keystore AES-GCM it wraps, with no extra dependency.
//
// Serves the bundled shell page only (ShellOnly.kt): the Mac UI loaded later can't read it.
package work.aasc.mobile

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@CapacitorPlugin(name = "DeviceVault")
class DeviceVaultPlugin : Plugin() {
    private val vault by lazy { KeystoreVault(context) }

    @PluginMethod
    fun get(call: PluginCall) = fromShellOnly(call) {
        val key = call.getString("key")
        if (!ShellRules.isVaultKey(key)) {
            call.reject("Bad vault key", "BAD_KEY")
            return@fromShellOnly
        }
        call.resolve(JSObject().put("value", vault.read(key!!)))
    }

    @PluginMethod
    fun set(call: PluginCall) = fromShellOnly(call) {
        val key = call.getString("key")
        val value = call.getString("value")
        if (!ShellRules.isVaultKey(key) || value == null || value.length > ShellRules.VAULT_VALUE_MAX) {
            call.reject("Bad vault entry", "BAD_KEY")
            return@fromShellOnly
        }
        vault.write(key!!, value)
        call.resolve()
    }

    @PluginMethod
    fun remove(call: PluginCall) = fromShellOnly(call) {
        val key = call.getString("key")
        if (!ShellRules.isVaultKey(key)) {
            call.reject("Bad vault key", "BAD_KEY")
            return@fromShellOnly
        }
        vault.remove(key!!)
        call.resolve()
    }
}

internal class KeystoreVault(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    fun write(name: String, value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
        val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        // commit(): the shell is told "stored" only once it is on disk.
        if (!prefs.edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()) {
            throw IllegalStateException("vault write failed")
        }
    }

    /** Null when absent, or when it can't be opened (a reset Keystore key): such an entry is dropped. */
    fun read(name: String): String? {
        val stored = prefs.getString(name, null) ?: return null
        return try {
            val sealed = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
            cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
            String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8)
        } catch (e: Exception) {
            remove(name)
            null
        }
    }

    fun remove(name: String) {
        prefs.edit().remove(name).commit()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "work.aasc.mobile.vault"
        const val PREFS = "aasc_vault"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
