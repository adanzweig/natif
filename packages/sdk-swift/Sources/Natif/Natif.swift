import Foundation

public let NATIF_SDK_VERSION = "0.1.0"

public struct NatifOptions: Sendable {
    public enum Preload: Sendable { case lazy, eager }

    public var runtime: RuntimeMode
    public var consent: Consent
    /// `.eager` downloads, loads and benchmarks the model at init; `.lazy` waits for the first call.
    public var preload: Preload
    /// Tasks defined in code (TS `tasks`). Backend-published tasks are not fetched yet by the Swift SDK.
    public var tasks: [String: LocalTask]
    /// Your own knowledge for `chat`: inline docs and/or your retrieval. benatif never stores it.
    public var knowledge: KnowledgeOptions?
    /// How strictly `chat` sticks to `knowledge` (default `.prefer` when knowledge is set).
    public var grounding: Grounding?
    public var catalog: ModelCatalog
    public var priceReference: PriceReference
    /// Device inference slower than this is abandoned (`timeout` reason).
    public var timeout: Duration
    /// Max memory (MB) a model may take. Default: 60% of what the OS says the app can use.
    public var memoryBudgetMB: Double?
    /// Free the model from RAM/GPU after this long without use. Default 2 min; nil = never.
    public var idleUnloadAfter: Duration?
    /// Free the model when the app goes to the background (iOS kills big background apps). Default true.
    public var unloadOnBackground: Bool
    public var onDownloadProgress: ProgressHandler?
    /// llama.cpp settings for the default engine.
    public var llama: LlamaEngineOptions

    // Injection points (tests, custom engines, future cloud/telemetry).
    public var engine: (any TextEngine)?
    public var detectDevice: (@Sendable () async -> DeviceProfile)?
    public var storage: (any KeyValueStore)?
    /// Seam: no default implementation yet (see `CloudFallbackProvider`).
    public var cloudFallback: (any CloudFallbackProvider)?
    /// Seam: no default implementation yet (see `TelemetrySink`).
    public var telemetry: (any TelemetrySink)?

    public init(runtime: RuntimeMode = .auto, consent: Consent = Consent(), preload: Preload = .lazy,
                tasks: [String: LocalTask] = [:], knowledge: KnowledgeOptions? = nil, grounding: Grounding? = nil,
                catalog: ModelCatalog = .bundled, priceReference: PriceReference = .default, timeout: Duration = .seconds(60),
                memoryBudgetMB: Double? = nil, idleUnloadAfter: Duration? = .seconds(120), unloadOnBackground: Bool = true,
                onDownloadProgress: ProgressHandler? = nil, llama: LlamaEngineOptions = LlamaEngineOptions(),
                engine: (any TextEngine)? = nil, detectDevice: (@Sendable () async -> DeviceProfile)? = nil,
                storage: (any KeyValueStore)? = nil, cloudFallback: (any CloudFallbackProvider)? = nil,
                telemetry: (any TelemetrySink)? = nil) {
        self.runtime = runtime
        self.consent = consent
        self.preload = preload
        self.tasks = tasks
        self.knowledge = knowledge
        self.grounding = grounding
        self.catalog = catalog
        self.priceReference = priceReference
        self.timeout = timeout
        self.memoryBudgetMB = memoryBudgetMB
        self.idleUnloadAfter = idleUnloadAfter
        self.unloadOnBackground = unloadOnBackground
        self.onDownloadProgress = onDownloadProgress
        self.llama = llama
        self.engine = engine
        self.detectDevice = detectDevice
        self.storage = storage
        self.cloudFallback = cloudFallback
        self.telemetry = telemetry
    }
}

struct TimeoutError: Error {}

func withTimeout<T: Sendable>(_ limit: Duration, _ op: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await op() }
        group.addTask {
            try await Task.sleep(for: limit)
            throw TimeoutError()
        }
        defer { group.cancelAll() }
        return try await group.next()!
    }
}

