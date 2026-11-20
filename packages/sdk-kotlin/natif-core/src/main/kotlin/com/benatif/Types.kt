package com.benatif

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// Kotlin port of packages/sdk-core/src/types.ts. Wire names (the strings the backend, telemetry
// and the other SDKs use) are kept in `wire` so values are identical on every platform.

/** What an app declares it needs. The orchestrator picks one model per capability. */
enum class Capability(val wire: String) {
    TEXT("text"), VISION("vision"), AUDIO_IN("audio-in"), TTS("tts"), IMAGE("image"), VIDEO("video");

    companion object {
        fun fromWire(s: String): Capability? = entries.firstOrNull { it.wire == s }
    }
}

enum class RuntimeMode(val wire: String) { AUTO("auto"), DEVICE_ONLY("device-only"), CLOUD_ONLY("cloud-only") }

enum class RuntimeUsed(val wire: String) { DEVICE("device"), CLOUD("cloud") }

enum class Platform(val wire: String) { WEB("web"), IOS("ios"), ANDROID("android"), NODE("node") }

data class Consent(
    /** User agreed that, if the device can't, the input may be sent to the cloud fallback. */
    val cloudFallback: Boolean = false,
    /** User agreed to anonymous performance telemetry (no content, ever). */
    val telemetry: Boolean = false,
)

data class GpuInfo(
    val available: Boolean,
    val vendor: String? = null,
    val architecture: String? = null,
    val shaderF16: Boolean? = null,
    val maxBufferSize: Long? = null,
    val maxStorageBufferBindingSize: Long? = null,
)

/** Device class traits. Nothing here identifies a person. */
data class DeviceProfile(
    val platform: Platform,
    val browser: Browser? = null,
    val os: String? = null,
    /** Hardware model on mobile, e.g. "Pixel 8". */
    val hardwareModel: String? = null,
    val gpu: GpuInfo = GpuInfo(available = false),
    /** Approximate total RAM in GB. */
    val memoryGB: Double? = null,
    /** RAM the app can use right now, in MB (Android: ActivityManager.MemoryInfo.availMem). */
    val availableMemoryMB: Double? = null,
    val storageFreeBytes: Long? = null,
) {
    data class Browser(val name: String, val major: Int)
}

enum class ModelTier(val wire: String) { HIGH("high"), LOW("low") }

data class WebLlmRuntime(val f16: String, val f32: String? = null)
data class GgufRuntime(val url: String)
data class ModelRuntimes(val webllm: WebLlmRuntime? = null, val gguf: GgufRuntime? = null)

data class ModelSpec(
    val id: String,
    val family: String,
    val capabilities: List<Capability>,
    val tier: ModelTier,
    val license: String,
    /** Approximate download size of the default variant. */
    val downloadBytes: Long,
    /** Approximate RAM needed while running (weights + KV cache). */
    val memoryRequiredMB: Int,
    val runtimes: ModelRuntimes,
    /** Higher = better output. Used to rank candidates that fit. */
    val quality: Int,
    /** Qwen3 thinking mode must be turned off for extraction. */
    val disableThinking: Boolean = false,
)

enum class Role(val wire: String) { SYSTEM("system"), USER("user"), ASSISTANT("assistant") }

data class ChatMessage(val role: Role, val content: String) {
    companion object {
        fun system(content: String) = ChatMessage(Role.SYSTEM, content)
        fun user(content: String) = ChatMessage(Role.USER, content)
        fun assistant(content: String) = ChatMessage(Role.ASSISTANT, content)
    }
}

data class GenerateRequest(
    val messages: List<ChatMessage>,
    /** JSON Schema the output must follow (constrained decoding when the engine supports it). */
    val jsonSchema: JsonObject? = null,
    val maxTokens: Int,
    val temperature: Double,
    val disableThinking: Boolean = false,
    /** Called with each new piece of text as it is generated (streaming). */
    val onToken: ((String) -> Unit)? = null,
)

data class GenerateResult(
    val text: String,
    val promptTokens: Int,
    val completionTokens: Int,
    val ttftMs: Long,
    val totalMs: Long,
    val decodeTokPerSec: Double,
    /** Prompt tokens reused from the KV cache (prefix match), when the engine reports it. */
    val cachedTokens: Int? = null,
)

enum class LoadPhase(val wire: String) { DOWNLOAD("download"), COMPILE("compile"), READY("ready") }

data class LoadProgress(
    val modelId: String,
    /** 0..1 */
    val progress: Double,
    val phase: LoadPhase,
    val text: String? = null,
)

/**
 * Implemented by each platform (llama.cpp over JNI in natif-android, a mock in tests).
 * Cancellation follows coroutines: cancelling the caller must stop generation promptly.
 */
interface TextEngine {
    val name: String

    /** Platform-specific model id for a catalog entry, or null if this engine can't run it. */
    fun resolveModelId(spec: ModelSpec, device: DeviceProfile): String?

    suspend fun isCached(engineModelId: String): Boolean

    suspend fun load(engineModelId: String, onProgress: ((LoadProgress) -> Unit)? = null)

    /** True when [download] is implemented. */
    val supportsDownload: Boolean get() = false

    /**
     * Put the weights on disk without loading them, so a later [load] only maps them. Must skip
     * files already stored and resume an interrupted download.
     */
    suspend fun download(engineModelId: String, onProgress: ((LoadProgress) -> Unit)? = null) {
        throw UnsupportedOperationException("$name can't download without loading")
    }

