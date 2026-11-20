package com.benatif

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

// Ports of the applicable cases in packages/sdk-core/test/client.test.ts.
class ClientTest {
    private val checkIn = """{"type":"object","properties":{"mood":{"type":"integer","minimum":1,"maximum":10},"energy":{"type":"integer","minimum":1,"maximum":10},"stress":{"type":"integer","minimum":1,"maximum":10},"emotions":{"type":"array","items":{"type":"string"},"maxItems":5}},"required":["mood","energy","stress","emotions"],"additionalProperties":false}"""
    private val valid = """{"mood":3,"energy":4,"stress":8,"emotions":["ansiedad"]}"""
    private val tasks = mapOf("daily-checkin" to LocalTask(systemPrompt = "Puntuá el check-in."))
    private val input = "Dormí mal, mucha ansiedad por el trabajo."
    private val opts = ClientOptions(idleUnloadMs = 0, tasks = tasks)

    @Test fun `extract returns data and meta`() = runTest {
        val engine = MockEngine({ _, _ -> valid })
        val r = client(engine, opts).extractWithMeta(input, checkIn, task = "daily-checkin")
        assertEquals(3, r.data.jsonObject["mood"]!!.jsonPrimitive.int)
        assertEquals("ansiedad", r.data.jsonObject["emotions"]!!.jsonArray[0].jsonPrimitive.content)
        assertEquals(RuntimeUsed.DEVICE, r.meta.runtime)
        assertEquals("qwen3-4b", r.meta.modelId)
        assertEquals(100, r.meta.tokensIn)
        assertEquals(20, r.meta.tokensOut)
        assertTrue(r.meta.estimatedSavingsUsd > 0)
        assertEquals(false, r.meta.repaired)
        val call = engine.calls.first { it.jsonSchema != null }
        assertEquals(0.0, call.temperature)
        assertEquals(true, call.disableThinking)
        assertEquals(input, call.messages[1].content)
        assertTrue(call.messages[0].content.startsWith("Puntuá el check-in.\n\nAnswer only with a JSON object that follows this JSON Schema:\n{\"type\":\"object\""))
    }

    @Test fun `extract repairs once when the first answer is invalid`() = runTest {
        val engine = MockEngine({ _, n -> if (n == 1) """{"mood":42}""" else valid })
        val r = client(engine, opts).extractWithMeta(input, checkIn, task = "daily-checkin")
        assertEquals(true, r.meta.repaired)
        assertEquals(200, r.meta.tokensIn)
        val repair = engine.calls.filter { it.jsonSchema != null }[1]
        assertEquals(4, repair.messages.size)
        assertEquals(ChatMessage.assistant("""{"mood":42}"""), repair.messages[2])
        val msg = repair.messages.last().content
        assertTrue(msg.startsWith("Your previous answer was not valid for the required JSON schema:\n"), msg)
        assertTrue(msg.contains("Too big: expected number to be <=10\n  → at mood"), msg)
        assertTrue(msg.contains("→ at energy"), msg)
        assertTrue(msg.endsWith("Reply again with only the corrected JSON object."))
    }

    @Test fun `schema fails twice without consent gives SchemaValidationException`() = runTest {
        val engine = MockEngine({ _, _ -> "not json at all" })
        val e = assertFailsWith<SchemaValidationException> { client(engine, opts).extract(input, checkIn, task = "daily-checkin") }
        assertEquals("not json at all", e.raw)
        assertEquals(2, engine.calls.count { it.jsonSchema != null })
    }

    @Test fun `schema fails twice with consent but no cloud seam gives DeviceUnavailable`() = runTest {
        val engine = MockEngine({ _, _ -> "{}" })
        val e = assertFailsWith<DeviceUnavailableException> {
            client(engine, opts.copy(consent = Consent(cloudFallback = true))).extract(input, checkIn, task = "daily-checkin")
        }
        assertEquals(FallbackReason.SCHEMA_FAILED_AFTER_REPAIR, e.reason)
    }

