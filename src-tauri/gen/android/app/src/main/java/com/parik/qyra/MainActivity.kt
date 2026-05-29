package com.parik.qyra

import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File
import java.io.FileOutputStream
import java.lang.ref.WeakReference

class MainActivity : TauriActivity() {

  private val tag = "QyraIntent"

  // Captured in onWebViewCreate so we can eval JS from onNewIntent (warm-start foreground).
  private var webViewRef: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    webViewRef = webView
  }

  // Native side (Rust) calls launchFolderPickerFromNative() on this companion;
  // we route to the live activity through this weak ref so the GC stays in
  // charge of the Activity lifecycle.
  companion object {
    @JvmStatic
    private var instanceRef: WeakReference<MainActivity>? = null

    /**
     * Called from Rust (JNI) to open Android's SAF folder picker.
     * Returns true if the picker was launched, false if no activity is
     * currently in the foreground.
     */
    @JvmStatic
    fun launchFolderPickerFromNative(): Boolean {
      val act = instanceRef?.get() ?: return false
      act.runOnUiThread { act.openFolderLauncher.launch(null) }
      return true
    }
  }

  /**
   * SAF tree picker. On result we take a persistable URI permission so the
   * grant survives process death, enumerate PDFs inside the chosen tree, and
   * write one marker line per child URI into filesDir/.pending_folder.txt.
   * The Rust side polls that marker on resume and emits "folder-picked".
   */
  private val openFolderLauncher = registerForActivityResult(
    ActivityResultContracts.OpenDocumentTree()
  ) { treeUri: Uri? ->
    if (treeUri == null) {
      Log.i(tag, "Folder picker cancelled")
      return@registerForActivityResult
    }
    try {
      // Persist the grant so we can re-enumerate on next launch without re-prompting.
      val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
        Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
      contentResolver.takePersistableUriPermission(treeUri, flags)

      val children = enumeratePdfChildren(treeUri)
      val marker = File(filesDir, ".pending_folder.txt")
      // One line per PDF: <treeUri>\t<childUri>\t<displayName>
      // treeUri kept so frontend can persist the grant ref alongside the children.
      val sb = StringBuilder()
      for ((childUri, name) in children) {
        sb.append(treeUri.toString()).append('\t')
          .append(childUri.toString()).append('\t')
          .append(name).append('\n')
      }
      marker.writeText(sb.toString())
      Log.i(tag, "SAF folder picked: ${children.size} PDF(s) under $treeUri")
    } catch (e: Exception) {
      Log.e(tag, "SAF folder enumeration failed: ${e.message}", e)
    }
  }

  /**
   * Walk a SAF tree URI and return every direct or nested child whose mime
   * type is application/pdf (or whose display name ends in .pdf for picker
   * implementations that mislabel mime). DocumentsContract handles both the
   * "primary external storage" tree and third-party providers (Google Drive,
   * Dropbox, etc.) uniformly.
   */
  private fun enumeratePdfChildren(treeUri: Uri): List<Pair<Uri, String>> {
    val out = ArrayList<Pair<Uri, String>>()
    val rootDocId = DocumentsContract.getTreeDocumentId(treeUri)
    walk(treeUri, rootDocId, out)
    return out
  }

  private fun walk(treeUri: Uri, parentDocId: String, out: MutableList<Pair<Uri, String>>) {
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId)
    val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
    )
    val cursor: Cursor? = contentResolver.query(childrenUri, projection, null, null, null)
    cursor?.use { c ->
      val idxId = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
      val idxName = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
      val idxMime = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
      while (c.moveToNext()) {
        val docId = c.getString(idxId) ?: continue
        val name = c.getString(idxName) ?: continue
        val mime = c.getString(idxMime) ?: ""
        if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
          walk(treeUri, docId, out)
        } else if (mime == "application/pdf" || name.endsWith(".pdf", ignoreCase = true)) {
          val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
          out.add(docUri to name)
        }
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    instanceRef = WeakReference(this)
    handleIncomingIntent(intent)
  }

  override fun onDestroy() {
    if (instanceRef?.get() === this) instanceRef = null
    super.onDestroy()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleIncomingIntent(intent)
    // When the app is already in the foreground, onResume won't fire again,
    // so RunEvent::Resumed never triggers. Signal the frontend to call
    // get_pending_open via a custom DOM event instead.
    runOnUiThread {
      webViewRef?.evaluateJavascript(
        "document.dispatchEvent(new CustomEvent('qyra-pending-open'))",
        null
      )
    }
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
