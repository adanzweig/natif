import Foundation

// Port of sdk-core `knowledge.ts` (same chunking, BM25 ranking and prompt strings), so grounded
// answers behave the same on every platform. Lengths are counted in UTF-16 code units like JS.
//
// Grounding answers in the app's own knowledge without benatif storing it:
//   docs     — a few documents passed inline; ranked locally by keyword overlap (no embeddings)
//   retrieve — the app's existing search / vector DB; we only pass the question and use the result
// The passages go into the *last user turn*, not the system prompt, so the system prompt and
// earlier turns stay byte-identical and the engine's prefix cache keeps working.

public struct KnowledgeChunk: Sendable, Equatable, ExpressibleByStringLiteral {
    /// Leave empty for passages from `retrieve`: they get "r1", "r2", … like strings do in TS.
    public var id: String
    public var text: String
    public var title: String?
    public var url: String?
    public var score: Double?

    public init(id: String = "", text: String, title: String? = nil, url: String? = nil, score: Double? = nil) {
        self.id = id
        self.text = text
        self.title = title
        self.url = url
        self.score = score
    }
    public init(stringLiteral value: String) { self.init(text: value) }
}

public struct KnowledgeDoc: Sendable, Equatable, ExpressibleByStringLiteral {
    public var id: String?
    public var title: String?
    public var url: String?
    public var text: String
    public init(id: String? = nil, title: String? = nil, url: String? = nil, text: String) {
        self.id = id
        self.title = title
        self.url = url
        self.text = text
    }
    public init(stringLiteral value: String) { self.init(text: value) }
}

/// Your own retrieval (Pinecone, pgvector, Algolia, an internal API…). Return the best passages.
/// Cancellation follows the calling Swift task.
public typealias KnowledgeRetrieve = @Sendable (_ query: String, _ topK: Int) async throws -> [KnowledgeChunk]

public struct KnowledgeOptions: Sendable {
    public var docs: [KnowledgeDoc]
    public var retrieve: KnowledgeRetrieve?
    /// Passages per question (default 4).
    public var topK: Int?
    /// Budget for passages in the prompt, in characters (default 6000 ≈ 1500 tokens).
    public var maxContextChars: Int?

    public init(docs: [KnowledgeDoc] = [], retrieve: KnowledgeRetrieve? = nil, topK: Int? = nil, maxContextChars: Int? = nil) {
        self.docs = docs
        self.retrieve = retrieve
        self.topK = topK
        self.maxContextChars = maxContextChars
    }
}

/// off    — knowledge is not used
/// prefer — use the sources when relevant, cite them, otherwise answer normally
/// strict — answer only from the sources; say so when they don't contain the answer
public enum Grounding: String, Sendable, Codable {
    case off, prefer, strict
}

public struct Source: Sendable, Equatable {
    /// 1-based number the model cites as [n].
    public var n: Int
    public var id: String
    public var title: String?
    public var url: String?
    public var snippet: String
    /// True when the answer cites this source.
    public var cited: Bool
}

private let CHUNK_CHARS = 900
private let STOP: Set<String> = Set(
    "a al algo como con de del el en es esta este la las lo los mas me mi no o para pero por que se si sin su sus te tu un una y yo the a an and are as at be by for from has have how i in is it of on or that the this to was what when where which who why will with you your"
        .split(separator: " ").map(String.init)
)

private extension String {
    var jsLength: Int { utf16.count }
    func jsSlice(_ from: Int, _ to: Int) -> String {
        let u = Array(utf16)
        let a = Swift.max(0, Swift.min(from, u.count)), b = Swift.max(a, Swift.min(to, u.count))
        return String(decoding: u[a..<b], as: UTF16.self)
    }
    var jsTrimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

private func norm(_ s: String) -> String {
    var out = String.UnicodeScalarView()
    for u in s.lowercased().decomposedStringWithCanonicalMapping.unicodeScalars where !u.properties.isDiacritic {
        out.append(u)
    }
    return String(out)
}

private func isLetterOrNumber(_ u: Unicode.Scalar) -> Bool {
    switch u.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
         .decimalNumber, .letterNumber, .otherNumber:
        return true
    default:
        return false
    }
}

/// Lowercase, strip accents, split on anything that isn't a letter or digit, drop stop words.
public func tokenize(_ s: String) -> [String] {
    var words: [String] = []
    var cur = String.UnicodeScalarView()
    func flush() {
        let w = String(cur)
        if w.jsLength > 1 && !STOP.contains(w) { words.append(w) }
        cur = String.UnicodeScalarView()
    }
    for u in norm(s).unicodeScalars {
        if isLetterOrNumber(u) { cur.append(u) } else { flush() }
    }
    flush()
    return words
}

private let paragraphBreak = try! NSRegularExpression(pattern: "\\n\\s*\\n")

private func splitParagraphs(_ text: String) -> [String] {
    let ns = text as NSString
    var parts: [String] = []
    var last = 0
    for m in paragraphBreak.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        parts.append(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
        last = m.range.location + m.range.length
    }
    parts.append(ns.substring(from: last))
    return parts
}

