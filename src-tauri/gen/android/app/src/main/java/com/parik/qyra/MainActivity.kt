package com.parik.qyra

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import androidx.activity.enableEdgeToEdge
import java.io.File
import java.io.FileOutputStream

class MainActivity : TauriActivity() {

  private val tag = "QyraIntent"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    handleIncomingIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleIncomingIntent(intent)
  }

  /**
   * Extract the PDF Uri from ACTION_VIEW / ACTION_EDIT / ACTION_SEND, copy bytes
   * into the app's local-data dir under imports/, and drop a marker file that the
   * Rust side polls for on startup and on resume. Rust then emits "open-pdf" to
   * the React layer which already knows how to open it.
   */
  private fun handleIncomingIntent(intent: Intent?) {
    if (intent == null) return
    val uri: Uri? = when (intent.action) {
      Intent.ACTION_VIEW, Intent.ACTION_EDIT -> intent.data
      Intent.ACTION_SEND -> @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
      else -> null
    } ?: return

    try {
      val name = queryDisplayName(uri!!) ?: "document.pdf"
      val safeName = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(120)
      val importsDir = File(filesDir, "imports").apply { mkdirs() }
      val dst = File(importsDir, "${System.currentTimeMillis()}_$safeName")

      contentResolver.openInputStream(uri).use { input ->
        if (input == null) {
          Log.w(tag, "openInputStream returned null for $uri")
          return
        }
        FileOutputStream(dst).use { out -> input.copyTo(out) }
      }

      // Marker file the Rust side reads + deletes. One absolute path per line.
      val marker = File(filesDir, ".pending_open.txt")
      marker.writeText(dst.absolutePath)
      Log.i(tag, "Staged incoming PDF at ${dst.absolutePath}")
    } catch (e: Exception) {
      Log.e(tag, "Failed to stage incoming intent: ${e.message}", e)
    }
  }

  private fun queryDisplayName(uri: Uri): String? {
    if (uri.scheme == "file") return File(uri.path ?: return null).name
    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) {
        val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (idx >= 0) return c.getString(idx)
      }
    }
    return uri.lastPathSegment
  }
}
