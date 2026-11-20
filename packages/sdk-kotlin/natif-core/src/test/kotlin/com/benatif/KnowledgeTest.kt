package com.benatif

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Same cases as packages/sdk-core/test/knowledge.test.ts.
class KnowledgeTest {
    private val catalog = """Aspirina 500 mg: alivia el dolor de cabeza y la fiebre. Adultos: 1 comprimido cada 6 horas.

Bepanthen crema: para la piel irritada y quemaduras leves.

Redoxon: vitamina C efervescente para reforzar defensas."""

    @Test fun `ranks the passage that matches the question first, with the same score as TS`() {
        assertTrue(chunkDocs(listOf(KnowledgeDoc(catalog, id = "cat"))).isNotEmpty())
        val small = chunkDocs(catalog.split("\n\n").mapIndexed { i, t -> KnowledgeDoc(t, id = "p$i") })
        val top = rankChunks(small, "¿Qué tomo para el dolor de cabeza?", 2)
        assertEquals("p0#1", top[0].id)
        assertEquals(1, top.size)
        // sdk-core rankChunks() returns 1.6285466842458856 for this query.
        assertEquals(1.6285466842458856, top[0].score!!, 1e-12)
    }

    @Test fun `tokenize strips accents and stop words`() =
        assertEquals(listOf("tomo", "dolor", "cabeza"), tokenize("¿Qué tomo para el dolor de cabeza?"))

    @Test fun `long paragraphs are split into 900-char chunks`() {
        val chunks = chunkDocs(listOf(KnowledgeDoc("x".repeat(2000))))
        assertEquals(listOf("doc1#1", "doc1#2", "doc1#3"), chunks.map { it.id })
        assertEquals(listOf(900, 900, 200), chunks.map { it.text.length })
    }

    @Test fun `puts sources in the last user turn, keeps history clean and returns citations`() = runTest {
        val engine = MockEngine()
        engine.generateOverride = { GenerateResult("Podés tomar Aspirina 500 mg [1].", 10, 5, 1, 2, 40.0) }
        val ai = client(engine, ClientOptions(idleUnloadMs = 0, knowledge = KnowledgeOptions(docs = listOf(KnowledgeDoc(catalog, id = "cat", title = "Catálogo"))), grounding = Grounding.STRICT))
        val r = ai.chat(ChatRequest(system = "Sos el asistente de la farmacia.", message = "¿Qué tomo para el dolor de cabeza?"))
        val sent = engine.calls.last().messages
        assertEquals(ChatMessage.system("Sos el asistente de la farmacia."), sent.first())
        assertTrue(sent.last().content.contains(Regex("Sources:\\n\\[1] Catálogo:")))
        assertTrue(sent.last().content.contains("ONLY the sources"))
        assertTrue(sent.last().content.endsWith("Question: ¿Qué tomo para el dolor de cabeza?"))
        assertEquals(ChatMessage.user("¿Qué tomo para el dolor de cabeza?"), r.history[r.history.size - 2])
        val s = r.sources!!.first()
        assertEquals(1, s.n)
        assertEquals("cat#1", s.id)
        assertTrue(s.cited)
    }

    @Test fun `calls the app's own retrieve and skips knowledge when grounding is off`() = runTest {
        val engine = MockEngine()
        engine.generateOverride = { GenerateResult("ok", 1, 1, 1, 1, 40.0) }
        val asked = mutableListOf<String>()
        val ai = client(engine, ClientOptions(idleUnloadMs = 0, knowledge = KnowledgeOptions(retrieve = { q, _ -> asked += q; listOf(KnowledgeChunk("Envíos gratis desde USD 50.")) })))
        val r = ai.chat(ChatRequest(message = "¿El envío es gratis?"))
        assertEquals(listOf("¿El envío es gratis?"), asked)
        assertTrue(engine.calls.last().messages.last().content.contains("[1] Envíos gratis"))
        assertTrue(engine.calls.last().messages.last().content.contains("cite them like [1]")) // PREFER by default
        assertEquals(1, r.sources!!.size)
        assertEquals("r1", r.sources!!.first().id)
        assertEquals(false, r.sources!!.first().cited)
        val r2 = ai.chat(ChatRequest(message = "hola", grounding = Grounding.OFF))
        assertEquals(1, asked.size)
        assertEquals("hola", engine.calls.last().messages.last().content)
        assertEquals(null, r2.sources)
    }

    @Test fun `no sources found is said explicitly`() =
        assertTrue(groundedMessage("q", emptyList(), Grounding.STRICT).startsWith("Sources:\n(no sources found for this question)\n\n"))
}
