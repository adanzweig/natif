import Foundation
import Testing
@testable import Natif

private let checkIn: JSONValue = [
    "type": "object",
    "properties": [
        "mood": ["type": "integer", "minimum": 1, "maximum": 10],
        "energy": ["type": "integer", "minimum": 1, "maximum": 10],
        "stress": ["type": "integer", "minimum": 1, "maximum": 10],
        "emotions": ["maxItems": 5, "type": "array", "items": ["type": "string"]],
    ],
    "required": ["mood", "energy", "stress", "emotions"],
    "additionalProperties": false,
]
private let VALID = #"{"mood":3,"energy":4,"stress":8,"emotions":["ansiedad"]}"#
private let input = "Dormí mal, mucha ansiedad por el trabajo."
private let tasks = ["daily-checkin": LocalTask(systemPrompt: "Puntuá el check-in.")]

@Suite struct ExtractTests {
    @Test func returnsDataAndMeta() async throws {
        let engine = MockEngine(reply: { _, _ in VALID })
        let ai = makeClient(engine) { $0.tasks = tasks }
        let r = try await ai.extractWithMeta(text: input, schema: checkIn, task: "daily-checkin")
        #expect(r.data == (try JSONValue(parsing: VALID)))
        #expect(r.meta.runtime == .device && r.meta.modelId == "qwen3-4b" && r.meta.tokensIn == 100 && r.meta.tokensOut == 20)
        #expect(r.meta.estimatedSavingsUsd > 0)
        let call = await engine.schemaCalls.first!
        #expect(call.temperature == 0)
        #expect(call.disableThinking == true)
        #expect(call.messages[1].content == input)
        #expect(call.messages[0].content.hasSuffix("Answer only with a JSON object that follows this JSON Schema:\n\(checkIn.jsonString)"))
    }

