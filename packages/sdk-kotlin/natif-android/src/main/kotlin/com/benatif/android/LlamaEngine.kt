package com.benatif.android

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import com.benatif.DeviceProfile
import com.benatif.GenerateRequest
import com.benatif.GenerateResult
import com.benatif.JsonSchemaGrammar
import com.benatif.LoadPhase
import com.benatif.LoadProgress
import com.benatif.ModelSpec
import com.benatif.TextEngine
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.ConcurrentHashMap

data class LlamaEngineOptions(
    /** Context window in tokens. Larger = longer chats, more memory. Default 4096 (same as React Native). */
    val nCtx: Int = 4096,
    /** Prompt batch size. */
    val nBatch: Int = 512,
    /** CPU threads. Default: up to 4 (the big cores on most phones). */
    val nThreads: Int = minOf(4, Runtime.getRuntime().availableProcessors()).coerceAtLeast(1),
    /** Layers offloaded to a GPU backend. No GPU backend is compiled in yet, so this has no effect for now. */
    val nGpuLayers: Int = 99,
    /** Constrain JSON output with a grammar generated from the schema (extract/classify). */
    val constrainedJson: Boolean = true,
    /** Sampling seed; -1 = random. */
    val seed: Int = -1,
)

/**
 * Runs GGUF models with llama.cpp through JNI. Mirrors LlamaRNEngine in sdk-react-native: one
 * model file per catalog entry, downloaded once into [modelsDir] (`.part` + rename), mapped with
 * mmap, n_ctx 4096, Qwen3 thinking disabled when the spec says so.
 */
class LlamaEngine(
    private val modelsDir: File,
    private val opts: LlamaEngineOptions = LlamaEngineOptions(),
    private val downloader: ModelDownloader = ModelDownloader(),
) : TextEngine {
    override val name = "llama.cpp"
    override val supportsDownload = true

    private val urls = ConcurrentHashMap<String, String>()
    private val mutex = Mutex()
    private var model = 0L
    private var session = 0L
    private var loadedId: String? = null

    override fun resolveModelId(spec: ModelSpec, device: DeviceProfile): String? {
        val url = spec.runtimes.gguf?.url ?: return null
        val id = url.substringAfterLast('/').removeSuffix(".gguf").removeSuffix(".GGUF")
        urls[id] = url
        return id
    }

    private fun file(id: String) = File(modelsDir, "$id.gguf")

    override suspend fun isCached(engineModelId: String) = withContext(Dispatchers.IO) { file(engineModelId).exists() }

    private suspend fun ensureFile(id: String, onProgress: ((LoadProgress) -> Unit)?): File {
        val f = file(id)
        if (f.exists()) return f
        val url = urls[id] ?: error("LlamaEngine: unknown model $id")
        downloader.download(url, f) { p -> onProgress?.invoke(LoadProgress(id, p, LoadPhase.DOWNLOAD)) }
        return f
    }

    override suspend fun download(engineModelId: String, onProgress: ((LoadProgress) -> Unit)?) {
        ensureFile(engineModelId, onProgress)
        onProgress?.invoke(LoadProgress(engineModelId, 1.0, LoadPhase.READY, "downloaded"))
    }

    override suspend fun load(engineModelId: String, onProgress: ((LoadProgress) -> Unit)?) {
        mutex.withLock {
            if (loadedId == engineModelId && session != 0L) return
            freeLocked()
            val f = ensureFile(engineModelId, onProgress)
            withContext(Dispatchers.IO) {
                val job = coroutineContext.job
                val m = LlamaNative.loadModel(f.path, opts.nGpuLayers, true) { p ->
                    onProgress?.invoke(LoadProgress(engineModelId, p.toDouble(), LoadPhase.COMPILE))
                    job.isActive
                }
                ensureActive()
                val s = try {
                    LlamaNative.createSession(m, opts.nCtx, opts.nBatch, opts.nThreads)
                } catch (e: Throwable) {
                    LlamaNative.freeModel(m)
                    throw e
                }
                model = m
                session = s
                loadedId = engineModelId
            }
            onProgress?.invoke(LoadProgress(engineModelId, 1.0, LoadPhase.READY))
        }
    }

    override suspend fun generate(req: GenerateRequest): GenerateResult = mutex.withLock {
        val s = session
        check(s != 0L) { "LlamaEngine: no model loaded" }
        val grammar = if (opts.constrainedJson) req.jsonSchema?.let { JsonSchemaGrammar.convert(it).toByteArray() } else null
        val roles = req.messages.map { it.role.wire.toByteArray() }.toTypedArray()
        val contents = req.messages.map { it.content.toByteArray(Charsets.UTF_8) }.toTypedArray()
        val text = ByteArrayOutputStream()
        val stats = coroutineScope {
            val worker = async(Dispatchers.Default) {
                val job = coroutineContext.job
                LlamaNative.generate(
                    s, roles, contents, req.maxTokens, req.temperature.toFloat(), opts.seed, req.disableThinking, grammar,
                ) { piece ->
                    text.write(piece)
                    req.onToken?.invoke(String(piece, Charsets.UTF_8))
                    job.isActive
                }
            }
            try {
                worker.await()
            } catch (e: CancellationException) {
                // Cancelling the caller (or withTimeout) stops generation: native code checks the
                // flag after every token and inside llama_process through the abort callback.
                // coroutineScope then waits for the native call to return before releasing the mutex.
                LlamaNative.stop(s)
                throw e
            }
        }
        val decodeUs = stats[5]
        GenerateResult(
            text = text.toString(Charsets.UTF_8.name()),
            promptTokens = stats[0].toInt(),
            completionTokens = stats[1].toInt(),
            ttftMs = stats[3],
            totalMs = stats[4],
            decodeTokPerSec = if (decodeUs > 0) stats[1] * 1_000_000.0 / decodeUs else 0.0,
            cachedTokens = stats[2].toInt(),
        )
    }

    override suspend fun unload() {
        mutex.withLock { freeLocked() }
    }

    /** Deletes a downloaded model file (frees storage). */
    suspend fun deleteModel(engineModelId: String) {
        mutex.withLock {
            if (loadedId == engineModelId) freeLocked()
        }
        withContext(Dispatchers.IO) {
            file(engineModelId).delete()
            File(file(engineModelId).path + ".part").delete()
        }
    }

    private fun freeLocked() {
        if (session != 0L) LlamaNative.freeSession(session)
        if (model != 0L) LlamaNative.freeModel(model)
        session = 0L
        model = 0L
        loadedId = null
    }
}
