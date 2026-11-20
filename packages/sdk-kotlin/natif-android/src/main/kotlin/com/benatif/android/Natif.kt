package com.benatif.android

import android.content.Context
import com.benatif.ClientOptions
import com.benatif.DeviceProfile
import com.benatif.KeyValueStore
import com.benatif.NatifClient
import com.benatif.PlatformAdapter
import com.benatif.TextEngine
import java.io.File

/**
 * Entry point of the Android SDK.
 *
 * ```kotlin
 * val ai = Natif.create(context, ClientOptions())
 * val reply = ai.chat(ChatRequest("Hola"))
 * ```
 */
object Natif {
    const val SDK_VERSION: String = "0.1.0"

    /** Where GGUF files live: `context.filesDir/natif-models` (app-private, not backed up to the cloud by default). */
    fun modelsDir(context: Context): File = File(context.applicationContext.filesDir, "natif-models")

    fun create(
        context: Context,
        options: ClientOptions = ClientOptions(),
        engineOptions: LlamaEngineOptions = LlamaEngineOptions(),
    ): NatifClient = NatifClient(options, AndroidPlatform(context.applicationContext, engineOptions))

    /** llama.cpp CPU features compiled in and detected (e.g. NEON, DOTPROD), for diagnostics. */
    fun systemInfo(): String = LlamaNative.systemInfo()
}

internal class AndroidPlatform(private val context: Context, private val engineOptions: LlamaEngineOptions) : PlatformAdapter {
    private val dir = Natif.modelsDir(context)
    override val sdkVersion = Natif.SDK_VERSION
    override val storage: KeyValueStore = PreferencesStore(context)
    override suspend fun detectDevice(): DeviceProfile = AndroidDevice.detect(context, dir)
    override fun createTextEngine(): TextEngine = LlamaEngine(dir, engineOptions)
}
