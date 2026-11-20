// JNI bridge between com.benatif.android.LlamaNative and llama.cpp.
// One Session = one model + one context (KV cache). Calls on a session must be serialized by the
// caller (LlamaEngine holds a mutex); stop() may be called from any thread.

#include <android/log.h>
#include <jni.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <vector>

#include "llama.h"

#define TAG "benatif"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

struct Session {
    llama_model * model = nullptr;
    llama_context * ctx = nullptr;
    const llama_vocab * vocab = nullptr;
    llama_batch_ext * batch = nullptr;
    int n_batch = 512;
    std::string tmpl;                 // GGUF chat template (empty = none)
    std::vector<llama_token> cache;   // tokens currently in the KV cache (sequence 0)
    std::atomic<bool> stop{false};
};

using Clock = std::chrono::steady_clock;

int64_t ms_between(Clock::time_point a, Clock::time_point b) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(b - a).count();
}

void throw_java(JNIEnv * env, const std::string & msg) {
    if (env->ExceptionCheck()) return;
    jclass cls = env->FindClass("java/lang/IllegalStateException");
    env->ThrowNew(cls, msg.c_str());
}

std::string to_string(JNIEnv * env, jbyteArray arr) {
    if (!arr) return {};
    jsize n = env->GetArrayLength(arr);
    std::string out(static_cast<size_t>(n), '\0');
    env->GetByteArrayRegion(arr, 0, n, reinterpret_cast<jbyte *>(out.data()));
    return out;
}

// Longest prefix of `s` that doesn't end in the middle of a UTF-8 sequence, so Kotlin only ever
// receives whole characters (a token can carry half an emoji).
size_t utf8_complete_prefix(const std::string & s) {
    size_t n = s.size();
    if (n == 0) return 0;
    size_t i = n;
    int back = 0;
    while (i > 0 && back < 4) {
        unsigned char c = static_cast<unsigned char>(s[i - 1]);
        if ((c & 0xC0) != 0x80) {  // lead byte or ASCII
            size_t need = (c < 0x80) ? 1 : ((c >> 5) == 0x6) ? 2 : ((c >> 4) == 0xE) ? 3 : ((c >> 3) == 0x1E) ? 4 : 1;
            size_t have = n - (i - 1);
            return have >= need ? n : i - 1;
        }
        --i;
        ++back;
    }
    return n;  // malformed: pass through, Kotlin replaces invalid bytes
}

void batch_set_tokens(llama_batch_ext * batch, const llama_token * tokens, int32_t n_tokens, llama_pos pos_0) {
    llama_batch_ext_clear(batch);
    for (int32_t i = 0; i < n_tokens; ++i) {
        const int32_t idx = llama_batch_ext_add_token(batch, 0, tokens[i]);
        const llama_pos pos = pos_0 + i;
        llama_batch_ext_set_pos(batch, idx, &pos);
    }
    llama_batch_ext_set_output_logits(batch, n_tokens - 1, true);
}

void invalidate_cache(Session * s) {
    llama_memory_clear(llama_get_memory(s->ctx), true);
    s->cache.clear();
}

bool abort_callback(void * data) {
    return static_cast<Session *>(data)->stop.load();
}

struct ProgressCtx {
    JNIEnv * env;
    jobject cb;
    jmethodID mid;
};

bool progress_callback(float progress, void * user_data) {
    auto * p = static_cast<ProgressCtx *>(user_data);
    jboolean keep = p->env->CallBooleanMethod(p->cb, p->mid, static_cast<jfloat>(progress));
    if (p->env->ExceptionCheck()) {
        p->env->ExceptionClear();
        return true;
    }
    return keep == JNI_TRUE;
}

std::once_flag g_backend_once;

}  // namespace

