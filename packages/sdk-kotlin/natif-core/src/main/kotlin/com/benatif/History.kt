package com.benatif

const val DEFAULT_MAX_HISTORY: Int = 20

data class TrimmedHistory(val kept: List<ChatMessage>, val dropped: Int)

/**
 * Cache-friendly trimming: instead of sliding one message per turn (which changes the prefix and
 * invalidates the engine's KV cache every time), drop a block down to half the limit, so the
 * same prefix is reused for the next max/2 turns. Always starts on a user turn.
 */
fun trimHistory(history: List<ChatMessage>, max: Int): TrimmedHistory {
    if (max <= 0) return TrimmedHistory(emptyList(), history.size)
    if (history.size <= max) return TrimmedHistory(history, 0)
    val target = maxOf(1, max / 2)
    val block = (history.size / target) * target - target
    var start = maxOf(history.size - max, block)
    while (start < history.size && history[start].role != Role.USER) start++
    return TrimmedHistory(history.subList(start, history.size).toList(), start)
}
