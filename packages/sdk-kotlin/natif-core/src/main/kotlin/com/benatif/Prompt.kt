package com.benatif

import kotlinx.serialization.json.JsonObject

// Port of packages/sdk-core/src/prompt.ts (same strings).

fun buildExtractMessages(task: TaskConfig, jsonSchema: JsonObject, text: String): List<ChatMessage> {
    val system = listOfNotNull(
        task.systemPrompt.trim(),
        task.instructions?.trim(),
        // Engines with constrained decoding enforce this anyway; the rest rely on the prompt.
        "Answer only with a JSON object that follows this JSON Schema:\n$jsonSchema",
    ).filter { it.isNotEmpty() }.joinToString("\n\n")
    return listOf(ChatMessage.system(system), ChatMessage.user(text))
}

val BENCHMARK_MESSAGES: List<ChatMessage> = listOf(
    ChatMessage.user("Write a short paragraph about why the sky is blue. Keep going until you are told to stop."),
)
