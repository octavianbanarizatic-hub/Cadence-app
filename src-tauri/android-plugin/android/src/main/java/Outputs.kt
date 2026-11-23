package dev.cadence.android

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaRouter2
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import org.json.JSONObject

/**
 * Where the music plays: this phone's speaker, headphones, a Bluetooth speaker
 * or car, a USB DAC, a TV. The page shows its name under the song, like
 * Spotify, and opens Android's own panel to pick another one: apps can't
 * connect Bluetooth devices themselves. Everything here runs on the main thread.
 */
object Outputs {
    /** Tells the page when the output changes ([describe]'s JSON). */
    var onChange: ((String) -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())
    private var context: Context? = null
    private var last: String? = null

    fun watch(context: Context) {
        if (this.context != null) return
        this.context = context
        val audio = context.getSystemService(AudioManager::class.java) ?: return
        audio.registerAudioDeviceCallback(object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = check()
            override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = check()
        }, main)
    }

    /**
     * Looks again, now and a moment later: Android moves the music over a
     * little after a device connects or is picked in its panel.
     */
    fun check() {
        main.removeCallbacks(again)
        tell()
        main.postDelayed(again, 1500)
    }

    private val again = Runnable { tell() }

    private fun tell() {
        val context = context ?: return
        val now = describe(context)
        if (now == last) return
        last = now
        onChange?.invoke(now)
    }

    /** `{"kind": "phone" | "bluetooth" | "headphones" | "speaker", "name": "..."}`; no name when Android has none worth showing. */
    fun describe(context: Context): String {
        val device = current(context)
        val kind = kind(device)
        val result = JSONObject().put("kind", kind)
        // Headphones in the jack, and the phone itself, carry the phone's model name.
        val name = device?.productName?.toString()?.trim()
        if (kind != "phone" && kind != "headphones" && !name.isNullOrEmpty() && name != Build.MODEL) result.put("name", name)
        return result.toString()
    }

    private fun current(context: Context): AudioDeviceInfo? {
        val audio = context.getSystemService(AudioManager::class.java) ?: return null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val media = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build()
            audio.getAudioDevicesForAttributes(media).firstOrNull()?.let { return it }
        }
        // Older Android doesn't say; music goes to the first of these that is connected.
        return audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            .filter { rank(it.type) < Int.MAX_VALUE }
            .minByOrNull { rank(it.type) }
    }

    private fun rank(type: Int) = when (kind(type)) {
        "headphones" -> 0
        "bluetooth" -> 1
        "speaker" -> 2
        "phone" -> 3
        else -> Int.MAX_VALUE
    }

    // Android 13 and newer name the output itself: one of no kind here (a
    // car's own system, casting) is still somewhere else than the phone.
    private fun kind(device: AudioDeviceInfo?) = if (device == null) "phone" else kind(device.type) ?: "speaker"

    /** Null for calls' outputs (the earpiece, a headset's call channel) and the like. */
    private fun kind(type: Int): String? = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE -> "phone"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_HEARING_AID,
        AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_BLE_BROADCAST -> "bluetooth"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> "headphones"
        AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY, AudioDeviceInfo.TYPE_DOCK,
        AudioDeviceInfo.TYPE_DOCK_ANALOG, AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_HDMI_ARC,
        AudioDeviceInfo.TYPE_HDMI_EARC, AudioDeviceInfo.TYPE_LINE_ANALOG, AudioDeviceInfo.TYPE_LINE_DIGITAL,
        AudioDeviceInfo.TYPE_AUX_LINE -> "speaker"
        else -> null
    }

    /**
     * Opens Android's panel for where media plays. Each Android version has
     * its own way in; with none (Android 10 and older, or a phone that
     * removed it), Bluetooth settings open instead.
     */
    fun pick(activity: Activity) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            MediaRouter2.getInstance(activity).showSystemOutputSwitcher()
        ) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val panel = Intent("com.android.systemui.action.LAUNCH_MEDIA_OUTPUT_DIALOG")
                .setPackage("com.android.systemui")
                .putExtra("package_name", activity.packageName)
            if (activity.packageManager.queryBroadcastReceivers(panel, 0).isNotEmpty()) {
                activity.sendBroadcast(panel)
                return
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val panel = Intent("com.android.settings.panel.action.MEDIA_OUTPUT")
                .putExtra("com.android.settings.panel.extra.PACKAGE_NAME", activity.packageName)
            if (panel.resolveActivity(activity.packageManager) != null) {
                activity.startActivity(panel)
                return
            }
        }
        activity.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
    }
}
