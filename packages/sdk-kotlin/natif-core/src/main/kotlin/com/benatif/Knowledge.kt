package com.benatif

import java.text.Normalizer
import java.util.Locale
import kotlin.math.ln

// Port of packages/sdk-core/src/knowledge.ts, with the same chunking, ranking and prompt strings,
// so grounded answers behave the same on every platform.
//   docs     — a few documents passed inline; ranked locally by keyword overlap (no embeddings)
//   retrieve — the app's existing search / vector DB; we only pass the question and use the result
// The retrieved passages go into the *last user turn*, not the system prompt, so the system prompt
// and earlier turns stay byte-identical and the engine's prefix cache keeps working.

data class KnowledgeChunk(
    val text: String,
    /** Stable id. Blank ids from `retrieve` become "r1", "r2"… like plain strings do in TS. */
    val id: String = "",
    val title: String? = null,
    val url: String? = null,
    val score: Double? = null,
)

data class KnowledgeDoc(val text: String, val id: String? = null, val title: String? = null, val url: String? = null)

data class KnowledgeOptions(
    val docs: List<KnowledgeDoc> = emptyList(),
    /** Your own retrieval (Pinecone, pgvector, Algolia, an internal API…): (query, topK) → best passages. */
    val retrieve: (suspend (query: String, topK: Int) -> List<KnowledgeChunk>)? = null,
    /** Passages per question (default 4). */
    val topK: Int = 4,
    /** Budget for passages in the prompt, in characters (default 6000 ≈ 1500 tokens). */
    val maxContextChars: Int = 6000,
)

/**
 * OFF    — knowledge is not used
 * PREFER — use the sources when relevant, cite them, otherwise answer normally
 * STRICT — answer only from the sources; say so when they don't contain the answer
 */
enum class Grounding(val wire: String) { OFF("off"), PREFER("prefer"), STRICT("strict") }

data class Source(
    /** 1-based number the model cites as [n]. */
    val n: Int,
    val id: String,
    val title: String?,
    val url: String?,
    val snippet: String,
    /** True when the answer cites this source. */
    val cited: Boolean,
)

private const val CHUNK_CHARS = 900
private val STOP: Set<String> =
    ("a al algo como con de del el en es esta este la las lo los mas me mi no o para pero por que se si sin su sus te tu un una y yo " +
        "the a an and are as at be by for from has have how i in is it of on or that the this to was what when where which who why will with you your")
        .split(" ").toSet()

private val DIACRITICS = Regex("\\p{Mn}+")
private val NON_WORD = Regex("[^\\p{L}\\p{N}]+")
private val PARAGRAPH = Regex("\\n\\s*\\n")

private fun norm(s: String) = DIACRITICS.replace(Normalizer.normalize(s.lowercase(Locale.ROOT), Normalizer.Form.NFD), "")

fun tokenize(s: String): List<String> = norm(s).split(NON_WORD).filter { it.length > 1 && it !in STOP }

/** Split documents into ~900-char chunks on paragraph boundaries. */
fun chunkDocs(docs: List<KnowledgeDoc>): List<KnowledgeChunk> {
    val out = mutableListOf<KnowledgeChunk>()
    docs.forEachIndexed { di, doc ->
        val base = doc.id ?: "doc${di + 1}"
        var buf = ""
        var part = 0
        fun flush() {
            if (buf.isNotBlank()) out += KnowledgeChunk(id = "$base#${++part}", text = buf.trim(), title = doc.title, url = doc.url)
            buf = ""
        }
        for (para in doc.text.split(PARAGRAPH)) {
            if (buf.isNotEmpty() && buf.length + para.length > CHUNK_CHARS) flush()
            if (para.length > CHUNK_CHARS) {
                var i = 0
                while (i < para.length) {
                    buf = para.substring(i, minOf(i + CHUNK_CHARS, para.length))
                    flush()
                    i += CHUNK_CHARS
                }
            } else {
                buf += (if (buf.isNotEmpty()) "\n\n" else "") + para
            }
        }
        flush()
    }
    return out
}

/** BM25 over the chunks. Good enough for FAQs and catalogs; bigger corpora should use `retrieve`. */
fun rankChunks(chunks: List<KnowledgeChunk>, query: String, topK: Int): List<KnowledgeChunk> {
    val q = tokenize(query).distinct()
    if (q.isEmpty() || chunks.isEmpty()) return emptyList()
    val docs = chunks.map { tokenize("${it.title ?: ""} ${it.text}") }
    val avg = docs.sumOf { it.size }.toDouble() / docs.size
    val df = q.associateWith { t -> docs.count { t in it } }
    val k1 = 1.2
    val b = 0.75
    return chunks
        .mapIndexed { i, c ->
            val d = docs[i]
            var score = 0.0
            for (t in q) {
                val f = d.count { it == t }
                if (f == 0) continue
                val n = df.getValue(t)
                val idf = ln(1 + (chunks.size - n + 0.5) / (n + 0.5))
                score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.size) / avg)))
            }
            c.copy(score = score)
        }
        .filter { it.score!! > 0 }
        .sortedByDescending { it.score }
        .take(topK)
}

class Knowledge(private val opts: KnowledgeOptions) {
    private val chunks = chunkDocs(opts.docs)
    private val allChars = chunks.sumOf { it.text.length }

    suspend fun find(query: String): List<KnowledgeChunk> {
        val topK = opts.topK
        val max = opts.maxContextChars
        // Few docs: send them all (ranking would only risk dropping the right one).
        val local = if (allChars <= max) chunks else rankChunks(chunks, query, topK)
        val remote = opts.retrieve?.invoke(query, topK)
            ?.mapIndexed { i, r -> if (r.id.isBlank()) r.copy(id = "r${i + 1}") else r }
            ?: emptyList()
        val seen = mutableSetOf<String>()
        val picked = mutableListOf<KnowledgeChunk>()
        var used = 0
        for (c in remote + local) {
            if (c.id in seen || c.text.isBlank()) continue
            if (used + c.text.length > max && picked.isNotEmpty()) break
            seen += c.id
            picked += c
            used += c.text.length
        }
        return picked
    }
}

private val RULES = mapOf(
    Grounding.STRICT to
        "Answer using ONLY the sources above. If they do not contain the answer, say that you don't have that information. Do not use outside knowledge. Cite the sources you use like [1]. Answer in the language of the question.",
    Grounding.PREFER to
        "Use the sources above when they are relevant and cite them like [1]. If they don't cover the question, answer normally. Answer in the language of the question.",
)

fun groundedMessage(question: String, chunks: List<KnowledgeChunk>, grounding: Grounding): String {
    require(grounding != Grounding.OFF) { "groundedMessage needs PREFER or STRICT" }
    val sources = if (chunks.isNotEmpty()) {
        chunks.mapIndexed { i, c -> "[${i + 1}]${if (c.title != null) " ${c.title}:" else ""} ${c.text}" }.joinToString("\n\n")
    } else {
        "(no sources found for this question)"
    }
    return "Sources:\n$sources\n\n${RULES.getValue(grounding)}\n\nQuestion: $question"
}

private val CITATION = Regex("\\[(\\d+)]")

fun toSources(chunks: List<KnowledgeChunk>, answer: String): List<Source> {
    val cited = CITATION.findAll(answer).mapNotNull { it.groupValues[1].toIntOrNull() }.toSet()
    return chunks.mapIndexed { i, c ->
        Source(
            n = i + 1,
            id = c.id,
            title = c.title,
            url = c.url,
            snippet = if (c.text.length > 200) "${c.text.substring(0, 200)}…" else c.text,
            cited = (i + 1) in cited,
        )
    }
}
