package com.benatif.android

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Resumable model download: bytes go to `<file>.part`, continuing with an HTTP Range request if a
 * partial file exists; the file is renamed only when complete, so only complete files count as
 * cached. Cancel the calling coroutine to pause; the next call resumes.
 */
class ModelDownloader(private val userAgent: String = "natif-android") {

    suspend fun download(url: String, dest: File, onProgress: ((Double) -> Unit)? = null) = withContext(Dispatchers.IO) {
        if (dest.exists()) return@withContext
        dest.parentFile?.mkdirs()
        val part = File(dest.path + ".part")
        var attempt = 0
        while (true) {
            attempt++
            val offset = if (part.exists()) part.length() else 0L
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = true
                connectTimeout = 30_000
                readTimeout = 60_000
                setRequestProperty("User-Agent", userAgent)
                setRequestProperty("Accept-Encoding", "identity")
                if (offset > 0) setRequestProperty("Range", "bytes=$offset-")
            }
            try {
                val code = conn.responseCode
                val append = when {
                    code == HttpURLConnection.HTTP_PARTIAL && offset > 0 -> true
                    code == HttpURLConnection.HTTP_OK -> false // server ignored Range: start over
                    code == 416 && offset > 0 && attempt == 1 -> { // stale .part (e.g. file changed upstream)
                        part.delete()
                        continue
                    }
                    else -> throw IOException("Model download failed (HTTP $code)")
                }
                val remaining = conn.getHeaderFieldLong("Content-Length", -1L)
                val total = if (remaining > 0) remaining + (if (append) offset else 0L) else -1L
                var written = if (append) offset else 0L
                var lastReport = 0L
                conn.inputStream.use { input ->
                    FileOutputStream(part, append).use { out ->
                        val buf = ByteArray(256 * 1024)
                        while (true) {
                            ensureActive()
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            written += n
                            val now = System.currentTimeMillis()
                            if (total > 0 && now - lastReport > 250) {
                                lastReport = now
                                onProgress?.invoke(written.toDouble() / total)
                            }
                        }
                    }
                }
                if (total > 0 && written < total) throw IOException("Model download incomplete ($written of $total bytes)")
                if (!part.renameTo(dest)) throw IOException("Could not move ${part.name} to ${dest.name}")
                onProgress?.invoke(1.0)
                return@withContext
            } finally {
                conn.disconnect()
            }
        }
    }
}