/// Split documents into ~900-char chunks on paragraph boundaries.
public func chunkDocs(_ docs: [KnowledgeDoc]) -> [KnowledgeChunk] {
    var out: [KnowledgeChunk] = []
    for (di, doc) in docs.enumerated() {
        let base = doc.id ?? "doc\(di + 1)"
        var buf = ""
        var part = 0
        func flush() {
            if !buf.jsTrimmed.isEmpty {
                part += 1
                out.append(KnowledgeChunk(id: "\(base)#\(part)", text: buf.jsTrimmed, title: doc.title, url: doc.url))
            }
            buf = ""
        }
        for para in splitParagraphs(doc.text) {
            if !buf.isEmpty && buf.jsLength + para.jsLength > CHUNK_CHARS { flush() }
            if para.jsLength > CHUNK_CHARS {
                var i = 0
                while i < para.jsLength {
                    buf = para.jsSlice(i, i + CHUNK_CHARS)
                    flush()
                    i += CHUNK_CHARS
                }
            } else {
                buf += (buf.isEmpty ? "" : "\n\n") + para
            }
        }
        flush()
    }
    return out
}

/// BM25 over the chunks. Good enough for FAQs and catalogs; bigger corpora should use `retrieve`.
public func rankChunks(_ chunks: [KnowledgeChunk], query: String, topK: Int) -> [KnowledgeChunk] {
    var seenQ = Set<String>()
    let q = tokenize(query).filter { seenQ.insert($0).inserted }
    if q.isEmpty || chunks.isEmpty { return [] }
    let docs = chunks.map { tokenize("\($0.title ?? "") \($0.text)") }
    let avg = Double(docs.reduce(0) { $0 + $1.count }) / Double(docs.count)
    var df: [String: Int] = [:]
    for t in q { df[t] = docs.filter { $0.contains(t) }.count }
    let k1 = 1.2, b = 0.75
    let n = Double(chunks.count)
    var scored: [(index: Int, chunk: KnowledgeChunk, score: Double)] = []
    for (i, c) in chunks.enumerated() {
        let d = docs[i]
        var score = 0.0
        for t in q {
            let f = Double(d.filter { $0 == t }.count)
            if f == 0 { continue }
            let dft = Double(df[t]!)
            let idf: Double = log(1 + (n - dft + 0.5) / (dft + 0.5))
            let lengthNorm: Double = 1 - b + (b * Double(d.count)) / avg
            let tf: Double = (f * (k1 + 1)) / (f + k1 * lengthNorm)
            score += idf * tf
        }
        if score > 0 {
            var c2 = c
            c2.score = score
            scored.append((i, c2, score))
        }
    }
    scored.sort { $0.score != $1.score ? $0.score > $1.score : $0.index < $1.index }
    return scored.prefix(topK).map(\.chunk)
}

public struct Knowledge: Sendable {
    private let opts: KnowledgeOptions
    private let chunks: [KnowledgeChunk]
    private let allChars: Int

    public init(_ opts: KnowledgeOptions) {
        self.opts = opts
        chunks = chunkDocs(opts.docs)
        allChars = chunks.reduce(0) { $0 + $1.text.jsLength }
    }

    public func find(_ query: String) async throws -> [KnowledgeChunk] {
        let topK = opts.topK ?? 4
        let max = opts.maxContextChars ?? 6000
        // Few docs: send them all (ranking would only risk dropping the right one).
        let local = allChars <= max ? chunks : rankChunks(chunks, query: query, topK: topK)
        var remote: [KnowledgeChunk] = []
        if let retrieve = opts.retrieve {
            remote = try await retrieve(query, topK).enumerated().map { i, r in
                var c = r
                if c.id.isEmpty { c.id = "r\(i + 1)" }
                return c
            }
        }
        var seen = Set<String>()
        var picked: [KnowledgeChunk] = []
        var used = 0
        for c in remote + local {
            if seen.contains(c.id) || c.text.jsTrimmed.isEmpty { continue }
            if used + c.text.jsLength > max && !picked.isEmpty { break }
            seen.insert(c.id)
            picked.append(c)
            used += c.text.jsLength
        }
        return picked
    }
}

private func rule(_ g: Grounding) -> String {
    switch g {
    case .strict:
        return "Answer using ONLY the sources above. If they do not contain the answer, say that you don't have that information. Do not use outside knowledge. Cite the sources you use like [1]. Answer in the language of the question."
    case .prefer, .off:
        return "Use the sources above when they are relevant and cite them like [1]. If they don't cover the question, answer normally. Answer in the language of the question."
    }
}

public func groundedMessage(_ question: String, chunks: [KnowledgeChunk], grounding: Grounding) -> String {
    let sources = chunks.isEmpty
        ? "(no sources found for this question)"
        : chunks.enumerated().map { i, c in "[\(i + 1)]\(c.title.map { " \($0):" } ?? "") \(c.text)" }.joined(separator: "\n\n")
    return "Sources:\n\(sources)\n\n\(rule(grounding))\n\nQuestion: \(question)"
}

private let citation = try! NSRegularExpression(pattern: "\\[([0-9]+)\\]")

public func toSources(_ chunks: [KnowledgeChunk], answer: String) -> [Source] {
    let ns = answer as NSString
    let cited = Set(citation.matches(in: answer, range: NSRange(location: 0, length: ns.length)).compactMap {
        Int(ns.substring(with: $0.range(at: 1)))
    })
    return chunks.enumerated().map { i, c in
        Source(n: i + 1, id: c.id, title: c.title, url: c.url,
               snippet: c.text.jsLength > 200 ? "\(c.text.jsSlice(0, 200))…" : c.text,
               cited: cited.contains(i + 1))
    }
}
