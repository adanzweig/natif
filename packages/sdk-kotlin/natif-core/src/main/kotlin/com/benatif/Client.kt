package com.benatif

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.util.concurrent.atomic.AtomicInteger

// Port of packages/sdk-core/src/client.ts.

const val CLASSIFY_TASK: String = "benatif.classify"

/** Kotlin addition: default task for `extract(text, schema)` without a task slug. */
const val EXTRACT_TASK: String = "benatif.extract"

/** Tasks the SDK ships with; an app task with the same slug overrides them. */
val BUILTIN_TASKS: Map<String, LocalTask> = mapOf(
    CLASSIFY_TASK to LocalTask(
        systemPrompt = "You are a precise text classifier. Read the text and choose the single label from the given list that fits it best. Follow the instructions if any. Answer with JSON only.",
        temperature = 0.0,
        maxTokens = 40,
    ),
    EXTRACT_TASK to LocalTask(
        systemPrompt = "You extract structured data from the user's text. Use only information present in the text. Answer with JSON only.",
    ),
)

data class ClientOptions(
    /** Capabilities the app needs. Only TEXT is implemented on Android for now. */
    val capabilities: List<Capability> = listOf(Capability.TEXT),
    /** EAGER downloads, loads and benchmarks the text model at init; LAZY waits for the first call. */
    val preload: Preload = Preload.LAZY,
    val runtime: RuntimeMode = RuntimeMode.AUTO,
    val consent: Consent = Consent(),
    /** Tasks defined in code instead of the dashboard. */
    val tasks: Map<String, LocalTask> = emptyMap(),
    val onDownloadProgress: ((LoadProgress) -> Unit)? = null,
    /** Your own knowledge for `chat`: inline docs and/or your retrieval. benatif never stores it. */
    val knowledge: KnowledgeOptions? = null,
    /** How strictly `chat` sticks to `knowledge` (default PREFER when knowledge is set). */
    val grounding: Grounding? = null,
    val catalog: ModelCatalog = ModelCatalog.default,
    val priceReference: PriceReference = PriceReference.DEFAULT,
    /** Device inference slower than this is abandoned (and goes to the cloud if allowed). */
    val timeoutMs: Long = 60_000,
    /** Max memory (MB) a model may take. Default: 60% of available RAM. */
    val memoryBudgetMB: Double? = null,
    /** Free the model from RAM after this long without use (ms). Default 2 min; 0 = never. */
    val idleUnloadMs: Long = 120_000,
    /** Seam, not implemented yet in Kotlin: see [CloudFallback]. */
    val cloudFallback: CloudFallback? = null,
    /** Seam: published dashboard tasks. See [TaskSource]. */
    val taskSource: TaskSource? = null,
    /** Seam: anonymous telemetry, only used with Consent.telemetry. See [TelemetrySink]. */
    val telemetry: TelemetrySink? = null,
)

enum class Preload { LAZY, EAGER }

/** What each platform module provides (natif-android, or a mock in tests). */
interface PlatformAdapter {
    val sdkVersion: String
    suspend fun detectDevice(): DeviceProfile
    fun createTextEngine(): TextEngine
    val storage: KeyValueStore
}

/** Streaming events from [NatifClient.chatFlow]. */
sealed interface ChatEvent {
    data class Token(val text: String) : ChatEvent
    data class Done(val result: ChatResult) : ChatEvent
}

private const val BENCHMARK_TOKENS = 64

class NatifClient(private val opts: ClientOptions, private val platform: PlatformAdapter) {
    @Volatile
    var consent: Consent = opts.consent
        private set
    private val mode = opts.runtime
    private val catalog = opts.catalog.models
    private val constants = opts.catalog.constants
    private val localTasks = BUILTIN_TASKS + opts.tasks
    private val knowledge = opts.knowledge?.let { Knowledge(it) }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val deviceMutex = Mutex()
    private var deviceInfo: Pair<DeviceProfile, String>? = null
    private var engine: TextEngine? = null
    private val loadMutex = Mutex()

    @Volatile
    private var loaded: Loaded? = null
    private var idleJob: Job? = null
    private val inFlight = AtomicInteger(0)
    private val warnedSchemas = mutableSetOf<String>()

    private data class Loaded(val spec: ModelSpec, val engineModelId: String, val loadMs: Long)
    private sealed interface Ready {
        data class Ok(val spec: ModelSpec, val engineModelId: String) : Ready
        data class Failure(val reason: FallbackReason) : Ready
    }