/// Hides `<think>…</think>` from streamed tokens (same rule as TS).
private final class ThinkFilter: @unchecked Sendable {
    private let lock = NSLock()
    private var filtering = false
    private let forward: TokenHandler
    init(_ forward: @escaping TokenHandler) { self.forward = forward }
    func handle(_ d: String) {
        let pass: Bool = lock.withLock {
            if d.contains("<think>") { filtering = true }
            if filtering {
                if d.contains("</think>") { filtering = false }
                return false
            }
            return true
        }
        if pass { forward(d) }
    }
}

private struct Clock {
    let start = ContinuousClock.now
    var elapsedMs: Double {
        let d = ContinuousClock.now - start
        return Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15
    }
}

private func nowEpochMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// On-device AI by task: ask for `chat`, `extract` or `classify`, and the SDK picks the local model
/// that fits this device (same API and semantics as the web / React Native SDKs).
public actor Natif {
    private enum LoadOutcome: Sendable {
        case ready(ModelSpec, String)
        case failure(FallbackReason)
    }
    private struct Loaded { let spec: ModelSpec; let engineModelId: String; let loadMs: Double }
    private enum DeviceRun {
        case ok(data: JSONValue, tokensIn: Int, tokensOut: Int, decodeTokPerSec: Double, repaired: Bool)
        case failed(FallbackReason, issues: [SchemaIssue]?, raw: String?)
    }

    private let opts: NatifOptions
    private var consent: Consent
    private let catalog: [ModelSpec]
    private let constants: SelectionConstants
    private let tasks: [String: LocalTask]
    private let knowledge: Knowledge?
    private let storage: any KeyValueStore
    private let engine: any TextEngine
    private var deviceInfo: (profile: DeviceProfile, key: String)?
    private var loaded: Loaded?
    private var loading: Task<LoadOutcome, Never>?
    private var idleTask: Task<Void, Never>?
    private var inFlight = 0
    private nonisolated(unsafe) var backgroundObserver: (any NSObjectProtocol)?

    public init(_ options: NatifOptions = NatifOptions()) {
        opts = options
        consent = options.consent
        catalog = options.catalog.models
        constants = options.catalog.constants
        tasks = BUILTIN_TASKS.merging(options.tasks) { _, app in app }
        knowledge = options.knowledge.map(Knowledge.init)
        storage = options.storage ?? UserDefaultsStore()
        #if canImport(llama)
        engine = options.engine ?? LlamaEngine(options: options.llama)
        #else
        engine = options.engine ?? UnavailableEngine()
        #endif
        #if os(iOS)
        if options.unloadOnBackground {
            // Raw name of UIApplication.didEnterBackgroundNotification (avoids a MainActor UIKit dependency).
            backgroundObserver = NotificationCenter.default.addObserver(
                forName: Notification.Name("UIApplicationDidEnterBackgroundNotification"), object: nil, queue: nil
            ) { [weak self] _ in
                Task { await self?.unload() }
            }
        }
        #endif
        if options.preload == .eager && options.runtime != .cloudOnly {
            // Strong capture on purpose: the preload finishes even if the caller drops the client early.
            Task { await self.preloadEagerly() }
        }
    }

    deinit {
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    }

    private func preloadEagerly() async { _ = await ensureTextModel(minTokPerSec: 8) }

    /// Update consent after the user answers (e.g. from a settings screen).
    public func setConsent(_ consent: Consent) { self.consent = consent }

    // MARK: - chat

    /// Conversation on the device, streamed through `onToken`. The app owns the history and passes
    /// it on every turn; the result returns the updated history.
    /// On-device only: throws `deviceUnavailable` when the device can't run a model.
    public func chat(_ req: ChatRequest) async throws -> ChatResult {
        let message = req.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { throw NatifError.invalidArgument("chat: message is required") }
        if opts.runtime == .cloudOnly { throw NatifError.deviceUnavailable(reason: .forcedCloud, detail: "chat runs on the device only") }
        let history = req.history.filter { $0.role != .system }
        let (kept, dropped) = trimHistory(history, max: req.maxHistoryMessages ?? 20)
        let clock = Clock()
        beginWork()
        defer { endWork() }

        let spec: ModelSpec
        switch await ensureTextModel(minTokPerSec: 4) {
        case .failure(let reason): throw NatifError.deviceUnavailable(reason: reason, detail: nil)
        case .ready(let s, _): spec = s
        }
        let user = ChatMessage.user(message)
        // Knowledge goes into this turn only; the returned history keeps the plain message.
        let grounding = req.grounding ?? opts.grounding ?? (knowledge != nil ? .prefer : .off)
        var chunks: [KnowledgeChunk]?
        var sent = user
        if let knowledge, grounding != .off {
            let found = try await knowledge.find(message)
            chunks = found
            sent = .user(groundedMessage(message, chunks: found, grounding: grounding))
        }
        var messages: [ChatMessage] = []
        if let system = req.system, !system.isEmpty { messages.append(.system(system)) }
        messages += kept
        messages.append(sent)

        var streamed: TokenHandler?
        if let forward = req.onToken {
            let filter = ThinkFilter(forward)
            streamed = { filter.handle($0) }
        }
        let request = GenerateRequest(
            messages: messages,
            maxTokens: req.maxTokens ?? 512,
            temperature: req.temperature ?? 0.7,
            disableThinking: spec.disableThinking ?? false,
            onToken: streamed
        )
        let r = try await engine.generate(request)
        let text = stripThink(r.text).trimmingCharacters(in: .whitespacesAndNewlines)
        return ChatResult(
            text: text,
            history: history + [user, .assistant(text)],
            meta: ChatMeta(
                modelId: spec.id, runtime: .device, latencyMs: Int(clock.elapsedMs.rounded()), ttftMs: r.ttftMs,
                tokensIn: r.promptTokens, tokensOut: r.completionTokens, decodeTokPerSec: r.decodeTokPerSec,
                estimatedSavingsUsd: estimateSavingsUsd(tokensIn: r.promptTokens, tokensOut: r.completionTokens, reference: opts.priceReference),
                cachedTokens: r.cachedTokens, droppedMessages: dropped),
            sources: chunks.map { toSources($0, answer: text) }
        )
    }

    // MARK: - classify

    /// Zero-shot classification on the device: picks exactly one of `labels` for `text`.
    /// Built on extract (same model choice, validation and fallback rules).
    public func classify(text: String, labels: [String], instructions: String? = nil) async throws -> ClassifyResult {
        var seen = Set<String>()
        let labels = labels.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && seen.insert($0).inserted }
        guard labels.count >= 2 else { throw NatifError.invalidArgument("classify: give at least 2 labels") }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { throw NatifError.invalidArgument("classify: text is required") }
        let schema: JSONValue = [
            "type": "object",
            "properties": ["label": ["type": "string", "enum": .array(labels.map(JSONValue.string))]],
            "required": ["label"],
            "additionalProperties": false,
        ]
        let prefix = (instructions?.isEmpty == false) ? "Instructions: \(instructions!)\n" : ""
        let input = "\(prefix)Labels: \(labels.joined(separator: " | "))\nText: \(body)"
        let r = try await extractWithMeta(text: input, schema: schema, task: CLASSIFY_TASK)
        guard let label = r.data["label"]?.stringValue else {
            throw NatifError.schemaValidation(issues: [], raw: r.data.jsonString)
        }
        return ClassifyResult(label: label, meta: r.meta)
    }

    // MARK: - extract

    /// Structured extraction: returns JSON that follows `schema` (a JSON Schema), validated, with
    /// one repair attempt. `task` names a task from `options.tasks` (default: a built-in generic one).
    public func extract(text: String, schema: JSONValue, task: String? = nil) async throws -> JSONValue {
        try await extractWithMeta(text: text, schema: schema, task: task).data
    }

    /// Same as `extract`, decoded into your own type.
    public func extract<T: Decodable & Sendable>(_ type: T.Type, text: String, schema: JSONValue, task: String? = nil) async throws -> T {
        let value = try await extract(text: text, schema: schema, task: task)
        do {
            return try value.decode(T.self)
        } catch {
            throw NatifError.schemaValidation(issues: [SchemaIssue(code: "decoding", message: "\(error)", path: [])], raw: value.jsonString)
        }
    }

    /// Same as `extract` with the schema as a Foundation dictionary (e.g. from JSONSerialization).
    public nonisolated func extract(text: String, jsonSchema: [String: Any], task: String? = nil) async throws -> JSONValue {
        let schema = try JSONValue(any: jsonSchema)
        return try await extract(text: text, schema: schema, task: task)
    }

    public func extractWithMeta(text rawText: String, schema: JSONValue, task slug: String? = nil) async throws -> ExtractResult<JSONValue> {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw NatifError.invalidArgument("extract: text is required") }
        let clock = Clock()
        let task = try taskConfig(slug ?? EXTRACT_TASK)

        var deviceFailure: FallbackReason?
        var failureIssues: [SchemaIssue]?
        var failureRaw: String?

        if opts.runtime != .cloudOnly {
            beginWork()
            defer { endWork() }
            switch await ensureTextModel(minTokPerSec: task.minDeviceTokPerSec, preferred: task.recommendedModel) {
            case .failure(let reason):
                deviceFailure = reason
            case .ready(let spec, _):
                switch try await runOnDevice(schema: schema, task: task, text: text, spec: spec) {
                case .ok(let data, let tin, let tout, let tps, let repaired):
                    let meta = ExtractMeta(
                        modelId: spec.id, runtime: .device, taskVersion: task.version, latencyMs: Int(clock.elapsedMs.rounded()),
                        tokensIn: tin, tokensOut: tout,
                        estimatedSavingsUsd: estimateSavingsUsd(tokensIn: tin, tokensOut: tout, reference: opts.priceReference),
                        fallbackReason: nil, repaired: repaired ? true : nil)
                    await record(task, meta, outcome: "ok", decodeTokPerSec: tps)
                    return ExtractResult(data: data, meta: meta)
                case .failed(let reason, let issues, let raw):
                    deviceFailure = reason
                    failureIssues = issues
                    failureRaw = raw
                }
            }
        }

        switch decideRuntime(mode: opts.runtime, consent: consent, taskDeviceOnly: task.deviceOnly, deviceFailure: deviceFailure) {
        case .device:
            throw NatifError.engine("unreachable")
        case .none(let reason):
            let meta = failureMeta(task, clock, reason)
            await record(task, meta, outcome: reason == .schemaFailedAfterRepair ? "schema_error" : "unavailable")
            if reason == .schemaFailedAfterRepair { throw NatifError.schemaValidation(issues: failureIssues ?? [], raw: failureRaw ?? "") }
            throw NatifError.deviceUnavailable(reason: reason, detail: consent.cloudFallback ? nil : "cloud fallback not consented")
        case .cloud(let reason):
            // TODO(cloud): default provider for {baseUrl}/v1/fallback/extract.
            guard let cloud = opts.cloudFallback else {
                throw NatifError.deviceUnavailable(reason: reason, detail: "cloud fallback is not available in the Swift SDK yet")
            }
            let res = try await cloud.extract(task: task, text: text, jsonSchema: schema)
            let (data, issues) = validateJSON(res.data, schema: schema)
            if !issues.isEmpty { throw NatifError.schemaValidation(issues: issues, raw: res.data.jsonString) }
            let meta = ExtractMeta(
                modelId: res.model, runtime: .cloud, taskVersion: task.version, latencyMs: Int(clock.elapsedMs.rounded()),
                tokensIn: res.inputTokens, tokensOut: res.outputTokens, estimatedSavingsUsd: 0, fallbackReason: reason, repaired: nil)
            await record(task, meta, outcome: "ok")
            return ExtractResult(data: data, meta: meta)
        }
    }

    // MARK: - prepare / download / capabilities / unload

    /// Download, load and benchmark ahead of time (e.g. during onboarding).
    @discardableResult
    public func prepare(task slug: String? = nil) async throws -> CapabilityReport {
        var min = 8.0
        var preferred: String?
        if let slug {
            let t = try taskConfig(slug)
            min = t.minDeviceTokPerSec
            preferred = t.recommendedModel
        }
        _ = await ensureTextModel(minTokPerSec: min, preferred: preferred)
        return await capabilities()
    }

    /// Download the model this device would use, without loading it into GPU/RAM. Resumes an
    /// interrupted download. Returns what was chosen, or why nothing was downloaded.
    @discardableResult
    public func download(onProgress: ProgressHandler? = nil) async throws -> DownloadOutcome {
        if opts.runtime == .cloudOnly { return .unavailable(.forcedCloud) }
        switch await select(minTokPerSec: 8) {
        case .unavailable(let reason, _):
            return .unavailable(reason)
        case .selected(let spec, let id, _):
            guard engine.supportsDownload else { return .unsupportedEngine }
            try await engine.download(id, onProgress: onProgress ?? opts.onDownloadProgress)
            return .downloaded(modelId: spec.id, engineModelId: id, downloadBytes: spec.downloadBytes)
        }
    }

    /// What this device can do, without downloading anything.
    public func capabilities() async -> CapabilityReport {
        let (profile, key) = await device()
        if let loaded {
            return CapabilityReport(device: profile, deviceKey: key, text: .available(modelId: loaded.spec.id, tier: loaded.spec.tier, cached: true))
        }
        switch await select(minTokPerSec: 8) {
        case .unavailable(let reason, _):
            return CapabilityReport(device: profile, deviceKey: key, text: .unavailable(reason))
        case .selected(let spec, let id, _):
            let cached = await engine.isCached(id)
            return CapabilityReport(device: profile, deviceKey: key, text: .available(modelId: spec.id, tier: spec.tier, cached: cached))
        }
    }

    /// Frees GPU/RAM (done automatically when an iOS app goes to the background). The model stays on disk.
    public func unload() async {
        idleTask?.cancel()
        idleTask = nil
        await engine.unload()
        loaded = nil
        loading = nil
    }

    /// Unloads and forgets benchmarks (models stay on disk).
    public func clearCache() async {
        await unload()
        await storage.clear()
    }

    // MARK: - Internals

    private func taskConfig(_ slug: String) throws -> TaskConfig {
        // TODO(backend): fetch published tasks from {baseUrl}/v1/tasks/{slug} with an ETag cache, like sdk-core TaskStore.
        guard let t = tasks[slug] else { throw NatifError.taskNotFound(slug) }
        return t.complete(slug: slug)
    }

    private func device() async -> (profile: DeviceProfile, key: String) {
        if let deviceInfo { return deviceInfo }
        let directory = opts.llama.files.directory
        let profile = await (opts.detectDevice ?? { AppleDevice.detect(storageDirectory: directory) })()
        let info = (profile, deviceKey(profile))
        deviceInfo = info
        return info
    }

    private func benchKey(_ deviceKey: String, _ modelId: String) -> String {
        "bench:\(deviceKey):\(modelId):\(NATIF_SDK_VERSION)"
    }

    private func select(minTokPerSec: Double, recommendation: DeviceRecommendation? = nil, preferred: String? = nil) async -> ModelSelection {
        let (profile, key) = await device()
        var benchmarks: [String: BenchmarkResult] = [:]
        var cached = Set<String>()
        for spec in catalog {
            if let b = await storage.get(BenchmarkResult.self, forKey: benchKey(key, spec.id)) { benchmarks[spec.id] = b }
            if let id = engine.resolveModelId(spec, device: profile), await engine.isCached(id) { cached.insert(id) }
        }
        let engine = self.engine
        return selectModel(SelectModelInput(
            device: profile, capability: .text, catalog: catalog, constants: constants,
            resolveModelId: { engine.resolveModelId($0, device: $1) },
            minDeviceTokPerSec: minTokPerSec, cached: cached, benchmarks: benchmarks,
            recommendation: recommendation, preferredModel: preferred, memoryBudgetMB: opts.memoryBudgetMB))
    }

    /// Single-flight: picks a model, loads it, benchmarks it once per device+model+SDK version,
    /// and steps down to the next candidate if the benchmark is too slow or loading fails.
    private func ensureTextModel(minTokPerSec: Double, recommendation: DeviceRecommendation? = nil, preferred: String? = nil) async -> LoadOutcome {
        if let loaded { return .ready(loaded.spec, loaded.engineModelId) }
        let task: Task<LoadOutcome, Never>
        if let loading {
            task = loading
        } else {
            task = Task { await self.loadBest(minTokPerSec: minTokPerSec, recommendation: recommendation, preferred: preferred) }
            loading = task
        }
        let outcome = await task.value
        // Allow a retry later (e.g. after freeing storage).
        if case .failure = outcome, loading == task { loading = nil }
        return outcome
    }

    private func loadBest(minTokPerSec: Double, recommendation: DeviceRecommendation?, preferred: String?) async -> LoadOutcome {
        let (_, key) = await device()
        for _ in 0..<max(1, catalog.count) {
            let selection = await select(minTokPerSec: minTokPerSec, recommendation: recommendation, preferred: preferred)
            guard case .selected(let spec, let id, _) = selection else { return .failure(selection.reason ?? .noModelForCapability) }
            let bk = benchKey(key, spec.id)
            let clock = Clock()
            do {
                try await engine.load(id, onProgress: opts.onDownloadProgress)
            } catch {
                // Mark it as unusable on this device so selection skips it, then try the next one.
                await storage.set(BenchmarkResult(modelId: spec.id, decodeTokPerSec: 0, ttftMs: -1, at: nowEpochMs()), forKey: bk)
                continue
            }
            let loadMs = clock.elapsedMs
            var bench = await storage.get(BenchmarkResult.self, forKey: bk)
            if bench == nil {
                do {
                    let r = try await engine.generate(GenerateRequest(messages: BENCHMARK_MESSAGES, maxTokens: 64, temperature: 0, disableThinking: true))
                    bench = BenchmarkResult(modelId: spec.id, decodeTokPerSec: r.decodeTokPerSec, ttftMs: r.ttftMs, at: nowEpochMs())
                } catch {
                    bench = BenchmarkResult(modelId: spec.id, decodeTokPerSec: 0, ttftMs: -1, at: nowEpochMs())
                }
                await storage.set(bench!, forKey: bk)
            }
            if bench!.decodeTokPerSec < minTokPerSec {
                await engine.unload()
                continue
            }
            loaded = Loaded(spec: spec, engineModelId: id, loadMs: loadMs)
            return .ready(spec, id)
        }
        return .failure(.benchmarkSlow)
    }

    private func runOnDevice(schema: JSONValue, task: TaskConfig, text: String, spec: ModelSpec) async throws -> DeviceRun {
        let engine = self.engine
        let timeout = opts.timeout
        let disableThinking = spec.disableThinking ?? false
        let messages = buildExtractMessages(task: task, jsonSchema: schema, text: text)
        let gen: @Sendable ([ChatMessage]) async throws -> GenerateResult = { msgs in
            try await withTimeout(timeout) {
                try await engine.generate(GenerateRequest(
                    messages: msgs, jsonSchema: schema, maxTokens: task.maxTokens,
                    temperature: task.temperature, disableThinking: disableThinking))
            }
        }
        do {
            let first = try await gen(messages)
            let errorText: String
            switch parseModelOutput(schema: schema, raw: first.text) {
            case .ok(let data):
                return .ok(data: data, tokensIn: first.promptTokens, tokensOut: first.completionTokens,
                           decodeTokPerSec: first.decodeTokPerSec, repaired: false)
            case .failed(let error, _):
                errorText = error
            }
            let second = try await gen(messages + [.assistant(first.text), .user(repairMessage(errorText))])
            switch parseModelOutput(schema: schema, raw: second.text) {
            case .ok(let data):
                return .ok(data: data, tokensIn: first.promptTokens + second.promptTokens,
                           tokensOut: first.completionTokens + second.completionTokens,
                           decodeTokPerSec: second.decodeTokPerSec, repaired: true)
            case .failed(_, let issues):
                return .failed(.schemaFailedAfterRepair, issues: issues, raw: second.text)
            }
        } catch {
            if Task.isCancelled || error is CancellationError { throw error }
            return .failed(error is TimeoutError ? .timeout : .engineError, issues: nil, raw: nil)
        }
    }

    private func failureMeta(_ task: TaskConfig, _ clock: Clock, _ reason: FallbackReason) -> ExtractMeta {
        ExtractMeta(modelId: loaded?.spec.id ?? "none", runtime: .device, taskVersion: task.version,
                    latencyMs: Int(clock.elapsedMs.rounded()), tokensIn: 0, tokensOut: 0, estimatedSavingsUsd: 0,
                    fallbackReason: reason, repaired: nil)
    }

    private func record(_ task: TaskConfig, _ meta: ExtractMeta, outcome: String, decodeTokPerSec: Double? = nil) async {
        guard consent.telemetry, let sink = opts.telemetry else { return }
        let (profile, key) = await device()
        await sink.record(TelemetryEvent(
            ts: nowEpochMs(), task: task.slug, taskVersion: task.version,
            runtime: outcome == "unavailable" || outcome == "schema_error" ? "none" : meta.runtime.rawValue,
            modelId: meta.modelId, deviceKey: key, platform: profile.platform.rawValue, latencyMs: meta.latencyMs,
            loadMs: loaded.map { Int($0.loadMs.rounded()) }, decodeTokPerSec: decodeTokPerSec,
            tokensIn: meta.tokensIn, tokensOut: meta.tokensOut, outcome: outcome,
            fallbackReason: meta.fallbackReason?.rawValue, repaired: meta.repaired, sdkVersion: NATIF_SDK_VERSION))
    }

    private func beginWork() {
        inFlight += 1
        idleTask?.cancel()
        idleTask = nil
    }

    private func endWork() {
        inFlight -= 1
        guard let after = opts.idleUnloadAfter, after > .zero, inFlight == 0 else { return }
        idleTask?.cancel()
        idleTask = Task { [weak self] in
            try? await Task.sleep(for: after)
            guard !Task.isCancelled else { return }
            await self?.idleFire()
        }
    }

    private func idleFire() async {
        if inFlight == 0 { await unload() }
    }
}

#if !canImport(llama)
/// Used only when llama.cpp isn't linked: every call reports that no model can run.
struct UnavailableEngine: TextEngine {
    let name = "unavailable"
    func resolveModelId(_ spec: ModelSpec, device: DeviceProfile) -> String? { nil }
    func isCached(_ engineModelId: String) async -> Bool { false }
    func load(_ engineModelId: String, onProgress: ProgressHandler?) async throws { throw NatifError.engine("llama.cpp is not linked") }
    func generate(_ request: GenerateRequest) async throws -> GenerateResult { throw NatifError.engine("llama.cpp is not linked") }
    func unload() async {}
}
#endif
