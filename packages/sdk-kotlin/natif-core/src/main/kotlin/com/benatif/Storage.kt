package com.benatif

import java.util.concurrent.ConcurrentHashMap

/** Small persistent key/value store (benchmarks, task cache). Android: SharedPreferences. */
interface KeyValueStore {
    suspend fun get(key: String): String?
    suspend fun set(key: String, value: String)
    suspend fun delete(key: String)
    suspend fun clear()
}

class MemoryStore : KeyValueStore {
    private val map = ConcurrentHashMap<String, String>()
    override suspend fun get(key: String) = map[key]
    override suspend fun set(key: String, value: String) { map[key] = value }
    override suspend fun delete(key: String) { map.remove(key) }
    override suspend fun clear() = map.clear()
}
