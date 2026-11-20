package com.benatif

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Converts a JSON Schema into a llama.cpp GBNF grammar, so the engine can only sample JSON of
 * the right shape (what llama.rn does with `response_format: json_schema`). It covers the
 * structure: objects (required + optional properties, in schema order), arrays (with
 * min/maxItems), enums/const, strings (min/maxLength), numbers, integers, booleans, null,
 * type unions and anyOf/oneOf. Value ranges (minimum/maximum…) are not expressible in GBNF; the
 * validator and the repair turn handle those. Anything unknown becomes "any JSON value".
 */
object JsonSchemaGrammar {
    private val PRIMITIVES = linkedMapOf(
        "space" to """| " " | "\n" [ \t]{0,20}""",
        "char" to """[^"\\\x7F\x00-\x1F] | [\\] (["\\bfnrt] | "u" [0-9a-fA-F]{4})""",
        "string" to """"\"" char* "\"" space""",
        "number" to """("-"? ([0-9] | [1-9] [0-9]{0,15})) ("." [0-9]+)? ([eE] [-+]? [0-9]{1,15})? space""",
        "integer" to """("-"? ([0-9] | [1-9] [0-9]{0,15})) space""",
        "boolean" to """("true" | "false") space""",
        "null" to """"null" space""",
        "value" to """object | array | string | number | boolean | null""",
        "object" to """"{" space ( string ":" space value ("," space string ":" space value)* )? "}" space""",
        "array" to """"[" space ( value ("," space value)* )? "]" space""",
    )

    fun convert(schema: JsonObject): String {
        val b = Builder()
        val top = b.visit(schema, "top")
        val lines = mutableListOf("root ::= $top")
        lines += b.rules.map { (k, v) -> "$k ::= $v" }
        lines += PRIMITIVES.map { (k, v) -> "$k ::= $v" }
        return lines.joinToString("\n") + "\n"
    }

    /** A GBNF string literal that matches [text] exactly. */
    fun literal(text: String): String {
        val sb = StringBuilder("\"")
        for (c in text) {
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c.code < 0x20 -> sb.append("\\x%02X".format(c.code))
                else -> sb.append(c)
            }
        }
        return sb.append('"').toString()
    }

    private class Builder {
        val rules = linkedMapOf<String, String>()
        private var n = 0

        private fun add(hint: String, body: String): String {
            val name = "r${++n}-${hint.filter { it.isLetterOrDigit() }.take(16).ifEmpty { "x" }}"
            rules[name] = body
            return name
        }

        /** Returns a rule name (or a primitive) that matches [s]. */
        fun visit(s: JsonObject, hint: String): String {
            (s["const"])?.let { return add(hint, "${literal(it.toString())} space") }
            (s["enum"] as? JsonArray)?.let { e -> return add(hint, "(" + e.joinToString(" | ") { literal(it.toString()) } + ") space") }
            (s["anyOf"] ?: s["oneOf"])?.let { alts ->
                val names = (alts as? JsonArray)?.mapIndexedNotNull { i, a -> (a as? JsonObject)?.let { visit(it, "$hint$i") } }
                if (!names.isNullOrEmpty()) return add(hint, names.joinToString(" | "))
            }
            return when (val t = s["type"]) {
                is JsonArray -> add(hint, t.joinToString(" | ") { visitType(s, it.jsonPrimitive.content, "$hint-${it.jsonPrimitive.content}") })
                is JsonPrimitive -> visitType(s, t.content, hint)
                else -> if (s["properties"] != null) visitType(s, "object", hint) else "value"
            }
        }

        private fun visitType(s: JsonObject, type: String, hint: String): String = when (type) {
            "object" -> objectRule(s, hint)
            "array" -> arrayRule(s, hint)
            "string" -> stringRule(s, hint)
            "number", "integer", "boolean", "null" -> type
            else -> "value"
        }

        private fun objectRule(s: JsonObject, hint: String): String {
            val props = s["properties"] as? JsonObject ?: return "object"
            if (props.isEmpty()) return "object"
            val required = (s["required"] as? JsonArray)?.map { it.jsonPrimitive.content }?.toSet() ?: emptySet()
            fun kv(key: String, sub: JsonElement): String {
                val value = (sub as? JsonObject)?.let { visit(it, key) } ?: "value"
                return "${literal(JsonPrimitive(key).toString())} space \":\" space $value"
            }
            val req = props.filterKeys { it in required }.map { (k, v) -> kv(k, v) }
            val opt = props.filterKeys { it !in required }.map { (k, v) -> kv(k, v) }
            // Optional properties: any ordered subset, via a chain opt_i ::= kv_i ("," opt_{i+1})? | opt_{i+1}
            var optChain: String? = null
            for (i in opt.indices.reversed()) {
                val body = if (optChain == null) opt[i] else "${opt[i]} (\",\" space $optChain)? | $optChain"
                optChain = add("$hint-opt$i", body)
            }
            val body = buildString {
                append("\"{\" space ")
                if (req.isNotEmpty()) {
                    append(req.joinToString(" \",\" space "))
                    if (optChain != null) append(" (\",\" space $optChain)?")
                } else if (optChain != null) {
                    append("($optChain)?")
                }
                append(" \"}\" space")
            }
            return add(hint, body)
        }

        private fun arrayRule(s: JsonObject, hint: String): String {
            val item = (s["items"] as? JsonObject)?.let { visit(it, "$hint-item") } ?: "value"
            val min = (s["minItems"] as? JsonPrimitive)?.intOrNull ?: 0
            val max = (s["maxItems"] as? JsonPrimitive)?.intOrNull
            val list = when {
                max == 0 -> ""
                max == 1 && min <= 1 -> if (min == 0) "( $item )?" else item
                min == 0 -> "( $item (\",\" space $item){0,${max?.minus(1)?.toString() ?: ""}} )?"
                else -> "$item (\",\" space $item){${min - 1},${max?.minus(1)?.toString() ?: ""}}"
            }
            return add(hint, "\"[\" space $list \"]\" space")
        }

        private fun stringRule(s: JsonObject, hint: String): String {
            val min = (s["minLength"] as? JsonPrimitive)?.intOrNull
            val max = (s["maxLength"] as? JsonPrimitive)?.intOrNull
            if (min == null && max == null) return "string"
            return add(hint, "\"\\\"\" char{${min ?: 0},${max ?: ""}} \"\\\"\" space")
        }
    }
}