    @Test func repairsOnceWhenFirstAnswerIsInvalid() async throws {
        let engine = MockEngine(reply: { _, n in n == 1 ? #"{"mood":42}"# : VALID })
        let ai = makeClient(engine) { $0.tasks = tasks }
        let r = try await ai.extractWithMeta(text: input, schema: checkIn, task: "daily-checkin")
        #expect(r.meta.repaired == true)
        #expect(r.meta.tokensIn == 200)
        let repair = await engine.schemaCalls[1]
        #expect(repair.messages.count == 4)
        #expect(repair.messages[2] == .assistant(#"{"mood":42}"#))
        #expect(repair.messages[3].content.contains("not valid"))
        #expect(repair.messages[3].content.contains("Too big: expected number to be <=10"))
    }

    @Test func schemaFailsTwiceThrowsSchemaValidation() async throws {
        let ai = makeClient(MockEngine(reply: { _, _ in #"{"mood":99}"# })) { $0.tasks = tasks }
        await #expect {
            try await ai.extract(text: input, schema: checkIn, task: "daily-checkin")
        } throws: { e in
            guard case NatifError.schemaValidation(let issues, let raw) = e else { return false }
            return !issues.isEmpty && raw == #"{"mood":99}"#
        }
    }

    @Test func decodesIntoCodableType() async throws {
        struct CheckIn: Decodable, Sendable { let mood: Int; let stress: Int; let emotions: [String] }
        let ai = makeClient(MockEngine(reply: { _, _ in "```json\n\(VALID)\n```" }))
        let c = try await ai.extract(CheckIn.self, text: input, schema: checkIn)
        #expect(c.stress == 8 && c.emotions == ["ansiedad"])
    }

    @Test func dictionarySchemaOverload() async throws {
        let ai = makeClient(MockEngine(reply: { _, _ in #"{"ok":true}"# }))
        let v = try await ai.extract(text: "x", jsonSchema: ["type": "object", "properties": ["ok": ["type": "boolean"]], "required": ["ok"]])
        #expect(v == ["ok": true])
    }

    @Test func loadsAndBenchmarksOnceAcrossConcurrentCalls() async throws {
        let engine = MockEngine(reply: { _, _ in VALID })
        let ai = makeClient(engine) { $0.tasks = tasks }
        async let a = ai.extract(text: input, schema: checkIn, task: "daily-checkin")
        async let b = ai.extract(text: input, schema: checkIn, task: "daily-checkin")
        async let c = ai.extract(text: input, schema: checkIn, task: "daily-checkin")
        _ = try await (a, b, c)
        #expect(await engine.loads == ["Qwen3-4B-q4f16_1-MLC"])
        #expect(await engine.calls.filter { $0.jsonSchema == nil }.count == 1)
    }

    @Test func stepsDownWhenBenchmarkTooSlow() async throws {
        let engine = MockEngine(reply: { _, _ in VALID }, tokPerSec: ["Qwen3-4B-q4f16_1-MLC": 3])
        let ai = makeClient(engine) { $0.tasks = tasks }
        let r = try await ai.extractWithMeta(text: input, schema: checkIn, task: "daily-checkin")
        #expect(r.meta.modelId == "gemma-4-e2b")
        #expect(await engine.loads == ["Qwen3-4B-q4f16_1-MLC", "gemma-4-E2B-it-q4f16_1-MLC"])
    }

    @Test func stepsDownWhenLoadFails() async throws {
        let engine = MockEngine(reply: { _, _ in VALID })
        await engine.setFailLoad(["Qwen3-4B-q4f16_1-MLC"])
        let ai = makeClient(engine) { $0.tasks = tasks }
        #expect(try await ai.extractWithMeta(text: input, schema: checkIn, task: "daily-checkin").meta.modelId == "gemma-4-e2b")
    }

    @Test func noWebGPUWithoutConsentThrowsAndNoCloud() async throws {
        var d = highEndWeb; d.gpu = .init(available: false)
        let engine = MockEngine()
        let ai = makeClient(engine, device: d) { $0.tasks = tasks }
        await #expect {
            try await ai.extract(text: input, schema: checkIn, task: "daily-checkin")
        } throws: { ($0 as? NatifError)?.reason == .noWebgpu }
        #expect(await engine.loads.isEmpty)
    }

    @Test func consentButNoCloudProviderStillReportsDeviceReason() async throws {
        var d = highEndWeb; d.gpu = .init(available: false)
        let ai = makeClient(MockEngine(), device: d) { $0.tasks = tasks; $0.consent = Consent(cloudFallback: true) }
        await #expect {
            try await ai.extract(text: input, schema: checkIn, task: "daily-checkin")
        } throws: { e in
            guard case NatifError.deviceUnavailable(let r, let detail) = e else { return false }
            return r == .noWebgpu && detail?.contains("not available") == true
        }
    }

    @Test func cloudSeamIsUsedWhenProvided() async throws {
        struct FakeCloud: CloudFallbackProvider {
            func extract(task: TaskConfig, text: String, jsonSchema: JSONValue) async throws -> CloudExtractResponse {
                CloudExtractResponse(data: try JSONValue(parsing: VALID), model: "cloud-model", inputTokens: 300, outputTokens: 30)
            }
        }
        var d = highEndWeb; d.gpu = .init(available: false)
        let ai = makeClient(MockEngine(), device: d) { $0.tasks = tasks; $0.consent = Consent(cloudFallback: true); $0.cloudFallback = FakeCloud() }
        let r = try await ai.extractWithMeta(text: input, schema: checkIn, task: "daily-checkin")
        #expect(r.meta.runtime == .cloud && r.meta.fallbackReason == .noWebgpu && r.meta.estimatedSavingsUsd == 0)
    }

    @Test func deviceOnlyTaskNeverReachesCloud() async throws {
        var d = highEndWeb; d.gpu = .init(available: false)
        let ai = makeClient(MockEngine(), device: d) {
            $0.tasks = ["daily-checkin": LocalTask(systemPrompt: "x", deviceOnly: true)]
            $0.consent = Consent(cloudFallback: true)
        }
        await #expect { try await ai.extract(text: input, schema: checkIn, task: "daily-checkin") } throws: { ($0 as? NatifError)?.reason == .noWebgpu }
    }

    @Test func engineTimeout() async throws {
        let engine = MockEngine(reply: { _, _ in VALID })
        await engine.setOverride { req in
            if req.jsonSchema != nil { try await Task.sleep(for: .seconds(3600)) }
            return GenerateResult(text: "x", promptTokens: 1, completionTokens: 1, ttftMs: 1, totalMs: 1, decodeTokPerSec: 40)
        }
        let ai = makeClient(engine) { $0.tasks = tasks; $0.timeout = .milliseconds(20) }
        await #expect { try await ai.extract(text: input, schema: checkIn, task: "daily-checkin") } throws: { ($0 as? NatifError)?.reason == .timeout }
    }

    @Test func unknownTask() async {
        let ai = makeClient(MockEngine())
        await #expect { try await ai.extract(text: "x", schema: [:], task: "nope") } throws: { e in
            if case NatifError.taskNotFound("nope") = e { return true }
            return false
        }
    }

    @Test func telemetrySeamGetsMetadataOnlyWithConsent() async throws {
        actor Sink: TelemetrySink {
            var events: [TelemetryEvent] = []
            func record(_ event: TelemetryEvent) { events.append(event) }
        }
        let sink = Sink()
        let ai = makeClient(MockEngine(reply: { _, _ in VALID })) { $0.tasks = tasks; $0.telemetry = sink; $0.consent = Consent(telemetry: true) }
        _ = try await ai.extract(text: input, schema: checkIn, task: "daily-checkin")
        let events = await sink.events
        #expect(events.count == 1 && events[0].modelId == "qwen3-4b" && events[0].outcome == "ok")
        let encoded = String(decoding: try JSONEncoder().encode(events), as: UTF8.self)
        #expect(!encoded.contains("ansiedad"))
        let silent = Sink()
        let ai2 = makeClient(MockEngine(reply: { _, _ in VALID })) { $0.tasks = tasks; $0.telemetry = silent }
        _ = try await ai2.extract(text: input, schema: checkIn, task: "daily-checkin")
        #expect(await silent.events.isEmpty)
    }
}

@Suite struct ClassifyTests {
    @Test func picksOneLabelWithEnumSchema() async throws {
        let engine = MockEngine(reply: { _, _ in #"{"label":"billing"}"# })
        let ai = makeClient(engine)
        let r = try await ai.classify(text: "I was charged twice", labels: ["billing", "bug", "feature"])
        #expect(r.label == "billing" && r.meta.runtime == .device)
        let call = await engine.schemaCalls.first!
        #expect(call.jsonSchema!.jsonString.contains(#""enum":["billing","bug","feature"]"#))
        #expect(call.messages.last!.content == "Labels: billing | bug | feature\nText: I was charged twice")
        #expect(call.maxTokens == 40)
    }

    @Test func rejectsLabelOutsideListAndBadInput() async {
        let ai = makeClient(MockEngine(reply: { _, _ in #"{"label":"spam"}"# }))
        await #expect(throws: NatifError.self) { try await ai.classify(text: "hi", labels: ["a", "b"]) }
        await #expect { try await ai.classify(text: "hi", labels: ["only", " only "]) } throws: { "\($0.localizedDescription)".contains("2 labels") }
    }
}

@Suite struct ChatTests {
    @Test func streamsHidesThinkAndReturnsHistory() async throws {
        let engine = MockEngine()
        await engine.setOverride { req in
            for d in ["<think>hmm</think>", "Hola", ", ¿cómo", " estás?"] { req.onToken?(d) }
            return GenerateResult(text: "<think>hmm</think>Hola, ¿cómo estás?", promptTokens: 30, completionTokens: 6, ttftMs: 40, totalMs: 200, decodeTokPerSec: 40, cachedTokens: 12)
        }
        let ai = makeClient(engine)
        let seen = Box<[String]>([])
        let history: [ChatMessage] = [.assistant("¡Buenas!")]
        let r = try await ai.chat(ChatRequest(message: "hola", history: history, system: "Sé amable") { d in seen.mutate { $0.append(d) } })
        #expect(seen.value.joined() == "Hola, ¿cómo estás?")
        #expect(await engine.calls.last!.messages == [.system("Sé amable")] + history + [.user("hola")])
        #expect(r.history == history + [.user("hola"), .assistant("Hola, ¿cómo estás?")])
        #expect(r.meta.runtime == .device && r.meta.cachedTokens == 12 && r.meta.droppedMessages == 0)
        #expect(r.text == "Hola, ¿cómo estás?")
    }

    @Test func throwsWithoutWebGPU() async {
        var d = highEndWeb; d.gpu = .init(available: false)
        let ai = makeClient(MockEngine(), device: d)
        await #expect { try await ai.chat(ChatRequest(message: "hola")) } throws: { "\($0.localizedDescription)".contains("no_webgpu") }
    }

    @Test func trimsLongHistory() async throws {
        let engine = MockEngine()
        let ai = makeClient(engine)
        let history = (0..<30).map { ChatMessage(role: $0 % 2 == 1 ? .assistant : .user, content: "\($0)") }
        let r = try await ai.chat(ChatRequest(message: "next", history: history))
        #expect(r.meta.droppedMessages > 0)
        #expect(r.history.count == 32) // returned history keeps everything
        #expect(await engine.calls.last!.messages.count == 30 - r.meta.droppedMessages + 1)
    }
}

@Suite struct LifecycleTests {
    @Test func idleUnloadAndReload() async throws {
        let engine = MockEngine(reply: { _, _ in VALID })
        let ai = makeClient(engine) { $0.tasks = tasks; $0.idleUnloadAfter = .milliseconds(30) }
        _ = try await ai.extract(text: input, schema: checkIn, task: "daily-checkin")
        #expect(await engine.current != nil)
        try await Task.sleep(for: .milliseconds(150))
        #expect(await engine.current == nil)
        _ = try await ai.extract(text: input, schema: checkIn, task: "daily-checkin")
        #expect(await engine.loads.count == 2)
    }

    @Test func eagerPreloadLoadsAtInit() async throws {
        let engine = MockEngine()
        _ = makeClient(engine) { $0.preload = .eager }
        try await Task.sleep(for: .milliseconds(100))
        #expect(await engine.loads.count == 1)
    }

    @Test func capabilitiesWithoutDownloading() async {
        let engine = MockEngine()
        let ai = makeClient(engine)
        let report = await ai.capabilities()
        #expect(report.text == .available(modelId: "qwen3-4b", tier: .high, cached: false))
        #expect(report.deviceKey == "bb6f863a7cafa596ee10aca5")
        #expect(await engine.loads.isEmpty)
    }

    @Test func downloadReportsUnsupportedEngineForMock() async throws {
        let ai = makeClient(MockEngine())
        #expect(try await ai.download() == .unsupportedEngine)
        var d = highEndWeb; d.memoryGB = 1
        #expect(try await makeClient(MockEngine(), device: d).download() == .unavailable(.insufficientMemory))
    }
}