    @Test fun `cloud seam is used when allowed`() = runTest {
        val engine = MockEngine({ _, _ -> "{}" })
        val cloud = object : CloudFallback {
            override suspend fun extract(task: String, taskVersion: Int, text: String, jsonSchema: kotlinx.serialization.json.JsonObject) =
                CloudExtractResponse(parseJsonSchema(valid), "claude-haiku-5-5", 300, 30)
        }
        val r = client(engine, opts.copy(consent = Consent(cloudFallback = true), cloudFallback = cloud)).extractWithMeta(input, checkIn, task = "daily-checkin")
        assertEquals(RuntimeUsed.CLOUD, r.meta.runtime)
        assertEquals(FallbackReason.SCHEMA_FAILED_AFTER_REPAIR, r.meta.fallbackReason)
    }

    @Test fun `extract parses JSON wrapped in think tags and code fences`() = runTest {
        val engine = MockEngine({ _, _ -> "<think>let me see {</think>Sure! ```json\n$valid\n``` done" })
        val r = client(engine, opts).extractWithMeta(input, checkIn, task = "daily-checkin")
        assertEquals(false, r.meta.repaired)
    }

    @Test fun `extract without a task uses the built-in extract task`() = runTest {
        val engine = MockEngine({ _, _ -> """{"name":"Ana"}""" })
        val data = client(engine).extract("Me llamo Ana", """{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}""")
        assertEquals("Ana", data.jsonObject["name"]!!.jsonPrimitive.content)
        assertTrue(engine.calls.last().messages[0].content.startsWith(BUILTIN_TASKS.getValue(EXTRACT_TASK).systemPrompt))
    }

    @Test fun `unknown task without a task source`() = runTest {
        assertFailsWith<TaskNotFoundException> { client(MockEngine()).extract("x", checkIn, task = "nope") }
    }

    @Test fun `steps down when the benchmark is too slow`() = runTest {
        val engine = MockEngine({ _, _ -> valid }, mutableMapOf("Qwen3-4B-q4f16_1-MLC" to 3.0))
        val r = client(engine, opts).extractWithMeta(input, checkIn, task = "daily-checkin")
        assertEquals("gemma-4-e2b", r.meta.modelId)
        assertEquals(listOf("Qwen3-4B-q4f16_1-MLC", "gemma-4-E2B-it-q4f16_1-MLC"), engine.loads)
    }

    @Test fun `steps down when a model fails to load`() = runTest {
        val engine = MockEngine({ _, _ -> valid })
        engine.failLoad += "Qwen3-4B-q4f16_1-MLC"
        val r = client(engine, opts).extractWithMeta(input, checkIn, task = "daily-checkin")
        assertEquals("gemma-4-e2b", r.meta.modelId)
    }

    @Test fun `loads and benchmarks only once across calls`() = runTest {
        val engine = MockEngine({ _, _ -> valid })
        val ai = client(engine, opts)
        repeat(3) { ai.extract(input, checkIn, task = "daily-checkin") }
        assertEquals(1, engine.loads.size)
        assertEquals(1, engine.calls.count { it.jsonSchema == null }) // one benchmark
    }

    @Test fun `engine timeout gives timeout reason`() = runTest {
        val engine = MockEngine()
        engine.generateOverride = { req ->
            if (req.jsonSchema != null) delay(10_000)
            GenerateResult("{}", 1, 1, 1, 1, 40.0)
        }
        val e = assertFailsWith<DeviceUnavailableException> { client(engine, opts.copy(timeoutMs = 50)).extract(input, checkIn, task = "daily-checkin") }
        assertEquals(FallbackReason.TIMEOUT, e.reason)
    }

    @Test fun `engine error gives engine_error`() = runTest {
        val engine = MockEngine({ _, _ -> throw IllegalStateException("boom") })
        val e = assertFailsWith<DeviceUnavailableException> { client(engine, opts).extract(input, checkIn, task = "daily-checkin") }
        assertEquals(FallbackReason.ENGINE_ERROR, e.reason)
    }

    @Test fun `no WebGPU without consent gives DeviceUnavailableException`() = runTest {
        val e = assertFailsWith<DeviceUnavailableException> {
            client(MockEngine(), opts, highEndWeb.copy(gpu = GpuInfo(false))).extract(input, checkIn, task = "daily-checkin")
        }
        assertEquals(FallbackReason.NO_WEBGPU, e.reason)
        assertTrue(e.message!!.contains("cloud fallback not consented"))
    }

