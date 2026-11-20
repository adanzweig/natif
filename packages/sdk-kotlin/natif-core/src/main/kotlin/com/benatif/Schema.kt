package com.benatif

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Port of packages/sdk-core/src/schema.ts. TS validates with zod; Kotlin has no zod, so schemas are
// plain JSON Schema (what zod's toJSONSchema produces) checked by [JsonSchemaValidator].

private val THINK = Regex("<think>[\\s\\S]*?</think>")

/** Removes `<think>…</think>` blocks. */
fun stripThinking(text: String): String = THINK.replace(text, "")

private val JSON_SCALAR = Regex("""-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?|true|false|null|"[\s\S]*"""")

/** Like JSON.parse: kotlinx's parser accepts bare words at top level, so scalars are checked first. */
private fun strictParse(text: String): JsonElement? {
    val t = text.trim()
    if (t.isEmpty()) return null
    if (t[0] != '{' && t[0] != '[' && !JSON_SCALAR.matches(t)) return null
    return runCatching { Json.parseToJsonElement(t) }.getOrNull()
}

class JsonExtractException(message: String) : Exception(message)

/**
 * Models wrap JSON in thinking tags, code fences or chatter. Take the first top-level JSON object
 * or array out of the text.
 */
fun extractJson(raw: String): JsonElement {
    val text = stripThinking(raw).trim()
    strictParse(text)?.let { return it }
    val start = text.indexOfFirst { it == '{' || it == '[' }
    if (start < 0) throw JsonExtractException("No JSON found in model output")
    val open = text[start]
    val close = if (open == '{') '}' else ']'
    var depth = 0
    var inString = false
    var escaped = false
    for (i in start until text.length) {
        val c = text[i]
        if (inString) {
            if (escaped) escaped = false
            else if (c == '\\') escaped = true
            else if (c == '"') inString = false
            continue
        }
        if (c == '"') inString = true
        else if (c == open) depth++
        else if (c == close && --depth == 0) {
            return strictParse(text.substring(start, i + 1)) ?: throw JsonExtractException("Invalid JSON in model output")
        }
    }
    throw JsonExtractException("Unterminated JSON in model output")
}

sealed interface ParseOutcome {
    data class Ok(val data: JsonElement) : ParseOutcome
    data class Failed(val error: String, val issues: List<SchemaIssue> = emptyList()) : ParseOutcome
}

fun parseModelOutput(schema: JsonObject, raw: String): ParseOutcome {
    val value = try {
        extractJson(raw)
    } catch (e: JsonExtractException) {
        return ParseOutcome.Failed(e.message ?: "Invalid JSON")
    }
    val issues = JsonSchemaValidator.validate(schema, value)
    if (issues.isEmpty()) return ParseOutcome.Ok(value)
    return ParseOutcome.Failed(JsonSchemaValidator.prettify(issues), issues)
}

/** Message appended for the single repair attempt. */
fun repairMessage(error: String): String =
    "Your previous answer was not valid for the required JSON schema:\n$error\nReply again with only the corrected JSON object."

/** Parses a JSON Schema given as text. */
fun parseJsonSchema(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

/**
 * Minimal JSON Schema validator for what apps send as output schemas: type (incl. arrays of
 * types), enum, const, properties, required, additionalProperties, items, min/maxItems,
 * minimum/maximum (+ exclusive), min/maxLength, anyOf/oneOf/allOf. Unknown keywords are ignored.
 */
object JsonSchemaValidator {
    fun validate(schema: JsonObject, value: JsonElement): List<SchemaIssue> {
        val out = mutableListOf<SchemaIssue>()
        check(schema, value, emptyList(), out)
        return out
    }

    /** Same shape as zod's prettifyError: "✖ message\n  → at path". */
    fun prettify(issues: List<SchemaIssue>): String = issues.joinToString("\n") { i ->
        val path = i.path.joinToString("") { if (it is Int) "[$it]" else ".$it" }.removePrefix(".")
        "✖ ${i.message}" + if (path.isNotEmpty()) "\n  → at $path" else ""
    }

    private fun check(s: JsonObject, v: JsonElement, path: List<Any>, out: MutableList<SchemaIssue>) {
        (s["anyOf"] ?: s["oneOf"])?.let { alts ->
            val options = (alts as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
            if (options.isNotEmpty() && options.none { validate(it, v).isEmpty() }) {
                out += SchemaIssue(path, "Invalid input: no option matched", v)
                return
            }
        }
        (s["allOf"] as? JsonArray)?.forEach { sub -> (sub as? JsonObject)?.let { check(it, v, path, out) } }

        s["const"]?.let { c ->
            if (c != v) out += SchemaIssue(path, "Invalid input: expected $c", v)
            return
        }
        (s["enum"] as? JsonArray)?.let { options ->
            if (v !in options) {
                out += SchemaIssue(path, "Invalid option: expected one of ${options.joinToString("|")}", v)
                return
            }
        }

        val types = when (val t = s["type"]) {
            is JsonPrimitive -> listOf(t.content)
            is JsonArray -> t.map { it.jsonPrimitive.content }
            else -> emptyList()
        }
        if (types.isNotEmpty() && types.none { matchesType(it, v) }) {
            out += SchemaIssue(path, "Invalid input: expected ${types.joinToString(" | ")}, received ${typeOf(v)}", v)
            return
        }

        when (v) {
            is JsonObject -> checkObject(s, v, path, out)
            is JsonArray -> checkArray(s, v, path, out)
            is JsonPrimitive -> checkPrimitive(s, v, path, out)
        }
    }

    private fun checkObject(s: JsonObject, v: JsonObject, path: List<Any>, out: MutableList<SchemaIssue>) {
        val props = s["properties"] as? JsonObject ?: JsonObject(emptyMap())
        (s["required"] as? JsonArray)?.forEach { r ->
            val key = r.jsonPrimitive.content
            if (key !in v) out += SchemaIssue(path + key, "Invalid input: expected ${describe(props[key])}, received undefined")
        }
        for ((key, value) in v) {
            val sub = props[key]
            if (sub is JsonObject) {
                check(sub, value, path + key, out)
            } else {
                when (val extra = s["additionalProperties"]) {
                    is JsonPrimitive -> if (extra.booleanOrNull == false) out += SchemaIssue(path, "Unrecognized key: \"$key\"")
                    is JsonObject -> check(extra, value, path + key, out)
                    else -> {}
                }
            }
        }
    }

    private fun checkArray(s: JsonObject, v: JsonArray, path: List<Any>, out: MutableList<SchemaIssue>) {
        s.int("minItems")?.let { if (v.size < it) out += SchemaIssue(path, "Too small: expected array to have >=$it items") }
        s.int("maxItems")?.let { if (v.size > it) out += SchemaIssue(path, "Too big: expected array to have <=$it items") }
        (s["items"] as? JsonObject)?.let { items -> v.forEachIndexed { i, e -> check(items, e, path + i, out) } }
    }

    private fun checkPrimitive(s: JsonObject, v: JsonPrimitive, path: List<Any>, out: MutableList<SchemaIssue>) {
        if (v.isString) {
            val len = v.content.codePointCount(0, v.content.length)
            s.int("minLength")?.let { if (len < it) out += SchemaIssue(path, "Too small: expected string to have >=$it characters") }
            s.int("maxLength")?.let { if (len > it) out += SchemaIssue(path, "Too big: expected string to have <=$it characters") }
            return
        }
        val n = v.doubleOrNull ?: return
        s.num("minimum")?.let { if (n < it) out += SchemaIssue(path, "Too small: expected number to be >=${fmt(it)}", v) }
        s.num("maximum")?.let { if (n > it) out += SchemaIssue(path, "Too big: expected number to be <=${fmt(it)}", v) }
        s.num("exclusiveMinimum")?.let { if (n <= it) out += SchemaIssue(path, "Too small: expected number to be >${fmt(it)}", v) }
        s.num("exclusiveMaximum")?.let { if (n >= it) out += SchemaIssue(path, "Too big: expected number to be <${fmt(it)}", v) }
    }

    private fun matchesType(t: String, v: JsonElement): Boolean = when (t) {
        "object" -> v is JsonObject
        "array" -> v is JsonArray
        "null" -> v is JsonNull
        "string" -> v is JsonPrimitive && v.isString
        "boolean" -> v is JsonPrimitive && !v.isString && v.booleanOrNull != null
        "number" -> v is JsonPrimitive && !v.isString && v !is JsonNull && v.doubleOrNull != null
        "integer" -> v is JsonPrimitive && !v.isString && v !is JsonNull && v.doubleOrNull?.let { it % 1.0 == 0.0 && it.isFinite() } == true
        else -> true
    }

    private fun typeOf(v: JsonElement): String = when {
        v is JsonObject -> "object"
        v is JsonArray -> "array"
        v is JsonNull -> "null"
        v is JsonPrimitive && v.isString -> "string"
        v is JsonPrimitive && v.booleanOrNull != null -> "boolean"
        else -> "number"
    }

    private fun describe(s: JsonElement?): String = ((s as? JsonObject)?.get("type") as? JsonPrimitive)?.content ?: "value"

    private fun JsonObject.int(k: String) = (this[k] as? JsonPrimitive)?.intOrNull
    private fun JsonObject.num(k: String) = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
    private fun fmt(d: Double) = if (d % 1.0 == 0.0) d.toLong().toString() else d.toString()
}
