package info.arenoros.aquarium

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.lang.ref.WeakReference
import java.net.URI
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection
import kotlin.concurrent.thread

// Состояние установки живёт в процессе, чтобы смена Activity не запустила вторую загрузку.
internal object AppUpdate {
    private const val TAG = "aqua-update"
    private const val CHECK_INTERVAL = 6 * 60 * 60 * 1000L
    private const val RETRY_INTERVAL = 15 * 60 * 1000L
    private val handler = Handler(Looper.getMainLooper())
    private val check = Runnable { checkForUpdate() }
    private var foreground: WeakReference<Activity>? = null
    private val activity: Activity? get() = foreground?.get()
    private var nextCheckAt = 0L
    private var checking = false
    private var waitingForPermission = false
    private var sessionId: Int? = null
    private var confirmation: Intent? = null

    fun resume(activity: Activity) {
        if (!activity.resources.getBoolean(R.bool.auto_update)) return
        foreground = WeakReference(activity)
        if (waitingForPermission && canInstall(activity)) {
            waitingForPermission = false
            nextCheckAt = 0L
        }
        showConfirmation()
        scheduleCheck()
    }

    fun pause(activity: Activity) {
        if (this.activity !== activity) return
        foreground = null
        handler.removeCallbacks(check)
    }

    private fun scheduleCheck() {
        handler.removeCallbacks(check)
        if (activity == null || checking || sessionId != null) return
        handler.postDelayed(check, (nextCheckAt - SystemClock.elapsedRealtime()).coerceAtLeast(0L))
    }

    private fun checkForUpdate() {
        val context = activity?.applicationContext ?: return
        checking = true
        thread(name = TAG) {
            var preparedSession: Int? = null
            var permissionVersion: String? = null
            var interval = CHECK_INTERVAL
            try {
                val current = context.packageManager.getPackageInfo(context.packageName, 0).code()
                val update = readHttps("https://api.github.com/repos/$UPDATE_REPO/releases/latest") { input ->
                    parseRelease(JSONObject(input.bufferedReader().readText()), current)
                }
                if (update != null) {
                    if (canInstall(context)) preparedSession = prepareSession(context, update)
                    else permissionVersion = update.version
                }
            } catch (e: Exception) {
                Log.w(TAG, "Could not prepare an update", e)
                interval = RETRY_INTERVAL
            }
            handler.post {
                checking = false
                nextCheckAt = SystemClock.elapsedRealtime() + interval
                if (permissionVersion != null) {
                    waitingForPermission = true
                    val current = activity
                    if (current != null) askForPermission(current, permissionVersion) else nextCheckAt = 0L
                }
                preparedSession?.let { commit(context, it) }
                scheduleCheck()
            }
        }
    }

    private fun <T> readHttps(url: String, read: (InputStream) -> T): T {
        val connection = URI(url).toURL().openConnection() as HttpsURLConnection
        try {
            connection.connectTimeout = 10_000
            connection.readTimeout = 20_000
            check(connection.responseCode == HttpsURLConnection.HTTP_OK) { "HTTP ${connection.responseCode}" }
            return connection.inputStream.use(read)
        } finally {
            connection.disconnect()
        }
    }

    @Suppress("DEPRECATION")
    private fun PackageInfo.code(): Long =
        if (Build.VERSION.SDK_INT >= 28) longVersionCode else versionCode.toLong()

