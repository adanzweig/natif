package com.benatif

val highEndWeb = DeviceProfile(
    platform = Platform.WEB,
    browser = DeviceProfile.Browser("chrome", 157),
    gpu = GpuInfo(available = true, vendor = "apple", architecture = "metal-3", shaderF16 = true, maxBufferSize = 4L * (1L shl 30)),
    memoryGB = 8.0,
    storageFreeBytes = 100_000_000_000,
)

/** Same behaviour as sdk-core/test/helpers.ts MockEngine. */
open class MockEngine(
    var reply: (GenerateRequest, Int) -> String = { _, _ -> "{}" },
    val tokPerSec: MutableMap<String, Double> = mutableMapOf(),
) : TextEngine {
    override val name = "mock"
    val loads = mutableListOf<String>()
    val calls = mutableListOf<GenerateRequest>()
    val cached = mutableSetOf<String>()
    val failLoad = mutableSetOf<String>()
    var current: String? = null
    var generateOverride: (suspend (GenerateRequest) -> GenerateResult)? = null

    override fun resolveModelId(spec: ModelSpec, device: DeviceProfile) = spec.runtimes.webllm?.f16
    override suspend fun isCached(engineModelId: String) = engineModelId in cached
    override suspend fun load(engineModelId: String, onProgress: ((LoadProgress) -> Unit)?) {
        if (engineModelId in failLoad) throw IllegalStateException("load failed")
        loads += engineModelId
        current = engineModelId
        cached += engineModelId
    }

    override suspend fun generate(req: GenerateRequest): GenerateResult {
        generateOverride?.let { calls += req; return it(req) }
        calls += req
        val isBench = req.jsonSchema == null
        val text = if (isBench) "the sky is blue because" else reply(req, calls.count { it.jsonSchema != null })
        return GenerateResult(text, 100, 20, 50, 500, tokPerSec[current] ?: 40.0)
    }

    override suspend fun unload() {
        current = null
    }
}

class TestPlatform(private val engine: TextEngine, private val device: DeviceProfile = highEndWeb) : PlatformAdapter {
    override val sdkVersion = "0.1.0"
    override suspend fun detectDevice() = device
    override fun createTextEngine() = engine
    override val storage = MemoryStore()
}

fun client(engine: TextEngine, opts: ClientOptions = ClientOptions(idleUnloadMs = 0), device: DeviceProfile = highEndWeb) =
    createCoreClient(opts, TestPlatform(engine, device))
