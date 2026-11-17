package dev.cadence.android

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import java.io.File

/** Photos the user picks as playlist covers. */
object Pictures {
    /** Covers are shown at most this many pixels wide. */
    private const val SIZE = 640

    /** Saves the picked photo as a square JPEG at `path`, cut from its middle. */
    fun saveCover(resolver: ContentResolver, uri: Uri, path: String) {
        val photo = decode(resolver, uri) ?: throw IllegalArgumentException("That photo can't be read.")
        val side = minOf(photo.width, photo.height)
        val square = Bitmap.createBitmap(photo, (photo.width - side) / 2, (photo.height - side) / 2, side, side)
        val cover = if (side > SIZE) Bitmap.createScaledBitmap(square, SIZE, SIZE, true) else square
        val file = File(path)
        file.parentFile?.mkdirs()
        file.outputStream().use { cover.compress(Bitmap.CompressFormat.JPEG, 88, it) }
    }

    /** Decodes a photo about twice the cover's size, upright. */
    private fun decode(resolver: ContentResolver, uri: Uri): Bitmap? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // ImageDecoder turns camera photos the right way up by itself.
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
                val shrink = maxOf(1, minOf(info.size.width, info.size.height) / (SIZE * 2))
                decoder.setTargetSize(info.size.width / shrink, info.size.height / shrink)
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        var sample = 1
        while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= SIZE * 2) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        return resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
    }
}