    init {
        if (opts.preload == Preload.EAGER && Capability.TEXT in opts.capabilities && mode != RuntimeMode.CLOUD_ONLY) {
            scope.launch { runCatching { ensureTextModel(8.0) } }
        }
    }

    /** Update consent after the user answers (e.g. from a settings screen). */
    fun setConsent(consent: Consent) {
        this.consent = consent
    }

    /**
     * Conversation on the device, streamed through [ChatRequest.onToken]. The app owns the history
     * and passes it on every turn; the result returns the updated history.
     * On-device only for now: throws [DeviceUnavailableException] when the device can't run a model.
     */
    suspend fun chat(req: ChatRequest): ChatResult {
        val message = req.message.trim()
        require(message.isNotEmpty()) { "chat: message is required" }
        if (mode == RuntimeMode.CLOUD_ONLY) throw DeviceUnavailableException(FallbackReason.FORCED_CLOUD, "chat runs on the device only")
        val history = req.history.filter { it.role != Role.SYSTEM }
        val (kept, dropped) = trimHistory(history, req.maxHistoryMessages)
        val t0 = System.nanoTime()
        begin()
        try {
            val ready = ensureTextModel(4.0)
            if (ready is Ready.Failure) throw DeviceUnavailableException(ready.reason)
            ready as Ready.Ok
            val user = ChatMessage.user(message)
            // Knowledge goes into this turn only; the returned history keeps the plain message.
            val grounding = req.grounding ?: opts.grounding ?: if (knowledge != null) Grounding.PREFER else Grounding.OFF
            var chunks: List<KnowledgeChunk>? = null
            var sent = user
            if (knowledge != null && grounding != Grounding.OFF) {
                chunks = knowledge.find(message)
                sent = ChatMessage.user(groundedMessage(message, chunks, grounding))
            }
            val messages = buildList {
                req.system?.let { add(ChatMessage.system(it)) }
                addAll(kept)
                add(sent)
            }
            var filtering = false // hide <think>…</think> if a model emits it anyway
            val onToken = req.onToken?.let { cb ->
                { d: String ->
                    if ("<think>" in d) filtering = true
                    if (filtering) {
                        if ("</think>" in d) filtering = false
                    } else {
                        cb(d)
                    }
                }
            }
            val r = textEngine().generate(
                GenerateRequest(
                    messages = messages,
                    maxTokens = req.maxTokens,
                    temperature = req.temperature,
                    disableThinking = ready.spec.disableThinking,
                    onToken = onToken,
                ),
            )
            val text = stripThinking(r.text).trim()
            return ChatResult(
                text = text,
                history = history + user + ChatMessage.assistant(text),
                sources = chunks?.let { toSources(it, text) },
                meta = ChatMeta(
                    modelId = ready.spec.id,
                    runtime = RuntimeUsed.DEVICE,
                    latencyMs = msSince(t0),
                    ttftMs = r.ttftMs,
                    tokensIn = r.promptTokens,
                    tokensOut = r.completionTokens,
                    decodeTokPerSec = r.decodeTokPerSec,
                    estimatedSavingsUsd = estimateSavingsUsd(r.promptTokens, r.completionTokens, opts.priceReference),
                    cachedTokens = r.cachedTokens,
                    droppedMessages = dropped,
                ),
            )
        } finally {
            end()
        }
    }

    /** [chat] as a cold Flow: visible tokens, then one [ChatEvent.Done]. Cancel the collector to stop. */
    fun chatFlow(req: ChatRequest): Flow<ChatEvent> = channelFlow {
        val result = chat(req.copy(onToken = { t -> trySend(ChatEvent.Token(t)); req.onToken?.invoke(t) }))
        send(ChatEvent.Done(result))
    }.buffer(Channel.UNLIMITED) // tokens arrive from the engine thread; never drop one

