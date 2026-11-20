import Testing
@testable import Natif

private let catalogText = """
Aspirina 500 mg: alivia el dolor de cabeza y la fiebre. Adultos: 1 comprimido cada 6 horas.

Bepanthen crema: para la piel irritada y quemaduras leves.

Redoxon: vitamina C efervescente para reforzar defensas.
"""

@Suite struct KnowledgeTests {
    @Test func ranksMatchingPassageFirst() {
        let small = chunkDocs(catalogText.components(separatedBy: "\n\n").enumerated().map { KnowledgeDoc(id: "p\($0)", text: $1) })
        #expect(chunkDocs([KnowledgeDoc(id: "cat", text: catalogText)]).count > 0)
        let top = rankChunks(small, query: "¿Qué tomo para el dolor de cabeza?", topK: 2)
        #expect(top.first?.id == "p0#1")
    }

    @Test func tokenizeStripsAccentsAndStopWords() {
        #expect(tokenize("¿Qué tomo para el DOLOR de cabeza?") == ["tomo", "dolor", "cabeza"])
    }

    @Test func chunksLongParagraphs() {
        let long = String(repeating: "a", count: 2000)
        let chunks = chunkDocs([KnowledgeDoc(text: long)])
        #expect(chunks.map(\.id) == ["doc1#1", "doc1#2", "doc1#3"])
        #expect(chunks.map { $0.text.count } == [900, 900, 200])
    }

    @Test func sourcesInLastUserTurnHistoryCleanAndCitations() async throws {
        let engine = MockEngine()
        await engine.setOverride { _ in GenerateResult(text: "Podés tomar Aspirina 500 mg [1].", promptTokens: 10, completionTokens: 5, ttftMs: 1, totalMs: 2, decodeTokPerSec: 40) }
        let ai = makeClient(engine) {
            $0.knowledge = KnowledgeOptions(docs: [KnowledgeDoc(id: "cat", title: "Catálogo", text: catalogText)])
            $0.grounding = .strict
        }
        let r = try await ai.chat(ChatRequest(message: "¿Qué tomo para el dolor de cabeza?", system: "Sos el asistente de la farmacia."))
        let sent = await engine.calls.last!.messages
        #expect(sent[0] == .system("Sos el asistente de la farmacia."))
        #expect(sent.last!.content.hasPrefix("Sources:\n[1] Catálogo:"))
        #expect(sent.last!.content.contains("ONLY the sources"))
        #expect(sent.last!.content.hasSuffix("\n\nQuestion: ¿Qué tomo para el dolor de cabeza?"))
        #expect(r.history[r.history.count - 2] == .user("¿Qué tomo para el dolor de cabeza?"))
        #expect(r.sources?.first?.n == 1)
        #expect(r.sources?.first?.id == "cat#1")
        #expect(r.sources?.first?.cited == true)
    }

    @Test func callsRetrieveAndSkipsWhenGroundingOff() async throws {
        let engine = MockEngine()
        await engine.setOverride { _ in GenerateResult(text: "ok", promptTokens: 1, completionTokens: 1, ttftMs: 1, totalMs: 1, decodeTokPerSec: 40) }
        let asked = Box<[String]>([])
        let ai = makeClient(engine) {
            $0.knowledge = KnowledgeOptions(retrieve: { q, _ in
                asked.mutate { $0.append(q) }
                return ["Envíos gratis desde USD 50."]
            })
        }
        let r = try await ai.chat(ChatRequest(message: "¿El envío es gratis?"))
        #expect(asked.value == ["¿El envío es gratis?"])
        #expect(await engine.calls.last!.messages.last!.content.contains("[1] Envíos gratis"))
        #expect(r.sources?.count == 1)
        #expect(r.sources?.first?.id == "r1")
        _ = try await ai.chat(ChatRequest(message: "hola", grounding: .off))
        #expect(asked.value.count == 1)
        #expect(await engine.calls.last!.messages.last!.content == "hola")
    }

    @Test func preferRuleAndNoSources() {
        let m = groundedMessage("q", chunks: [], grounding: .prefer)
        #expect(m == "Sources:\n(no sources found for this question)\n\nUse the sources above when they are relevant and cite them like [1]. If they don't cover the question, answer normally. Answer in the language of the question.\n\nQuestion: q")
    }
}
