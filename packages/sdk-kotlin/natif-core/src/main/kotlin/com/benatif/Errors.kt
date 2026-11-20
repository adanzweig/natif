package com.benatif

import kotlinx.serialization.json.JsonElement

// Port of packages/sdk-core/src/errors.ts (Kotlin naming: *Exception instead of *Error).

open class NatifException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

/** The device can't run the task and the cloud is not allowed (no consent or device-only project). */
class DeviceUnavailableException(val reason: FallbackReason, detail: String? = null) :
    NatifException("On-device inference unavailable (${reason.wire})${if (detail != null) ": $detail" else ""}")

/** The model output didn't match the schema, even after one repair attempt. */
class SchemaValidationException(val issues: List<SchemaIssue>, val raw: String) :
    NatifException("Model output does not match the schema")

class CloudFallbackException(val status: Int, message: String) :
    NatifException("Cloud fallback failed ($status): $message")

class TaskNotFoundException(val task: String) : NatifException("Task \"$task\" not found or not published")

/** One validation problem, with the JSON path where it happened (e.g. ["emotions", 2]). */
data class SchemaIssue(val path: List<Any>, val message: String, val value: JsonElement? = null)