    /**
     * Zero-shot classification on the device: picks exactly one of [labels] for [text].
     * Built on extract (same model choice, validation, telemetry and fallback rules).
     */
    suspend fun classify(text: String, labels: List<String>, instructions: String? = null): ClassifyResult {
        val unique = labels.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        require(unique.size >= 2) { "classify: give at least 2 labels" }
        require(text.isNotBlank()) { "classify: text is required" }
        // Same JSON Schema zod produces for z.object({ label: z.enum(labels) }).
        val schema = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") {
                putJsonObject("label") {
                    put("type", "string")
                    putJsonArray("enum") { unique.forEach { add(JsonPrimitive(it)) } }
                }
            }
            putJsonArray("required") { add(JsonPrimitive("label")) }
            put("additionalProperties", false)
        }
        val input = "${if (instructions != null) "Instructions: $instructions\n" else ""}Labels: ${unique.joinToString(" | ")}\nText: ${text.trim()}"
        val r = extractWithMeta(input, schema, task = CLASSIFY_TASK)
        return ClassifyResult(label = r.data.jsonObject["label"]!!.jsonPrimitive.content, meta = r.meta)
    }

    /** Structured extraction: returns JSON that validates against [jsonSchema]. */
    suspend fun extract(text: String, jsonSchema: JsonObject, task: String = EXTRACT_TASK) =
        extractWithMeta(text, jsonSchema, task).data

    suspend fun extract(text: String, jsonSchema: String, task: String = EXTRACT_TASK) =
        extractWithMeta(text, parseJsonSchema(jsonSchema), task).data

    suspend fun extractWithMeta(text: String, jsonSchema: String, task: String = EXTRACT_TASK) =
        extractWithMeta(text, parseJsonSchema(jsonSchema), task)

    suspend fun extractWithMeta(text: String, jsonSchema: JsonObject, task: String = EXTRACT_TASK): ExtractResult {
        val input = text.trim()
        require(input.isNotEmpty()) { "extract: text is required" }
        val t0 = System.nanoTime()
        val (taskConfig, recommendation) = loadTask(task)
        warnOnSchemaDrift(taskConfig, jsonSchema)

        var deviceFailure: FallbackReason? = null
        var failureIssues: List<SchemaIssue> = emptyList()
        var failureRaw = ""

        if (mode != RuntimeMode.CLOUD_ONLY) {
            begin()
            try {
                val ready = ensureTextModel(taskConfig.minDeviceTokPerSec, recommendation, taskConfig.recommendedModel)
                if (ready is Ready.Failure) {
                    deviceFailure = ready.reason
                } else {
                    ready as Ready.Ok
                    when (val r = runOnDevice(taskConfig, jsonSchema, input, ready.spec)) {
                        is DeviceRun.Ok -> {
                            val meta = ExtractMeta(
                                modelId = ready.spec.id,
                                runtime = RuntimeUsed.DEVICE,
                                taskVersion = taskConfig.version,
                                latencyMs = msSince(t0),
                                tokensIn = r.tokensIn,
                                tokensOut = r.tokensOut,
                                estimatedSavingsUsd = estimateSavingsUsd(r.tokensIn, r.tokensOut, opts.priceReference),
                                repaired = r.repaired,
                            )
                            record(taskConfig, meta, "ok", r.decodeTokPerSec)
                            return ExtractResult(r.data, meta)
                        }
                        is DeviceRun.Failed -> {
                            deviceFailure = r.reason
                            failureIssues = r.issues
                            failureRaw = r.raw
                        }
                    }
                }
            } finally {
                end()
            }
        }

        when (val decision = decideRuntime(mode, consent, taskConfig.deviceOnly, deviceFailure)) {
            is RuntimeDecision.Device -> error("unreachable")
            is RuntimeDecision.None -> {
                val schemaFail = decision.reason == FallbackReason.SCHEMA_FAILED_AFTER_REPAIR
                record(taskConfig, failureMeta(taskConfig, t0, decision.reason), if (schemaFail) "schema_error" else "unavailable")
                if (schemaFail) throw SchemaValidationException(failureIssues, failureRaw)
                throw DeviceUnavailableException(decision.reason, if (consent.cloudFallback) null else "cloud fallback not consented")
            }
            is RuntimeDecision.Cloud -> {
                val cloud = opts.cloudFallback
                    ?: throw DeviceUnavailableException(decision.reason, "cloud fallback is not available in the Kotlin SDK yet")
                val res = cloud.extract(taskConfig.slug, taskConfig.version, input, jsonSchema)
                val issues = JsonSchemaValidator.validate(jsonSchema, res.data)
                if (issues.isNotEmpty()) throw SchemaValidationException(issues, res.data.toString())
                val meta = ExtractMeta(
                    modelId = res.model,
                    runtime = RuntimeUsed.CLOUD,
                    taskVersion = taskConfig.version,
                    latencyMs = msSince(t0),
                    tokensIn = res.inputTokens,
                    tokensOut = res.outputTokens,
                    estimatedSavingsUsd = 0.0,
                    fallbackReason = decision.reason,
                )
                record(taskConfig, meta, "ok")
                return ExtractResult(res.data, meta)
            }
        }
    }

    /** Download, load and benchmark ahead of time (e.g. during onboarding). */
    suspend fun prepare(task: String? = null): CapabilityReport {
        var min = 8.0
        var rec: DeviceRecommendation? = null
        var preferred: String? = null
        if (task != null) {
            val (t, r) = loadTask(task)
            min = t.minDeviceTokPerSec
            rec = r
            preferred = t.recommendedModel
        }
        ensureTextModel(min, rec, preferred)
        return capabilities()
    }

    /**
     * Download the text model this device would use, without loading it into RAM. Meant for
     * onboarding: when the user reaches the feature, only loading is left. Resumes an interrupted
     * download.
     */
    suspend fun download(onProgress: ((LoadProgress) -> Unit)? = null): DownloadResult {
        if (mode == RuntimeMode.CLOUD_ONLY) return DownloadResult.Unavailable(FallbackReason.FORCED_CLOUD.wire)
        val sel = select(8.0)
        if (sel !is ModelSelection.Selected) return DownloadResult.Unavailable((sel as ModelSelection.Rejected).reason.wire)
        val engine = textEngine()
        if (!engine.supportsDownload) return DownloadResult.Unavailable("unsupported_engine")
        engine.download(sel.engineModelId, onProgress ?: opts.onDownloadProgress)
        return DownloadResult.Downloaded(sel.spec.id, sel.engineModelId, sel.spec.downloadBytes)
    }

    /** What this device can do, without downloading anything. */
    suspend fun capabilities(): CapabilityReport {
        val (profile, key) = device()
        loaded?.let { return CapabilityReport(profile, key, TextCapability.Available(it.spec.id, it.spec.tier, cached = true)) }
        return when (val sel = select(8.0)) {
            is ModelSelection.Rejected -> CapabilityReport(profile, key, TextCapability.Unavailable(sel.reason))
            is ModelSelection.Selected -> {
                val cached = runCatching { textEngine().isCached(sel.engineModelId) }.getOrDefault(false)
                CapabilityReport(profile, key, TextCapability.Available(sel.spec.id, sel.spec.tier, cached))
            }
        }
    }

    /** Frees RAM (call when the app goes to background). The model stays on disk. */
    suspend fun unload() {
        idleJob?.cancel()
        loadMutex.withLock {
            engine?.unload()
            loaded = null
        }
    }

    /** Clears stored benchmarks. */
    suspend fun clearCache() {
        unload()
        platform.storage.clear()
    }

    /** Unloads the model and stops background work. The client can't be used afterwards. */
    suspend fun close() {
        unload()
        scope.cancel()
    }

    // ---------------------------------------------------------------------------------------

    private fun begin() {
        inFlight.incrementAndGet()
        idleJob?.cancel()
    }

    private fun end() {
        inFlight.decrementAndGet()
        scheduleIdleUnload()
    }

    private fun scheduleIdleUnload() {
        val ms = opts.idleUnloadMs
        if (ms <= 0 || inFlight.get() > 0) return
        idleJob?.cancel()
        idleJob = scope.launch {
            delay(ms)
            if (inFlight.get() == 0) {
                loadMutex.withLock {
                    if (inFlight.get() == 0) {
                        engine?.unload()
                        loaded = null
                    }
                }
            }
        }
    }

    private suspend fun device(): Pair<DeviceProfile, String> = deviceMutex.withLock {
        deviceInfo ?: platform.detectDevice().let { it to deviceKey(it) }.also { deviceInfo = it }
    }

    private fun textEngine(): TextEngine = synchronized(this) { engine ?: platform.createTextEngine().also { engine = it } }

    private fun benchKey(deviceKey: String, modelId: String) = "bench:$deviceKey:$modelId:${platform.sdkVersion}"

    private suspend fun getBench(key: String): BenchmarkResult? = platform.storage.get(key)?.let {
        runCatching {
            val o = Json.parseToJsonElement(it).jsonObject
            BenchmarkResult(o["modelId"]!!.jsonPrimitive.content, o["decodeTokPerSec"]!!.jsonPrimitive.double, o["ttftMs"]!!.jsonPrimitive.long, o["at"]!!.jsonPrimitive.long)
        }.getOrNull()
    }

    private suspend fun setBench(key: String, b: BenchmarkResult) {
        platform.storage.set(
            key,
            buildJsonObject {
                put("modelId", b.modelId)
                put("decodeTokPerSec", b.decodeTokPerSec)
                put("ttftMs", b.ttftMs)
                put("at", b.at)
            }.toString(),
        )
    }

    private suspend fun select(minTokPerSec: Double, recommendation: DeviceRecommendation? = null, preferred: String? = null): ModelSelection {
        val (profile, key) = device()
        val engine = textEngine()
        val benchmarks = mutableMapOf<String, BenchmarkResult>()
        val cached = mutableSetOf<String>()
        for (spec in catalog) {
            getBench(benchKey(key, spec.id))?.let { benchmarks[spec.id] = it }
            val id = engine.resolveModelId(spec, profile)
            if (id != null && runCatching { engine.isCached(id) }.getOrDefault(false)) cached += id
        }
        return selectModel(
            SelectModelInput(
                device = profile,
                capability = Capability.TEXT,
                catalog = catalog,
                engine = ModelIdResolver(engine::resolveModelId),
                minDeviceTokPerSec = minTokPerSec,
                cached = cached,
                benchmarks = benchmarks,
                recommendation = recommendation,
                preferredModel = preferred,
                memoryBudgetMB = opts.memoryBudgetMB,
                constants = constants,
            ),
        )
    }

    /**
     * Single-flight (mutex): picks a model, loads it, benchmarks it once per device+model+SDK
     * version, and steps down to the next candidate if the benchmark is too slow.
     */
    private suspend fun ensureTextModel(minTokPerSec: Double, recommendation: DeviceRecommendation? = null, preferred: String? = null): Ready {
        loaded?.let { return Ready.Ok(it.spec, it.engineModelId) }
        return loadMutex.withLock {
            loaded?.let { return@withLock Ready.Ok(it.spec, it.engineModelId) }
            val (_, key) = device()
            val engine = textEngine()
            repeat(catalog.size) {
                val sel = select(minTokPerSec, recommendation, preferred)
                if (sel is ModelSelection.Rejected) return@withLock Ready.Failure(sel.reason)
                sel as ModelSelection.Selected
                val t0 = System.nanoTime()
                try {
                    engine.load(sel.engineModelId, opts.onDownloadProgress)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Mark it as unusable on this device so selection skips it, then try the next one.
                    setBench(benchKey(key, sel.spec.id), BenchmarkResult(sel.spec.id, 0.0, -1, System.currentTimeMillis()))
                    return@repeat
                }
                val loadMs = msSince(t0)
                val bk = benchKey(key, sel.spec.id)
                var bench = getBench(bk)
                if (bench == null) {
                    val r = engine.generate(GenerateRequest(messages = BENCHMARK_MESSAGES, maxTokens = BENCHMARK_TOKENS, temperature = 0.0, disableThinking = true))
                    bench = BenchmarkResult(sel.spec.id, r.decodeTokPerSec, r.ttftMs, System.currentTimeMillis())
                    setBench(bk, bench)
                }
                if (bench.decodeTokPerSec < minTokPerSec) {
                    engine.unload()
                    return@repeat
                }
                loaded = Loaded(sel.spec, sel.engineModelId, loadMs)
                return@withLock Ready.Ok(sel.spec, sel.engineModelId)
            }
            Ready.Failure(FallbackReason.BENCHMARK_SLOW)
        }
    }

    private sealed interface DeviceRun {
        data class Ok(val data: kotlinx.serialization.json.JsonElement, val tokensIn: Int, val tokensOut: Int, val decodeTokPerSec: Double, val repaired: Boolean) : DeviceRun
        data class Failed(val reason: FallbackReason, val issues: List<SchemaIssue> = emptyList(), val raw: String = "") : DeviceRun
    }

    private suspend fun runOnDevice(task: TaskConfig, jsonSchema: JsonObject, text: String, spec: ModelSpec): DeviceRun {
        val engine = textEngine()
        val messages = buildExtractMessages(task, jsonSchema, text)
        suspend fun gen(msgs: List<ChatMessage>): GenerateResult? = withTimeoutOrNull(opts.timeoutMs) {
            engine.generate(
                GenerateRequest(
                    messages = msgs,
                    jsonSchema = jsonSchema,
                    maxTokens = task.maxTokens,
                    temperature = task.temperature,
                    disableThinking = spec.disableThinking,
                ),
            )
        }
        return try {
            val first = gen(messages) ?: return DeviceRun.Failed(FallbackReason.TIMEOUT)
            val p1 = parseModelOutput(jsonSchema, first.text)
            if (p1 is ParseOutcome.Ok) {
                return DeviceRun.Ok(p1.data, first.promptTokens, first.completionTokens, first.decodeTokPerSec, repaired = false)
            }
            p1 as ParseOutcome.Failed
            val second = gen(messages + ChatMessage.assistant(first.text) + ChatMessage.user(repairMessage(p1.error)))
                ?: return DeviceRun.Failed(FallbackReason.TIMEOUT)
            when (val p2 = parseModelOutput(jsonSchema, second.text)) {
                is ParseOutcome.Ok -> DeviceRun.Ok(
                    p2.data,
                    first.promptTokens + second.promptTokens,
                    first.completionTokens + second.completionTokens,
                    second.decodeTokPerSec,
                    repaired = true,
                )
                is ParseOutcome.Failed -> DeviceRun.Failed(FallbackReason.SCHEMA_FAILED_AFTER_REPAIR, p2.issues, second.text)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            DeviceRun.Failed(FallbackReason.ENGINE_ERROR)
        }
    }

    private suspend fun loadTask(slug: String): Pair<TaskConfig, DeviceRecommendation?> {
        localTasks[slug]?.let { return it.complete(slug) to null }
        val source = opts.taskSource ?: throw TaskNotFoundException(slug)
        return source.fetch(slug, device().second) ?: throw TaskNotFoundException(slug)
    }

    private fun failureMeta(task: TaskConfig, t0: Long, reason: FallbackReason) = ExtractMeta(
        modelId = loaded?.spec?.id ?: "none",
        runtime = RuntimeUsed.DEVICE,
        taskVersion = task.version,
        latencyMs = msSince(t0),
        tokensIn = 0,
        tokensOut = 0,
        estimatedSavingsUsd = 0.0,
        fallbackReason = reason,
    )

    private suspend fun record(task: TaskConfig, meta: ExtractMeta, outcome: String, decodeTokPerSec: Double? = null) {
        val sink = opts.telemetry ?: return
        if (!consent.telemetry) return
        val (profile, key) = device()
        sink.record(
            TelemetryEvent(
                ts = System.currentTimeMillis(),
                task = task.slug,
                taskVersion = task.version,
                runtime = if (outcome == "unavailable" || outcome == "schema_error") "none" else meta.runtime.wire,
                modelId = meta.modelId,
                deviceKey = key,
                platform = profile.platform.wire,
                latencyMs = meta.latencyMs,
                loadMs = loaded?.loadMs,
                decodeTokPerSec = decodeTokPerSec,
                tokensIn = meta.tokensIn,
                tokensOut = meta.tokensOut,
                outcome = outcome,
                fallbackReason = meta.fallbackReason?.wire,
                repaired = meta.repaired.takeIf { it },
                sdkVersion = platform.sdkVersion,
            ),
        )
    }

    private fun warnOnSchemaDrift(task: TaskConfig, jsonSchema: JsonObject) {
        val published = task.jsonSchema ?: return
        if (task.slug in warnedSchemas) return
        if (canonical(published) != canonical(jsonSchema)) {
            warnedSchemas += task.slug
            System.err.println("[benatif] The schema in code for task \"${task.slug}\" differs from the published one. The code schema is used.")
        }
    }

    private fun canonical(e: kotlinx.serialization.json.JsonElement): String = when (e) {
        is JsonObject -> e.keys.sorted().joinToString(",", "{", "}") { "${JsonPrimitive(it)}:${canonical(e.getValue(it))}" }
        is JsonArray -> e.joinToString(",", "[", "]") { canonical(it) }
        else -> e.toString()
    }
}

private fun msSince(t0: Long) = (System.nanoTime() - t0) / 1_000_000

/** Creates the client over a platform adapter (Android: use `Natif.create(context, options)`). */
fun createCoreClient(opts: ClientOptions, platform: PlatformAdapter): NatifClient = NatifClient(opts, platform)
