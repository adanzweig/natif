import Foundation

public struct LlamaEngineOptions: Sendable {
    /// Context window in tokens. Larger = longer chats, more memory. Default 4096 (same as React Native).
    public var contextTokens: Int
    /// Layers offloaded to the GPU (Metal). Default 99 = all; 0 forces CPU. The simulator always uses CPU.
    public var gpuLayers: Int
    /// Prompt tokens evaluated per `llama_decode` call.
    public var batchSize: Int
    /// CPU threads (default: up to 4).
    public var threads: Int?
    /// Constrain `extract`/`classify` output with a GBNF grammar built from the JSON Schema.
    public var constrainJSON: Bool
    /// Where GGUF files are stored (default Application Support/natif-models).
    public var files: ModelFiles
    /// Download transport (default URLSession with resume data).
    public var transport: (any DownloadTransport)?

    public init(contextTokens: Int = 4096, gpuLayers: Int = 99, batchSize: Int = 512, threads: Int? = nil,
                constrainJSON: Bool = true, files: ModelFiles = ModelFiles(), transport: (any DownloadTransport)? = nil) {
        self.contextTokens = contextTokens
        self.gpuLayers = gpuLayers
        self.batchSize = batchSize
        self.threads = threads
        self.constrainJSON = constrainJSON
        self.files = files
        self.transport = transport
    }
}

/// Engine model id for a GGUF URL: the file name without ".gguf" (same rule as React Native).
public func ggufModelId(_ spec: ModelSpec) -> String? {
    guard let s = spec.runtimes.gguf?.url, let last = s.split(separator: "/").last else { return nil }
    var id = String(last)
    if id.lowercased().hasSuffix(".gguf") { id.removeLast(5) }
    return id
}

final class LockedMap<V: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var map: [String: V] = [:]
    subscript(key: String) -> V? {
        get { lock.withLock { map[key] } }
        set { lock.withLock { map[key] = newValue } }
    }
}

final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isCancelled: Bool { lock.withLock { value } }
    func cancel() { lock.withLock { value = true } }
}

/// Splits bytes into the longest valid-UTF-8-so-far prefix and an incomplete tail (≤ 3 bytes),
/// so streamed tokens never cut a multi-byte character in half.
func splitCompleteUTF8(_ bytes: [UInt8]) -> (complete: [UInt8], rest: [UInt8]) {
    var i = bytes.count - 1
    var back = 0
    while i >= 0 && back < 4 {
        let b = bytes[i]
        if b & 0xC0 != 0x80 { // lead byte or ASCII
            let need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1
            if bytes.count - i < need { return (Array(bytes[..<i]), Array(bytes[i...])) }
            return (bytes, [])
        }
        i -= 1
        back += 1
    }
    return (bytes, [])
}

#if canImport(llama)
import llama

/// Runs GGUF models with llama.cpp (Metal). Downloads each model once into Application Support.
public actor LlamaEngine: TextEngine {
    public nonisolated let name = "llama.cpp"
    public nonisolated var supportsDownload: Bool { true }

    private nonisolated let urls = LockedMap<URL>()
    private let options: LlamaEngineOptions
    private let downloader: ModelDownloader
    private var session: LlamaSession?
    private var loadedId: String?

    public init(options: LlamaEngineOptions = LlamaEngineOptions()) {
        self.options = options
        downloader = ModelDownloader(files: options.files, transport: options.transport ?? URLSessionDownloadTransport())
    }

    public nonisolated func resolveModelId(_ spec: ModelSpec, device: DeviceProfile) -> String? {
        guard let id = ggufModelId(spec), let s = spec.runtimes.gguf?.url, let url = URL(string: s) else { return nil }
        urls[id] = url
        return id
    }

    public func isCached(_ engineModelId: String) async -> Bool {
        options.files.isComplete(engineModelId)
    }

    /// Model file on disk, downloading it if needed. Only complete files count as cached.
    private func ensureFile(_ id: String, onProgress: ProgressHandler?) async throws -> URL {
        if options.files.isComplete(id) { return options.files.file(id) }
        guard let url = urls[id] else { throw NatifError.engine("LlamaEngine: unknown model \(id)") }
        return try await downloader.ensure(id: id, url: url, onProgress: onProgress)
    }

    /// Download only (e.g. on Wi-Fi during onboarding); `load` then just maps the file.
    public func download(_ engineModelId: String, onProgress: ProgressHandler?) async throws {
        _ = try await ensureFile(engineModelId, onProgress: onProgress)
        onProgress?(LoadProgress(modelId: engineModelId, progress: 1, phase: .ready, text: "downloaded"))
    }

    public func load(_ engineModelId: String, onProgress: ProgressHandler?) async throws {
        if loadedId == engineModelId, session != nil { return }
        await unload()
        let file = try await ensureFile(engineModelId, onProgress: onProgress)
        session = try await LlamaSession.load(path: file.path, options: options) { p in
            onProgress?(LoadProgress(modelId: engineModelId, progress: p, phase: .compile))
        }
        loadedId = engineModelId
        onProgress?(LoadProgress(modelId: engineModelId, progress: 1, phase: .ready))
    }

    public func generate(_ request: GenerateRequest) async throws -> GenerateResult {
        guard let session else { throw NatifError.engine("LlamaEngine: no model loaded") }
        return try await session.generate(request, constrainJSON: options.constrainJSON)
    }

    public func unload() async {
        let s = session
        session = nil
        loadedId = nil
        await s?.close()
    }

    /// Deletes a downloaded model file (frees storage).
    public func deleteModel(_ engineModelId: String) async throws {
        if loadedId == engineModelId { await unload() }
        let fm = FileManager.default
        for u in [options.files.file(engineModelId), options.files.partFile(engineModelId), options.files.resumeFile(engineModelId)] {
            try? fm.removeItem(at: u)
        }
    }
}

