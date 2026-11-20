package com.benatif.android

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.benatif.KeyValueStore

/** KeyValueStore on SharedPreferences (benchmarks per device+model+SDK version). */
internal class PreferencesStore(context: Context, name: String = "benatif") : KeyValueStore {
    private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
    override suspend fun get(key: String): String? = withContext(Dispatchers.IO) { prefs.getString(key, null) }
    override suspend fun set(key: String, value: String) = withContext(Dispatchers.IO) { prefs.edit().putString(key, value).apply() }
    override suspend fun delete(key: String) = withContext(Dispatchers.IO) { prefs.edit().remove(key).apply() }
    override suspend fun clear() = withContext(Dispatchers.IO) { prefs.edit().clear().apply() }
}