extern "C" {

JNIEXPORT void JNICALL Java_com_benatif_android_LlamaNative_backendInit(JNIEnv *, jobject) {
    std::call_once(g_backend_once, [] {
        llama_log_set(
            [](enum ggml_log_level level, const char * text, void *) {
                if (level == GGML_LOG_LEVEL_WARN || level == GGML_LOG_LEVEL_ERROR) __android_log_print(level == GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR : ANDROID_LOG_WARN, TAG, "%s", text);
            },
            nullptr);
        llama_backend_init();
    });
}

JNIEXPORT jstring JNICALL Java_com_benatif_android_LlamaNative_systemInfo(JNIEnv * env, jobject) {
    return env->NewStringUTF(llama_print_system_info());
}

JNIEXPORT jlong JNICALL Java_com_benatif_android_LlamaNative_loadModel(JNIEnv * env, jobject, jstring jpath, jint n_gpu_layers,
                                                                          jboolean use_mmap, jobject progress) {
    const char * path = env->GetStringUTFChars(jpath, nullptr);
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = n_gpu_layers;
    // mmap: weights stay in the page cache and count less against the app (no mlock).
    mp.load_mode = use_mmap == JNI_TRUE ? LLAMA_LOAD_MODE_MMAP : LLAMA_LOAD_MODE_NONE;
    ProgressCtx pctx{env, progress, nullptr};
    if (progress) {
        jclass cls = env->GetObjectClass(progress);
        pctx.mid = env->GetMethodID(cls, "onProgress", "(F)Z");
        mp.progress_callback = progress_callback;
        mp.progress_callback_user_data = &pctx;
    }
    llama_model * model = llama_model_load_from_file(path, mp);
    env->ReleaseStringUTFChars(jpath, path);
    if (!model) {
        throw_java(env, "llama.cpp could not load the model file");
        return 0;
    }
    return reinterpret_cast<jlong>(model);
}

JNIEXPORT void JNICALL Java_com_benatif_android_LlamaNative_freeModel(JNIEnv *, jobject, jlong handle) {
    if (handle) llama_model_free(reinterpret_cast<llama_model *>(handle));
}

JNIEXPORT jlong JNICALL Java_com_benatif_android_LlamaNative_createSession(JNIEnv * env, jobject, jlong model_handle, jint n_ctx,
                                                                              jint n_batch, jint n_threads) {
    auto * model = reinterpret_cast<llama_model *>(model_handle);
    auto * s = new Session();
    s->model = model;
    s->vocab = llama_model_get_vocab(model);
    s->n_batch = n_batch;

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = static_cast<uint32_t>(n_ctx);
    cp.n_batch = static_cast<uint32_t>(n_batch);
    cp.n_ubatch = static_cast<uint32_t>(n_batch);
    cp.n_threads = n_threads;
    cp.n_threads_batch = n_threads;
    cp.abort_callback = abort_callback;
    cp.abort_callback_data = s;
    s->ctx = llama_init_from_model(model, cp);
    if (!s->ctx) {
        delete s;
        throw_java(env, "llama.cpp could not create a context (out of memory?)");
        return 0;
    }
    s->batch = llama_batch_ext_init(s->ctx);
    if (const char * t = llama_model_chat_template(model, nullptr)) s->tmpl = t;
    return reinterpret_cast<jlong>(s);
}

JNIEXPORT void JNICALL Java_com_benatif_android_LlamaNative_freeSession(JNIEnv *, jobject, jlong handle) {
    auto * s = reinterpret_cast<Session *>(handle);
    if (!s) return;
    if (s->batch) llama_batch_ext_free(s->batch);
    if (s->ctx) llama_free(s->ctx);
    delete s;  // the model is freed separately (freeModel)
}

JNIEXPORT void JNICALL Java_com_benatif_android_LlamaNative_stop(JNIEnv *, jobject, jlong handle) {
    if (auto * s = reinterpret_cast<Session *>(handle)) s->stop.store(true);
}

/**
 * Applies the GGUF chat template, reuses the longest cached prefix, decodes the rest and samples
 * up to max_tokens, streaming UTF-8 pieces to callback.onToken(ByteArray): Boolean (false = stop).
 * Returns [promptTokens, completionTokens, cachedTokens, ttftMs, totalMs, decodeMicros].
 */
JNIEXPORT jlongArray JNICALL Java_com_benatif_android_LlamaNative_generate(JNIEnv * env, jobject, jlong handle, jobjectArray jroles,
                                                                              jobjectArray jcontents, jint max_tokens, jfloat temperature,
                                                                              jint seed, jboolean disable_thinking, jbyteArray jgrammar,
                                                                              jobject callback) {
    auto * s = reinterpret_cast<Session *>(handle);
    if (!s) {
        throw_java(env, "no session");
        return nullptr;
    }
    const auto t0 = Clock::now();
    s->stop.store(false);

    // 1. Chat template ----------------------------------------------------------------------
    const jsize n_msg = env->GetArrayLength(jroles);
    std::vector<std::string> roles(n_msg), contents(n_msg);
    for (jsize i = 0; i < n_msg; ++i) {
        auto r = static_cast<jbyteArray>(env->GetObjectArrayElement(jroles, i));
        auto c = static_cast<jbyteArray>(env->GetObjectArrayElement(jcontents, i));
        roles[i] = to_string(env, r);
        contents[i] = to_string(env, c);
        env->DeleteLocalRef(r);
        env->DeleteLocalRef(c);
    }
    std::vector<llama_chat_message> msgs(n_msg);
    size_t total_chars = 0;
    for (jsize i = 0; i < n_msg; ++i) {
        msgs[i] = {roles[i].c_str(), contents[i].c_str()};
        total_chars += contents[i].size();
    }
    // llama_chat_apply_template recognizes the common templates (ChatML/Qwen, Llama 3, Gemma, Phi…)
    // from the GGUF's Jinja source without running Jinja. Unknown → ChatML.
    const char * tmpl = s->tmpl.empty() ? "chatml" : s->tmpl.c_str();
    std::vector<char> buf(total_chars * 2 + 1024);
    int32_t len = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), true, buf.data(), static_cast<int32_t>(buf.size()));
    if (len < 0) {
        LOGW("chat template not supported by llama_chat_apply_template, using chatml");
        tmpl = "chatml";
        len = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), true, buf.data(), static_cast<int32_t>(buf.size()));
    }
    if (len > static_cast<int32_t>(buf.size())) {
        buf.resize(static_cast<size_t>(len) + 1);
        len = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), true, buf.data(), static_cast<int32_t>(buf.size()));
    }
    if (len < 0) {
        throw_java(env, "could not apply the chat template");
        return nullptr;
    }
    std::string prompt(buf.data(), static_cast<size_t>(len));
    // Qwen3's template renders an empty think block when enable_thinking=false; do the same.
    if (disable_thinking == JNI_TRUE && s->tmpl.find("<think>") != std::string::npos) prompt += "<think>\n\n</think>\n\n";

    // 2. Tokenize ---------------------------------------------------------------------------
    int32_t n_prompt = -llama_tokenize(s->vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), nullptr, 0, true, true);
    if (n_prompt <= 0) {
        throw_java(env, "tokenization failed");
        return nullptr;
    }
    std::vector<llama_token> tokens(static_cast<size_t>(n_prompt));
    if (llama_tokenize(s->vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), tokens.data(), n_prompt, true, true) < 0) {
        throw_java(env, "tokenization failed");
        return nullptr;
    }
    const int n_ctx = static_cast<int>(llama_n_ctx(s->ctx));
    if (n_prompt >= n_ctx - 4) {
        throw_java(env, "prompt too long: " + std::to_string(n_prompt) + " tokens, context is " + std::to_string(n_ctx));
        return nullptr;
    }
    const int budget = std::min<int>(max_tokens, n_ctx - n_prompt);

    // 3. Reuse the cached prefix (system prompt + earlier turns stay in the KV cache) -------
    size_t n_past = 0;
    while (n_past < s->cache.size() && n_past < tokens.size() && s->cache[n_past] == tokens[n_past]) ++n_past;
    if (n_past == tokens.size()) --n_past;  // the last prompt token must be decoded to get logits
    if (n_past < s->cache.size()) {
        if (!llama_memory_seq_rm(llama_get_memory(s->ctx), 0, static_cast<llama_pos>(n_past), -1)) {
            invalidate_cache(s);
            n_past = 0;
        }
        s->cache.resize(n_past);
    }
    const size_t cached_tokens = n_past;

    for (size_t i = n_past; i < tokens.size(); i += static_cast<size_t>(s->n_batch)) {
        const int32_t n = static_cast<int32_t>(std::min<size_t>(static_cast<size_t>(s->n_batch), tokens.size() - i));
        batch_set_tokens(s->batch, &tokens[i], n, static_cast<llama_pos>(i));
        const int32_t ret = llama_process(s->ctx, LLAMA_PROCESS_TYPE_DECODE, s->batch);
        if (ret != 0) {
            invalidate_cache(s);
            if (ret == 2 || s->stop.load()) {  // aborted by stop()
                jlongArray out = env->NewLongArray(6);
                jlong vals[6] = {n_prompt, 0, static_cast<jlong>(cached_tokens), 0, ms_between(t0, Clock::now()), 0};
                env->SetLongArrayRegion(out, 0, 6, vals);
                return out;
            }
            throw_java(env, "llama_process failed while reading the prompt (" + std::to_string(ret) + ")");
            return nullptr;
        }
        s->cache.insert(s->cache.end(), tokens.begin() + static_cast<long>(i), tokens.begin() + static_cast<long>(i) + n);
    }

    // 4. Sampler chain ----------------------------------------------------------------------
    llama_sampler * smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    if (jgrammar) {
        const std::string grammar = to_string(env, jgrammar);
        if (llama_sampler * g = llama_sampler_init_grammar(s->vocab, grammar.c_str(), "root")) {
            llama_sampler_chain_add(smpl, g);
        } else {
            LOGW("JSON grammar rejected by llama.cpp; generating without constrained decoding");
        }
    }
    if (temperature <= 0.0f) {
        llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
    } else {
        llama_sampler_chain_add(smpl, llama_sampler_init_top_k(40));
        llama_sampler_chain_add(smpl, llama_sampler_init_top_p(0.95f, 1));
        llama_sampler_chain_add(smpl, llama_sampler_init_min_p(0.05f, 1));
        llama_sampler_chain_add(smpl, llama_sampler_init_temp(temperature));
        llama_sampler_chain_add(smpl, llama_sampler_init_dist(seed < 0 ? LLAMA_DEFAULT_SEED : static_cast<uint32_t>(seed)));
    }

    // 5. Generate ---------------------------------------------------------------------------
    jclass cb_cls = env->GetObjectClass(callback);
    jmethodID on_token = env->GetMethodID(cb_cls, "onToken", "([B)Z");
    const auto t_decode = Clock::now();
    int64_t ttft_ms = -1;
    int n_gen = 0;
    std::string pending;
    bool failed = false;
    std::string error;

    auto emit = [&](size_t n) -> bool {
        if (n == 0) return true;
        jbyteArray arr = env->NewByteArray(static_cast<jsize>(n));
        env->SetByteArrayRegion(arr, 0, static_cast<jsize>(n), reinterpret_cast<const jbyte *>(pending.data()));
        jboolean keep = env->CallBooleanMethod(callback, on_token, arr);
        env->DeleteLocalRef(arr);
        pending.erase(0, n);
        if (env->ExceptionCheck()) return false;
        return keep == JNI_TRUE;
    };

    std::vector<char> piece(256);
    while (n_gen < budget && !s->stop.load()) {
        const llama_token tok = llama_sampler_sample(smpl, s->ctx, -1);
        if (llama_vocab_is_eog(s->vocab, tok)) break;
        int32_t n = llama_token_to_piece(s->vocab, tok, piece.data(), static_cast<int32_t>(piece.size()), 0, false);
        if (n < 0) {
            piece.resize(static_cast<size_t>(-n));
            n = llama_token_to_piece(s->vocab, tok, piece.data(), static_cast<int32_t>(piece.size()), 0, false);
        }
        if (n > 0) pending.append(piece.data(), static_cast<size_t>(n));
        ++n_gen;
        if (ttft_ms < 0) ttft_ms = ms_between(t0, Clock::now());
        if (!emit(utf8_complete_prefix(pending))) break;
        if (n_gen >= budget) break;

        llama_token next = tok;
        batch_set_tokens(s->batch, &next, 1, static_cast<llama_pos>(s->cache.size()));
        const int32_t ret = llama_process(s->ctx, LLAMA_PROCESS_TYPE_DECODE, s->batch);
        if (ret != 0) {
            invalidate_cache(s);
            if (ret != 2 && !s->stop.load()) {
                failed = true;
                error = "llama_process failed while generating (" + std::to_string(ret) + ")";
            }
            break;
        }
        s->cache.push_back(tok);
    }
    if (!env->ExceptionCheck() && !pending.empty()) emit(pending.size());
    llama_sampler_free(smpl);
    if (env->ExceptionCheck()) return nullptr;  // exception thrown by the Kotlin callback propagates
    if (failed) {
        throw_java(env, error);
        return nullptr;
    }

    const auto t_end = Clock::now();
    const int64_t decode_us = std::chrono::duration_cast<std::chrono::microseconds>(t_end - t_decode).count();
    jlongArray out = env->NewLongArray(6);
    jlong vals[6] = {n_prompt, n_gen, static_cast<jlong>(cached_tokens), std::max<int64_t>(ttft_ms, 0), ms_between(t0, t_end), decode_us};
    env->SetLongArrayRegion(out, 0, 6, vals);
    return out;
}

}  // extern "C"