enum LlamaBackend {
    static let ready: Bool = {
        llama_backend_init()
        // Keep the console quiet: only errors.
        llama_log_set({ level, text, _ in
            if level == GGML_LOG_LEVEL_ERROR, let text { fputs(String(cString: text), stderr) }
        }, nil)
        return true
    }()
    static func ensure() { _ = ready }
}

private final class ProgressBox {
    let call: @Sendable (Double) -> Void
    init(_ call: @escaping @Sendable (Double) -> Void) { self.call = call }
}

/// One loaded model + context. Every llama.cpp call runs on a private serial queue, off the
/// Swift cooperative pool.
final class LlamaSession: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.benatif.llama", qos: .userInitiated)
    private let model: OpaquePointer
    private let ctx: OpaquePointer
    private let vocab: OpaquePointer
    private let template: String?
    private let batchSize: Int
    /// Tokens currently in the KV cache (sequence 0), to reuse the common prefix across calls.
    private var cachedTokens: [llama_token] = []
    private var closed = false

    private init(model: OpaquePointer, ctx: OpaquePointer, batchSize: Int) {
        self.model = model
        self.ctx = ctx
        vocab = llama_model_get_vocab(model)
        template = llama_model_chat_template(model, nil).map { String(cString: $0) }
        self.batchSize = batchSize
    }

    static func load(path: String, options: LlamaEngineOptions, onProgress: @escaping @Sendable (Double) -> Void) async throws -> LlamaSession {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                LlamaBackend.ensure()
                var mp = llama_model_default_params()
                #if targetEnvironment(simulator)
                mp.n_gpu_layers = 0
                #else
                mp.n_gpu_layers = Int32(options.gpuLayers)
                #endif
                let box = Unmanaged.passRetained(ProgressBox(onProgress))
                mp.progress_callback = { p, ud in
                    if let ud { Unmanaged<ProgressBox>.fromOpaque(ud).takeUnretainedValue().call(Double(p)) }
                    return true
                }
                mp.progress_callback_user_data = box.toOpaque()
                let model = llama_model_load_from_file(path, mp)
                box.release()
                guard let model else {
                    cont.resume(throwing: NatifError.engine("llama.cpp could not load \(path)"))
                    return
                }
                var cp = llama_context_default_params()
                cp.n_ctx = UInt32(options.contextTokens)
                cp.n_batch = UInt32(options.batchSize)
                let threads = Int32(options.threads ?? max(1, min(4, ProcessInfo.processInfo.activeProcessorCount - 2)))
                cp.n_threads = threads
                cp.n_threads_batch = threads
                guard let ctx = llama_init_from_model(model, cp) else {
                    llama_model_free(model)
                    cont.resume(throwing: NatifError.engine("llama.cpp could not create a context (out of memory?)"))
                    return
                }
                cont.resume(returning: LlamaSession(model: model, ctx: ctx, batchSize: options.batchSize))
            }
        }
    }

    func close() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            queue.async {
                if !self.closed {
                    self.closed = true
                    llama_free(self.ctx)
                    llama_model_free(self.model)
                }
                cont.resume()
            }
        }
    }

    func generate(_ req: GenerateRequest, constrainJSON: Bool) async throws -> GenerateResult {
        let flag = CancelFlag()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<GenerateResult, any Error>) in
                queue.async {
                    cont.resume(with: Result { try self.generateSync(req, constrainJSON: constrainJSON, cancel: flag) })
                }
            }
        } onCancel: {
            flag.cancel()
        }
    }

    // MARK: - On the queue

    private func resetCache() {
        llama_memory_clear(llama_get_memory(ctx), true)
        cachedTokens = []
    }

    private func formatPrompt(_ messages: [ChatMessage]) -> String {
        guard let template else { return chatML(messages) }
        var cStrings: [UnsafeMutablePointer<CChar>] = []
        defer { cStrings.forEach { free($0) } }
        var chat: [llama_chat_message] = messages.map { m in
            let role = strdup(m.role.rawValue)!
            let content = strdup(m.content)!
            cStrings += [role, content]
            return llama_chat_message(role: role, content: content)
        }
        var capacity = max(4096, 2 * messages.reduce(0) { $0 + $1.content.utf8.count })
        for _ in 0..<2 {
            var buf = [CChar](repeating: 0, count: capacity)
            let n = template.withCString { llama_chat_apply_template($0, &chat, chat.count, true, &buf, Int32(capacity)) }
            if n < 0 { return chatML(messages) } // template not supported by llama_chat_apply_template
            if Int(n) <= capacity {
                return String(decoding: buf[0..<Int(n)].map { UInt8(bitPattern: $0) }, as: UTF8.self)
            }
            capacity = Int(n) + 1
        }
        return chatML(messages)
    }

    private func chatML(_ messages: [ChatMessage]) -> String {
        messages.map { "<|im_start|>\($0.role.rawValue)\n\($0.content)<|im_end|>\n" }.joined() + "<|im_start|>assistant\n"
    }

    private func piece(_ token: llama_token, special: Bool) -> [UInt8] {
        var buf = [CChar](repeating: 0, count: 64)
        var n = llama_token_to_piece(vocab, token, &buf, Int32(buf.count), 0, special)
        if n < 0 {
            buf = [CChar](repeating: 0, count: Int(-n))
            n = llama_token_to_piece(vocab, token, &buf, Int32(buf.count), 0, special)
        }
        return n > 0 ? buf[0..<Int(n)].map { UInt8(bitPattern: $0) } : []
    }

    private func tokenize(_ text: String) -> [llama_token] {
        // Don't add BOS when the chat template already wrote it as text.
        let bos = llama_vocab_bos(vocab)
        let bosText = bos >= 0 ? String(decoding: piece(bos, special: true), as: UTF8.self) : ""
        let addSpecial = bosText.isEmpty || !text.hasPrefix(bosText)
        let count = text.utf8.count
        var tokens = [llama_token](repeating: 0, count: count + 8)
        var n = llama_tokenize(vocab, text, Int32(count), &tokens, Int32(tokens.count), addSpecial, true)
        if n < 0 {
            tokens = [llama_token](repeating: 0, count: Int(-n))
            n = llama_tokenize(vocab, text, Int32(count), &tokens, Int32(tokens.count), addSpecial, true)
        }
        return Array(tokens.prefix(max(0, Int(n))))
    }

    private func decode(_ tokens: ArraySlice<llama_token>) -> Int32 {
        var chunk = Array(tokens)
        return chunk.withUnsafeMutableBufferPointer { buf in
            llama_decode(ctx, llama_batch_get_one(buf.baseAddress, Int32(buf.count)))
        }
    }

    private func generateSync(_ req: GenerateRequest, constrainJSON: Bool, cancel: CancelFlag) throws -> GenerateResult {
        guard !closed else { throw NatifError.engine("LlamaEngine: model was unloaded") }
        let t0 = DispatchTime.now()
        var prompt = formatPrompt(req.messages)
        // Qwen3's template adds an empty think block when enable_thinking=false; do the same.
        if req.disableThinking, let template, template.contains("<think>") || template.contains("enable_thinking") {
            prompt += "<think>\n\n</think>\n\n"
        }
        let tokens = tokenize(prompt)
        let nCtx = Int(llama_n_ctx(ctx))
        guard !tokens.isEmpty else { throw NatifError.engine("LlamaEngine: empty prompt") }
        guard tokens.count < nCtx else {
            throw NatifError.engine("LlamaEngine: prompt has \(tokens.count) tokens but the context holds \(nCtx); shorten the history or raise contextTokens")
        }

        // Reuse the KV cache for the common prefix (system prompt + earlier turns).
        let mem = llama_get_memory(ctx)
        var common = 0
        let limit = min(cachedTokens.count, tokens.count)
        while common < limit && cachedTokens[common] == tokens[common] { common += 1 }
        if common == tokens.count { common -= 1 } // need logits for the last prompt token
        if common < cachedTokens.count {
            if !llama_memory_seq_rm(mem, 0, Int32(common), -1) {
                llama_memory_clear(mem, true)
                common = 0
            }
            cachedTokens.removeSubrange(common...)
        }
        let reused = common

        llama_set_abort_callback(ctx, { ud in
            guard let ud else { return false }
            return Unmanaged<CancelFlag>.fromOpaque(ud).takeUnretainedValue().isCancelled
        }, Unmanaged.passUnretained(cancel).toOpaque())
        defer { llama_set_abort_callback(ctx, nil, nil) }

        var i = common
        while i < tokens.count {
            if cancel.isCancelled { resetCache(); throw CancellationError() }
            let n = min(batchSize, tokens.count - i)
            let rc = decode(tokens[i..<(i + n)])
            if rc != 0 {
                resetCache()
                if cancel.isCancelled { throw CancellationError() }
                throw NatifError.engine("llama_decode failed on the prompt (\(rc))")
            }
            cachedTokens += tokens[i..<(i + n)]
            i += n
        }

        guard let chain = llama_sampler_chain_init(llama_sampler_chain_default_params()) else {
            throw NatifError.engine("LlamaEngine: could not create the sampler")
        }
        defer { llama_sampler_free(chain) }
        if constrainJSON, let schema = req.jsonSchema {
            let grammar = JSONSchemaGrammar.gbnf(for: schema)
            if let g = llama_sampler_init_grammar(vocab, grammar, "root") {
                llama_sampler_chain_add(chain, g)
            }
            // nil = grammar didn't parse: fall back to prompt + validation + repair.
        }
        if req.temperature <= 0 {
            llama_sampler_chain_add(chain, llama_sampler_init_greedy())
        } else {
            llama_sampler_chain_add(chain, llama_sampler_init_top_k(40))
            llama_sampler_chain_add(chain, llama_sampler_init_top_p(0.95, 1))
            llama_sampler_chain_add(chain, llama_sampler_init_min_p(0.05, 1))
            llama_sampler_chain_add(chain, llama_sampler_init_temp(Float(req.temperature)))
            llama_sampler_chain_add(chain, llama_sampler_init_dist(UInt32.random(in: 0...UInt32.max)))
        }

        let maxGen = min(req.maxTokens, nCtx - tokens.count)
        var output: [UInt8] = []
        var pending: [UInt8] = []
        var generated = 0
        var tFirst: DispatchTime?
        while generated < maxGen {
            if cancel.isCancelled { resetCache(); throw CancellationError() }
            let token = llama_sampler_sample(chain, ctx, -1)
            if llama_vocab_is_eog(vocab, token) { break }
            if tFirst == nil { tFirst = .now() }
            generated += 1
            let bytes = piece(token, special: false)
            output += bytes
            if let onToken = req.onToken {
                pending += bytes
                let (complete, rest) = splitCompleteUTF8(pending)
                pending = rest
                if !complete.isEmpty { onToken(String(decoding: complete, as: UTF8.self)) }
            }
            if generated >= maxGen { break }
            var t = token
            let rc = withUnsafeMutablePointer(to: &t) { llama_decode(ctx, llama_batch_get_one($0, 1)) }
            if rc != 0 {
                resetCache()
                if cancel.isCancelled { throw CancellationError() }
                throw NatifError.engine("llama_decode failed while generating (\(rc))")
            }
            cachedTokens.append(token)
        }
        if let onToken = req.onToken, !pending.isEmpty { onToken(String(decoding: pending, as: UTF8.self)) }

        let tEnd = DispatchTime.now()
        func ms(_ a: DispatchTime, _ b: DispatchTime) -> Double { Double(b.uptimeNanoseconds - a.uptimeNanoseconds) / 1e6 }
        let decodeMs = tFirst.map { ms($0, tEnd) } ?? 0
        return GenerateResult(
            text: String(decoding: output, as: UTF8.self),
            promptTokens: tokens.count,
            completionTokens: generated,
            ttftMs: tFirst.map { ms(t0, $0) } ?? ms(t0, tEnd),
            totalMs: ms(t0, tEnd),
            decodeTokPerSec: generated > 1 && decodeMs > 0 ? Double(generated - 1) / (decodeMs / 1000) : 0,
            cachedTokens: reused
        )
    }
}
#endif
