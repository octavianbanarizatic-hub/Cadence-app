package dev.cadence.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import app.tauri.PermissionState
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLException
import com.yausername.youtubedl_android.YoutubeDLRequest
import org.json.JSONObject
import java.util.concurrent.Executors

@InvokeArg
class YtdlpArgs {
    lateinit var args: Array<String>
    /** Cadence's worker script (YtdlpWorker), when it should be used. */
    var worker: String? = null
}

/** A file path: the APK to install, where to save a picked cover, or a picture to share. */
@InvokeArg
class InstallArgs {
    lateinit var path: String
}

@InvokeArg
class PickArgs {
    var folder: Boolean = false
}

@InvokeArg
class ShareArgs {
    lateinit var text: String
}

@InvokeArg
class CopyArgs {
    lateinit var uri: String
    lateinit var path: String
}

@InvokeArg
class BackupArgs {
    lateinit var path: String
    lateinit var name: String
    /** Automatic backups kept; 0 for one made by hand, which is never deleted. */
    var keep: Int = 0
}

@InvokeArg
class WatchArgs {
    lateinit var json: String
    var on: Boolean = false
}

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class CadencePlugin(private val activity: Activity) : Plugin(activity) {
    // yt-dlp runs take seconds; commands arrive on the main thread.
    private val worker = Executors.newCachedThreadPool()

    @Volatile
    private var initialized = false

    private var webView: WebView? = null

    /** A link that opened the app or was shared to it, until the page takes it. */
    @Volatile
    private var link: String? = null

    // The page can't go by document.hidden (PageHost may say the app is shown),
    // so it hears about the app going away and coming back from here.
    override fun onPause(activity: AppCompatActivity) {
        PageHost.current?.onAppPaused()
    }

    override fun onStop(activity: AppCompatActivity) {
        tellPage("window.__cadenceAway && window.__cadenceAway(true)")
    }

    override fun onResume(activity: AppCompatActivity) {
        PageHost.current?.onAppResumed()
        tellPage("window.__cadenceAway && window.__cadenceAway(false)")
        Outputs.check()
    }

    // A link tapped, or shared to Cadence, while the app runs (it is singleTask).
    override fun onNewIntent(intent: Intent) {
        if (keepLink(intent)) tellPage("window.__cadenceLink && window.__cadenceLink()")
    }

    private fun keepLink(intent: Intent?): Boolean {
        // Reopened from recent apps, the app gets the old link again.
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return false
        // Opened: a Cadence (or YouTube) link. Shared from another app's share
        // sheet: text with a YouTube link in it. Rust reads either (shared_link).
        val url = when (intent.action) {
            Intent.ACTION_VIEW -> intent.dataString
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
            else -> null
        } ?: return false
        synchronized(this) { link = url }
        return true
    }

    private fun tellPage(js: String) {
        webView?.let { it.post { it.evaluateJavascript(js, null) } }
    }

    override fun load(webView: WebView) {
        super.load(webView)
        this.webView = webView
        keepLink(activity.intent)
        // Lock screen and notification buttons start playback without a tap
        // in the page, and so does moving on to the next song in the background.
        webView.settings.mediaPlaybackRequiresUserGesture = false
        // Android's font size setting would scale every text in the page and
        // break the layout (wrapped titles, overflowing labels) on phones set
        // to larger text. Cadence's text is already large; keep it as designed.
        webView.settings.textZoom = 100
        Playback.onCommand = { command, arg ->
            webView.post {
                webView.evaluateJavascript("window.__cadenceMedia && window.__cadenceMedia(${JSONObject.quote(command)}, ${arg ?: "null"})", null)
            }
        }
        Playback.onRequest = { command, arg ->
            webView.post {
                webView.evaluateJavascript("window.__cadenceMedia && window.__cadenceMedia(${JSONObject.quote(command)}, ${JSONObject.quote(arg)})", null)
            }
        }
        SystemBars.onChange = { bottom ->
            webView.post {
                webView.evaluateJavascript("window.__cadenceInsets && window.__cadenceInsets($bottom)", null)
            }
        }
        Outputs.onChange = { json -> tellPage("window.__cadenceOutput && window.__cadenceOutput($json)") }
        Outputs.watch(activity.applicationContext)
        val owner = activity as? ComponentActivity ?: return
        owner.onBackPressedDispatcher.addCallback(owner, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // The page closes whatever is on top (main.ts: back). With nothing
                // left, go to the background like Home does, so music keeps playing.
                webView.evaluateJavascript("window.__cadenceBack ? window.__cadenceBack() : false") { handled ->
                    if (handled != "true") owner.moveTaskToBack(true)
                }
            }
        })
    }

    /** Unpacks Python and yt-dlp on first use (a few seconds, once per install). */
    @Synchronized
    private fun ensureInit() {
        if (initialized) return
        YoutubeDL.getInstance().init(activity.applicationContext)
        initialized = true
    }

    private fun background(invoke: Invoke, work: () -> JSObject) {
        worker.execute {
            try {
                invoke.resolve(work())
            } catch (e: Throwable) {
                // Errors too (a broken bundled Python fails in a static
                // initializer): report them to the page instead of crashing.
                invoke.reject(e.message ?: e.toString())
            }
        }
    }

    @Command
    fun ytdlp(invoke: Invoke) {
        val parsed = invoke.parseArgs(YtdlpArgs::class.java)
        val args = parsed.args.toList()
        background(invoke) {
            ensureInit()
            parsed.worker?.let { YtdlpWorker.run(activity.applicationContext, it, args) }?.let { return@background it }
            // No URLs here: the arguments already end with the one to read.
            val request = YoutubeDLRequest(emptyList<String>()).addCommands(args)
            val result = JSObject()
            try {
                val response = YoutubeDL.getInstance().execute(request)
                result.put("exitCode", response.exitCode)
                result.put("out", response.out)
                result.put("err", response.err)
            } catch (e: YoutubeDLException) {
                // Thrown for a non-zero exit; its message is yt-dlp's error output.
                result.put("exitCode", 1)
                result.put("out", "")
                result.put("err", e.message ?: "yt-dlp failed")
            }
            result
        }
    }

    /** The song and play state for the lock screen and notification controls. */
    @Command
    fun mediaUpdate(invoke: Invoke) {
        val args = invoke.parseArgs(MediaArgs::class.java)
        activity.runOnUiThread {
            Playback.update(activity, args)
            invoke.resolve()
        }
    }

    /**
     * Opens Android's installer for a downloaded app update. The first time,
     * Android wants Cadence allowed to install apps: that settings screen
     * opens instead, and `opened` is false.
     */
    @Command
    fun installApk(invoke: Invoke) {
        val path = invoke.parseArgs(InstallArgs::class.java).path
        activity.runOnUiThread {
            try {
                val allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()
                if (!allowed) {
                    activity.startActivity(
                        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
                    )
                } else {
                    // The app's own file provider shares its cache folder, where updates land.
                    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", java.io.File(path))
                    activity.startActivity(
                        Intent(Intent.ACTION_VIEW)
                            .setDataAndType(uri, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
                    )
                }
                invoke.resolve(JSObject().put("opened", allowed))
            } catch (e: Throwable) {
                invoke.reject(e.message ?: e.toString())
            }
        }
    }

    /** Opens Android's share sheet with `text`. */
    @Command
    fun share(invoke: Invoke) {
        val text = invoke.parseArgs(ShareArgs::class.java).text
        activity.runOnUiThread {
            try {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                activity.startActivity(Intent.createChooser(send, null))
                invoke.resolve()
            } catch (e: Throwable) {
                invoke.reject(e.message ?: e.toString())
            }
        }
    }

    /** Opens Android's share sheet with a picture from the cache folder (a lyrics card). */
    @Command
    fun shareImage(invoke: Invoke) {
        val path = invoke.parseArgs(InstallArgs::class.java).path
        activity.runOnUiThread {
            try {
                val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", java.io.File(path))
                val send = Intent(Intent.ACTION_SEND)
                    .setType("image/jpeg")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                // Lets the share sheet show the picture.
                send.clipData = android.content.ClipData.newRawUri(null, uri)
                activity.startActivity(Intent.createChooser(send, null))
                invoke.resolve()
            } catch (e: Throwable) {
                invoke.reject(e.message ?: e.toString())
            }
        }
    }

    /** The link that opened the app, if the page hasn't taken it yet. */
    @Command
    fun takeLink(invoke: Invoke) {
        val url = synchronized(this) { link.also { link = null } }
        invoke.resolve(JSObject().put("url", url))
    }

    /** Whether the connection is Wi-Fi or another one that isn't metered. */
    @Command
    fun network(invoke: Invoke) {
        val manager = activity.getSystemService(ConnectivityManager::class.java)
        val caps = manager?.getNetworkCapabilities(manager.activeNetwork)
        val unmetered = caps != null &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        invoke.resolve(JSObject().put("unmetered", unmetered))
    }

    /** Where the music plays, for the page's first look (Outputs). */
    @Command
    fun audioOutput(invoke: Invoke) {
        invoke.resolve(JSObject(Outputs.describe(activity)))
    }

    /** Opens Android's panel for picking where the music plays (Outputs). */
    @Command
    fun pickAudioOutput(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                Outputs.pick(activity)
                invoke.resolve()
            } catch (e: Throwable) {
                invoke.reject(e.message ?: e.toString())
            }
        }
    }

    /** The navigation bar's height, for the page's first layout (SystemBars). */
    @Command
    fun systemBars(invoke: Invoke) {
        invoke.resolve(JSObject().put("bottom", SystemBars.bottom.toDouble()))
    }

    /**
     * Opens Android's file picker for music files, or for a folder of them.
     * Resolves with each picked file (uri, name, size); none when cancelled.
     */
    @Command
    fun pickMusic(invoke: Invoke) {
        val folder = invoke.parseArgs(PickArgs::class.java).folder
        val intent = if (folder) {
            Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        } else {
            Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("audio/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        startActivityForResult(invoke, intent, if (folder) "folderPicked" else "filesPicked")
    }

    @ActivityCallback
    private fun filesPicked(invoke: Invoke, result: ActivityResult) {
        val data = result.data
        val uris = mutableListOf<Uri>()
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            // Several files come as clip data, a single one as the data.
            val clip = data.clipData
            if (clip != null) for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
            else data.data?.let { uris.add(it) }
        }
        background(invoke) { JSObject().put("files", MusicFiles.describe(activity.contentResolver, uris)) }
    }

    @ActivityCallback
    private fun folderPicked(invoke: Invoke, result: ActivityResult) {
        val tree = result.data?.data
        background(invoke) {
            val files = if (result.resultCode == Activity.RESULT_OK && tree != null) MusicFiles.walk(activity.contentResolver, tree) else JSArray()
            JSObject().put("files", files)
        }
    }

    /** Opens the photo picker; the photo picked becomes a square JPEG at `path` (Pictures). */
    @Command
    fun pickCover(invoke: Invoke) {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Intent(MediaStore.ACTION_PICK_IMAGES)
        } else {
            Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*")
        }
        startActivityForResult(invoke, intent, "coverPicked")
    }

    @ActivityCallback
    private fun coverPicked(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data.takeIf { result.resultCode == Activity.RESULT_OK }
        val path = invoke.parseArgs(InstallArgs::class.java).path
        background(invoke) {
            if (uri != null) Pictures.saveCover(activity.contentResolver, uri, path)
            JSObject().put("saved", uri != null)
        }
    }

    /** Saves the backup file at `path` in Downloads → Cadence backups (Backups). */
    @Command
    fun saveBackup(invoke: Invoke) {
        val args = invoke.parseArgs(BackupArgs::class.java)
        background(invoke) { JSObject().put("place", Backups.save(activity, args.path, args.name, args.keep)) }
    }

    /** Opens Android's file picker for a backup and copies the one picked to `path`. */
    @Command
    fun pickBackup(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        startActivityForResult(invoke, intent, "backupPicked")
    }

    @ActivityCallback
    private fun backupPicked(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data.takeIf { result.resultCode == Activity.RESULT_OK }
        val path = invoke.parseArgs(InstallArgs::class.java).path
        background(invoke) {
            if (uri != null) MusicFiles.copy(activity.contentResolver, uri.toString(), path)
            JSObject().put("saved", uri != null)
        }
    }

    /** Who to watch for new releases, and whether to (Releases). */
    @Command
    fun watchReleases(invoke: Invoke) {
        val args = invoke.parseArgs(WatchArgs::class.java)
        Releases.watch(activity.applicationContext, args.json, args.on)
        invoke.resolve()
    }

    /** Whether Cadence may show notifications; Android 13 and newer ask the first time. */
    @Command
    fun allowNotifications(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", invoke, "notificationsAnswered")
        } else {
            notificationsAnswered(invoke)
        }
    }

    @PermissionCallback
    private fun notificationsAnswered(invoke: Invoke) {
        invoke.resolve(JSObject().put("allowed", NotificationManagerCompat.from(activity).areNotificationsEnabled()))
    }

    /** Copies one picked file to `path`, in Cadence's own storage. */
    @Command
    fun copyMusic(invoke: Invoke) {
        val args = invoke.parseArgs(CopyArgs::class.java)
        background(invoke) {
            MusicFiles.copy(activity.contentResolver, args.uri, args.path)
            JSObject()
        }
    }

    @Command
    fun ytdlpVersion(invoke: Invoke) {
        background(invoke) {
            ensureInit()
            JSObject().put("version", version())
        }
    }

    /** The library only remembers versions it downloaded; ask the bundled copy otherwise. */
    private fun version(): String? {
        YoutubeDL.getInstance().version(activity.applicationContext)?.let { return it }
        return try {
            val request = YoutubeDLRequest(emptyList<String>()).addCommands(listOf("--version"))
            YoutubeDL.getInstance().execute(request).out.trim().ifEmpty { null }
        } catch (e: YoutubeDLException) {
            null
        }
    }

    @Command
    fun ytdlpUpdate(invoke: Invoke) {
        background(invoke) {
            ensureInit()
            val context = activity.applicationContext
            // The worker has the old copy loaded; the next run starts it anew.
            YtdlpWorker.stop()
            val status = YoutubeDL.getInstance().updateYoutubeDL(context)
            JSObject()
                .put("updated", status == YoutubeDL.UpdateStatus.DONE)
                .put("version", version())
        }
    }
}