    private fun canInstall(context: Context): Boolean =
        Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    private fun askForPermission(activity: Activity, version: String) {
        if (Build.VERSION.SDK_INT < 26) return
        val prefs = activity.getSharedPreferences("updates", Context.MODE_PRIVATE)
        if (prefs.getString("permission_prompt_version", null) == version) return
        AlertDialog.Builder(activity)
            .setTitle(R.string.update_title)
            .setMessage(activity.getString(R.string.update_permission, version))
            .setNegativeButton(R.string.update_later, null)
            .setPositiveButton(R.string.update_settings) { _, _ ->
                val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.fromParts("package", activity.packageName, null))
                val opened = runCatching { activity.startActivity(settings) }.isSuccess ||
                    runCatching { activity.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS)) }.isSuccess
                if (!opened) {
                    Toast.makeText(activity, R.string.update_settings_unavailable, Toast.LENGTH_LONG).show()
                }
            }
            .show()
        prefs.edit().putString("permission_prompt_version", version).apply()
    }

    private fun download(update: UpdateRelease, apk: File) {
        val digest = MessageDigest.getInstance("SHA-256")
        var size = 0L
        readHttps(update.url) { input ->
            apk.outputStream().buffered().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count == -1) break
                    size += count
                    check(size <= update.size) { "APK exceeds the release asset size" }
                    digest.update(buffer, 0, count)
                    output.write(buffer, 0, count)
                }
            }
        }
        val hash = digest.digest().joinToString("") { "%02x".format(it) }
        check(size == update.size && "sha256:$hash" == update.digest) { "Release asset verification failed" }
    }

    private fun prepareSession(context: Context, update: UpdateRelease): Int {
        val apk = File(context.cacheDir, "update.apk")
        try {
            download(update, apk)
            val packages = context.packageManager
            val archive = packages.getPackageArchiveInfo(apk.absolutePath, 0)
            val installed = packages.getPackageInfo(context.packageName, 0)
            check(archive != null && archive.packageName == installed.packageName &&
                archive.code() == update.code && archive.code() > installed.code()) { "Unexpected APK package or version" }

            val installer = packages.packageInstaller
            // Сессия могла остаться, если процесс завершился во время предыдущего обновления.
            installer.mySessions.filter { it.appPackageName == context.packageName }.forEach { abandon(installer, it.sessionId) }
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(context.packageName)
                setSize(update.size)
                if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
            val id = installer.createSession(params)
            try {
                installer.openSession(id).use { session ->
                    session.openWrite("base.apk", 0, update.size).use { output ->
                        apk.inputStream().use { it.copyTo(output) }
                        session.fsync(output)
                    }
                }
                return id
            } catch (e: Exception) {
                abandon(installer, id)
                throw e
            }
        } finally {
            apk.delete()
        }
    }

    private fun commit(context: Context, id: Int) {
        val installer = context.packageManager.packageInstaller
        if (activity == null || !canInstall(context)) {
            abandon(installer, id)
            nextCheckAt = 0L
            return
        }
        try {
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val result = PendingIntent.getBroadcast(context, id, Intent(context, UpdateResultReceiver::class.java), flags)
            sessionId = id
            // Android проверит, что APK подписан тем же ключом, что и установленное приложение.
            installer.openSession(id).use { it.commit(result.intentSender) }
        } catch (e: Exception) {
            sessionId = null
            abandon(installer, id)
            installFailed("Could not commit the update", e)
        }
    }

    @Suppress("DEPRECATION")
    fun onInstallResult(context: Context, result: Intent) {
        val id = result.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        if (id != sessionId) return
        val status = result.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                confirmation = if (Build.VERSION.SDK_INT >= 33) result.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    else result.getParcelableExtra(Intent.EXTRA_INTENT)
                if (confirmation != null) showConfirmation()
                else discardSession(context, id)
            }
            else -> {
                sessionId = null
                confirmation = null
                if (status != PackageInstaller.STATUS_SUCCESS && status != PackageInstaller.STATUS_FAILURE_ABORTED) {
                    installFailed("Install failed ($status): ${result.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
                }
                scheduleCheck()
            }
        }
    }

    private fun showConfirmation() {
        val current = activity ?: return
        val prompt = confirmation ?: return
        val id = sessionId ?: return
        confirmation = null
        try {
            current.startActivity(prompt)
        } catch (e: Exception) {
            discardSession(current, id, e)
        }
    }

    private fun discardSession(context: Context, id: Int, error: Exception? = null) {
        sessionId = null
        abandon(context.packageManager.packageInstaller, id)
        installFailed("Could not open the installer confirmation", error)
        scheduleCheck()
    }

    private fun abandon(installer: PackageInstaller, id: Int) {
        runCatching { installer.abandonSession(id) }.onFailure { Log.w(TAG, "Could not abandon session $id", it) }
    }

    private fun installFailed(message: String, error: Exception? = null) {
        Log.w(TAG, message, error)
        activity?.let { Toast.makeText(it, R.string.update_failed, Toast.LENGTH_LONG).show() }
    }
}

class UpdateResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = AppUpdate.onInstallResult(context, intent)
}
