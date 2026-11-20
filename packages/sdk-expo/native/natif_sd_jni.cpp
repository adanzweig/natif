// JNI glue for com.benatif.expo.NatifSD (Android). Only these symbols are exported.
#include <jni.h>
#include <string>
#include "natif_sd.h"

#define JNI_FN_T(ret, name) extern "C" JNIEXPORT ret JNICALL Java_com_benatif_expo_NatifSD_##name

static std::string str(JNIEnv* env, jstring s) {
  if (!s) return {};
  const char* c = env->GetStringUTFChars(s, nullptr);
  std::string out(c ? c : "");
  if (c) env->ReleaseStringUTFChars(s, c);
  return out;
}

JNI_FN_T(jlong, nativeLoad)(JNIEnv* env, jclass, jstring path, jint threads) {
  return reinterpret_cast<jlong>(natif_sd_load(str(env, path).c_str(), threads));
}

struct cb_ctx { JNIEnv* env; jobject listener; jmethodID method; };
static void on_progress(int step, int steps, void* user) {
  auto* c = static_cast<cb_ctx*>(user);
  if (c && c->listener && c->method) c->env->CallVoidMethod(c->listener, c->method, step, steps);
}

JNI_FN_T(jint, nativeGenerate)(JNIEnv* env, jclass, jlong handle, jstring prompt, jstring negative, jint width, jint height,
                        jint steps, jfloat cfg, jlong seed, jstring outPath, jobject listener) {
  cb_ctx c{env, listener, nullptr};
  if (listener) {
    jclass k = env->GetObjectClass(listener);
    c.method = env->GetMethodID(k, "onStep", "(II)V");
  }
  return natif_sd_generate(reinterpret_cast<natif_sd*>(handle), str(env, prompt).c_str(), str(env, negative).c_str(), width,
                           height, steps, cfg, seed, str(env, outPath).c_str(), listener ? on_progress : nullptr, &c);
}

JNI_FN_T(void, nativeCancel)(JNIEnv*, jclass, jlong handle) { natif_sd_cancel(reinterpret_cast<natif_sd*>(handle)); }
JNI_FN_T(void, nativeFree)(JNIEnv*, jclass, jlong handle) { natif_sd_free(reinterpret_cast<natif_sd*>(handle)); }
JNI_FN_T(jstring, nativeError)(JNIEnv* env, jclass) { return env->NewStringUTF(natif_sd_error()); }