    suspend fun generate(req: GenerateRequest): GenerateResult

    suspend fun unload()
}

/** Same names as the TS `FallbackReason` union. */
enum class FallbackReason(val wire: String) {
    NO_WEBGPU("no_webgpu"),
    INSUFFICIENT_MEMORY("insufficient_memory"),
    INSUFFICIENT_STORAGE("insufficient_storage"),
    NO_MODEL_FOR_CAPABILITY("no_model_for_capability"),
    KNOWN_SLOW_DEVICE("known_slow_device"),
    BENCHMARK_SLOW("benchmark_slow"),
    LOAD_FAILED("load_failed"),
    ENGINE_ERROR("engine_error"),
    SCHEMA_FAILED_AFTER_REPAIR("schema_failed_after_repair"),
    TIMEOUT("timeout"),
    FORCED_CLOUD("forced_cloud");

    override fun toString() = wire
}

data class TaskConfig(
    val slug: String,
    val version: Int = 0,
    val inputType: String = "text",
    val systemPrompt: String,
    val instructions: String? = null,
    val jsonSchema: JsonObject? = null,
    val temperature: Double = 0.0,
    val maxTokens: Int = 256,
    /** Below this decode speed the device is considered too slow for the task. */
    val minDeviceTokPerSec: Double = 8.0,
    val recommendedModel: String? = null,
    /** Set server-side when the project enforces local-only processing. */
    val deviceOnly: Boolean = false,
)

/** A task defined in code. Same defaults as TS `TASK_DEFAULTS`. */
data class LocalTask(
    val systemPrompt: String,
    val instructions: String? = null,
    val version: Int = 0,
    val temperature: Double = 0.0,
    val maxTokens: Int = 256,
    val minDeviceTokPerSec: Double = 8.0,
    val recommendedModel: String? = null,
    val jsonSchema: JsonObject? = null,
    val deviceOnly: Boolean = false,
) {
    fun complete(slug: String) = TaskConfig(
        slug = slug,
        version = version,
        systemPrompt = systemPrompt,
        instructions = instructions,
        jsonSchema = jsonSchema,
        temperature = temperature,
        maxTokens = maxTokens,
        minDeviceTokPerSec = minDeviceTokPerSec,
        recommendedModel = recommendedModel,
        deviceOnly = deviceOnly,
    )
}

data class BenchmarkResult(
    val modelId: String,
    val decodeTokPerSec: Double,
    val ttftMs: Long,
    val at: Long,
)

data class ExtractMeta(
    val modelId: String,
    val runtime: RuntimeUsed,
    val taskVersion: Int,
    val latencyMs: Long,
    val tokensIn: Int,
    val tokensOut: Int,
    /** What the same call would have cost on the reference cloud model. Estimate. */
    val estimatedSavingsUsd: Double,
    val fallbackReason: FallbackReason? = null,
    val repaired: Boolean = false,
)

data class ExtractResult(val data: JsonElement, val meta: ExtractMeta)

data class ClassifyResult(val label: String, val meta: ExtractMeta)

data class ChatRequest(
    /** The new user message. */
    val message: String,
    /**
     * Previous turns, owned by your app. Keep it append-only: the engine reuses the cached
     * prefix, so editing old turns or the system prompt makes the whole conversation be processed again.
     */
    val history: List<ChatMessage> = emptyList(),
    /** System prompt. Keep it identical across turns so it stays cached. */
    val system: String? = null,
    /** Max previous messages sent to the model (default 20); dropped in blocks, see [trimHistory]. */
    val maxHistoryMessages: Int = DEFAULT_MAX_HISTORY,
    val temperature: Double = 0.7,
    val maxTokens: Int = 512,
    /** Streaming: called with each new piece of visible text (thinking is filtered out). */
    val onToken: ((String) -> Unit)? = null,
    /** Override the client's `grounding` for this call (OFF skips knowledge). */
    val grounding: Grounding? = null,
)

data class ChatMeta(
    val modelId: String,
    val runtime: RuntimeUsed,
    val latencyMs: Long,
    val ttftMs: Long,
    val tokensIn: Int,
    val tokensOut: Int,
    val decodeTokPerSec: Double,
    val estimatedSavingsUsd: Double,
    /** Prompt tokens reused from the engine cache, when the engine reports it. */
    val cachedTokens: Int? = null,
    /** Older messages left out by maxHistoryMessages. */
    val droppedMessages: Int,
)

data class ChatResult(
    val text: String,
    /** history + the new user message + the reply. Pass it back on the next turn. */
    val history: List<ChatMessage>,
    val meta: ChatMeta,
    /** Passages from `knowledge` given to the model; `cited` marks the ones it used. Null without knowledge. */
    val sources: List<Source>? = null,
)

sealed interface TextCapability {
    data class Available(val modelId: String, val tier: ModelTier, val cached: Boolean) : TextCapability
    data class Unavailable(val reason: FallbackReason) : TextCapability
}

data class CapabilityReport(val device: DeviceProfile, val deviceKey: String, val text: TextCapability)

sealed interface DownloadResult {
    data class Downloaded(val modelId: String, val engineModelId: String, val downloadBytes: Long) : DownloadResult

    /** [reason] is a [FallbackReason] wire name or "unsupported_engine", as in TS. */
    data class Unavailable(val reason: String) : DownloadResult
}
