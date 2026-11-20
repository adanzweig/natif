package com.benatif

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/** Selection constants, generated from sdk-core/src/selection.ts into contract/catalog.json. */
data class SelectionConstants(
    val storageHeadroom: Double = 1.2,
    /** Share of *available* memory a model may take (native platforms report it). */
    val availableMemoryShare: Double = 0.6,
    /** Share of *total* memory when available memory is unknown. */
    val totalMemoryShare: Double = 0.5,
    /** Max budget when free memory is unknown. */
    val unknownFreeMemoryCapMB: Double = 4096.0,
)

/**
 * The model catalog. Loaded at runtime from the `com/benatif/catalog.json` resource, which the
 * build copies from packages/sdk-core/contract/catalog.json (generated from TypeScript).
 */
data class ModelCatalog(val version: Int, val constants: SelectionConstants, val models: List<ModelSpec>) {
    fun find(id: String): ModelSpec? = models.firstOrNull { it.id == id }

    companion object {
        const val RESOURCE = "/com/benatif/catalog.json"

        /** The catalog bundled with the SDK. */
        val default: ModelCatalog by lazy {
            val stream = ModelCatalog::class.java.getResourceAsStream(RESOURCE)
                ?: error("benatif: $RESOURCE missing from the classpath (build should copy it from sdk-core/contract)")
            stream.bufferedReader(Charsets.UTF_8).use { parse(it.readText()) }
        }

        fun parse(json: String): ModelCatalog {
            val root = Json.parseToJsonElement(json).jsonObject
            val c = root["constants"]?.jsonObject
            val d = SelectionConstants()
            val constants = SelectionConstants(
                storageHeadroom = c?.num("STORAGE_HEADROOM") ?: d.storageHeadroom,
                availableMemoryShare = c?.num("AVAILABLE_MEMORY_SHARE") ?: d.availableMemoryShare,
                totalMemoryShare = c?.num("TOTAL_MEMORY_SHARE") ?: d.totalMemoryShare,
                unknownFreeMemoryCapMB = c?.num("UNKNOWN_FREE_MEMORY_CAP_MB") ?: d.unknownFreeMemoryCapMB,
            )
            val models = root["models"]!!.jsonArray.map { parseModel(it.jsonObject) }
            return ModelCatalog(root["version"]?.jsonPrimitive?.int ?: 1, constants, models)
        }

        private fun JsonObject.num(key: String) = this[key]?.jsonPrimitive?.double

        private fun parseModel(o: JsonObject): ModelSpec {
            val rt = o["runtimes"]?.jsonObject
            val web = rt?.get("webllm")?.jsonObject
            val gguf = rt?.get("gguf")?.jsonObject
            return ModelSpec(
                id = o["id"]!!.jsonPrimitive.content,
                family = o["family"]!!.jsonPrimitive.content,
                capabilities = o["capabilities"]!!.jsonArray.mapNotNull { Capability.fromWire(it.jsonPrimitive.content) },
                tier = if (o["tier"]!!.jsonPrimitive.content == "high") ModelTier.HIGH else ModelTier.LOW,
                license = o["license"]!!.jsonPrimitive.content,
                downloadBytes = o["downloadBytes"]!!.jsonPrimitive.double.toLong(),
                memoryRequiredMB = o["memoryRequiredMB"]!!.jsonPrimitive.int,
                runtimes = ModelRuntimes(
                    webllm = web?.let { WebLlmRuntime(it["f16"]!!.jsonPrimitive.content, it["f32"]?.jsonPrimitive?.content) },
                    gguf = gguf?.let { GgufRuntime(it["url"]!!.jsonPrimitive.content) },
                ),
                quality = o["quality"]!!.jsonPrimitive.int,
                disableThinking = o["disableThinking"]?.jsonPrimitive?.booleanOrNull ?: false,
            )
        }
    }
}