    @Test fun `telemetry is sent only with consent and never contains content`() = runTest {
        val events = mutableListOf<TelemetryEvent>()
        val engine = MockEngine({ _, _ -> valid })
        client(engine, opts.copy(telemetry = { events += it })).extract(input, checkIn, task = "daily-checkin")
        assertEquals(0, events.size)
        client(engine, opts.copy(telemetry = { events += it }, consent = Consent(telemetry = true))).extract(input, checkIn, task = "daily-checkin")
        assertEquals(1, events.size)
        assertEquals("ok", events[0].outcome)
        assertTrue(!events[0].toString().contains("ansiedad"))
    }

    @Test fun `chat streams tokens, hides think tags and returns the updated history`() = runTest {
        val engine = MockEngine()
        var sent: List<ChatMessage>? = null
        engine.generateOverride = { req ->
            if (req.messages != BENCHMARK_MESSAGES) {
                sent = req.messages
                for (d in listOf("<think>hmm</think>", "Hola", ", ¿cómo", " estás?")) req.onToken?.invoke(d)
            }
            GenerateResult("<think>hmm</think>Hola, ¿cómo estás?", 30, 6, 40, 200, 40.0, cachedTokens = 12)
        }
        val seen = mutableListOf<String>()
        val history = listOf(ChatMessage.assistant("¡Buenas!"))
        val r = client(engine).chat(ChatRequest(system = "Sé amable", history = history, message = "hola", onToken = { seen += it }))
        assertEquals("Hola, ¿cómo estás?", seen.joinToString(""))
        assertEquals(listOf(ChatMessage.system("Sé amable")) + history + ChatMessage.user("hola"), sent)
        assertEquals(history + ChatMessage.user("hola") + ChatMessage.assistant("Hola, ¿cómo estás?"), r.history)
        assertEquals(RuntimeUsed.DEVICE, r.meta.runtime)
        assertEquals(12, r.meta.cachedTokens)
        assertEquals(0, r.meta.droppedMessages)
        assertEquals(null, r.sources)
    }

    @Test fun `chatFlow emits tokens then the result`() = runTest {
        val engine = MockEngine()
        engine.generateOverride = { req ->
            listOf("a", "b").forEach { req.onToken?.invoke(it) }
            GenerateResult("ab", 1, 2, 1, 1, 40.0)
        }
        val events = client(engine).chatFlow(ChatRequest(message = "hi")).toList()
        assertEquals(listOf(ChatEvent.Token("a"), ChatEvent.Token("b")), events.dropLast(1))
        assertEquals("ab", (events.last() as ChatEvent.Done).result.text)
    }

    @Test fun `chat without WebGPU throws DeviceUnavailableException`() = runTest {
        val e = assertFailsWith<DeviceUnavailableException> { client(MockEngine(), device = highEndWeb.copy(gpu = GpuInfo(false))).chat(ChatRequest(message = "hola")) }
        assertTrue(e.message!!.contains("no_webgpu"))
    }

    @Test fun `classify picks one label with a built-in task and an enum schema`() = runTest {
        val engine = MockEngine({ _, _ -> """{"label":"billing"}""" })
        val r = client(engine).classify("I was charged twice", listOf("billing", "bug", "feature"))
        assertEquals("billing", r.label)
        assertEquals(RuntimeUsed.DEVICE, r.meta.runtime)
        val call = engine.calls.first { it.jsonSchema != null }
        assertTrue(call.jsonSchema.toString().contains("\"enum\":[\"billing\",\"bug\",\"feature\"]"))
        assertEquals(40, call.maxTokens)
        assertTrue(call.messages.last().content.contains("Labels: billing | bug | feature"))
    }

    @Test fun `classify rejects a label outside the list and bad input`() = runTest {
        assertFailsWith<SchemaValidationException> { client(MockEngine({ _, _ -> """{"label":"spam"}""" })).classify("hi", listOf("a", "b")) }
        val e = assertFailsWith<IllegalArgumentException> { client(MockEngine()).classify("hi", listOf("only")) }
        assertTrue(e.message!!.contains("2 labels"))
    }

    @Test fun `capabilities and download`() = runTest {
        val engine = MockEngine()
        val ai = client(engine)
        val caps = ai.capabilities()
        assertEquals(TextCapability.Available("qwen3-4b", ModelTier.HIGH, cached = false), caps.text)
        assertEquals("bb6f863a7cafa596ee10aca5", caps.deviceKey)
        assertEquals(DownloadResult.Unavailable("unsupported_engine"), ai.download())
        ai.unload()
    }
}
