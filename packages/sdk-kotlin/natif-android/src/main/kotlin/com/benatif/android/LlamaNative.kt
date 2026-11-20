package com.benatif.android

/** JNI surface of libnatif.so (src/main/cpp/natif_jni.cpp). Handles are native pointers. */
internal object LlamaNative {
    init {
        System.loadLibrary("natif")
        backendInit()
    }

    fun interface TokenCallback {
        /** UTF-8 bytes of one or more whole characters. Return false to stop generating. */
        fun onToken(piece: ByteArray): Boolean
    }

    fun interface ProgressCallback {
        /** 0..1 while mapping the model. Return false to cancel loading. */
        fun onProgress(progress: Float): Boolean
    }

    external fun backendInit()
    external fun systemInfo(): String
    external fun loadModel(path: String, nGpuLayers: Int, useMmap: Boolean, progress: ProgressCallback?): Long
    external fun freeModel(model: Long)
    external fun createSession(model: Long, nCtx: Int, nBatch: Int, nThreads: Int): Long
    external fun freeSession(session: Long)
    external fun stop(session: Long)

    /** Returns [promptTokens, completionTokens, cachedTokens, ttftMs, totalMs, decodeMicros]. */
    external fun generate(
        session: Long,
        roles: Array<ByteArray>,
        contents: Array<ByteArray>,
        maxTokens: Int,
        temperature: Float,
        seed: Int,
        disableThinking: Boolean,
        grammar: ByteArray?,
        callback: TokenCallback,
    ): LongArray
}
