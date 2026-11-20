package com.benatif

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// Cloud fallback, published tasks and telemetry are out of scope for the first Kotlin release.
// These interfaces are the seams where they plug in, with the same contract as sdk-core.

/**
 * Cloud fallback (TS: cloud.ts → POST {baseUrl}/v1/fallback/extract). Called only when the
 * runtime decision allows the cloud (consent, not device-only).
 * TODO(kotlin): ship an HTTP implementation once the backend routes are stable for native SDKs.
 */
interface CloudFallback {
    suspend fun extract(task: String, taskVersion: Int, text: String, jsonSchema: JsonObject): CloudExtractResponse
}

data class CloudExtractResponse(val data: JsonElement, val model: String, val inputTokens: Int, val outputTokens: Int)

/**
 * Published tasks from the dashboard (TS: tasks.ts → GET {baseUrl}/v1/tasks/:slug with an ETag
 * cache). Local tasks (ClientOptions.tasks) never reach it.
 * TODO(kotlin): HTTP + ETag implementation.
 */
interface TaskSource {
    /** Returns null when the task doesn't exist. */
    suspend fun fetch(slug: String, deviceKey: String): Pair<TaskConfig, DeviceRecommendation?>?
}

/** Anonymous performance event (metadata only, never input or output). Same fields as TS telemetry. */
data class TelemetryEvent(
    val ts: Long,
    val task: String,
    val taskVersion: Int,
    /** "device", "cloud" or "none". */
    val runtime: String,
    val modelId: String,
    val deviceKey: String,
    val platform: String,
    val latencyMs: Long,
    val loadMs: Long?,
    val decodeTokPerSec: Double?,
    val tokensIn: Int,
    val tokensOut: Int,
    val outcome: String,
    val fallbackReason: String?,
    val repaired: Boolean?,
    val sdkVersion: String,
)

/**
 * Receives telemetry events, only when the user consented (Consent.telemetry).
 * TODO(kotlin): batched HTTP transport to {baseUrl}/v1/telemetry like TelemetryQueue in TS.
 */
fun interface TelemetrySink {
    fun record(event: TelemetryEvent)
}
