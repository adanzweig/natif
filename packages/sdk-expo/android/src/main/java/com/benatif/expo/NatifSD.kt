package com.benatif.expo

/** JNI bindings for libnatif_sd.so (stable-diffusion.cpp + Natif bridge). */
object NatifSD {
  init { System.loadLibrary("natif_sd") }

  interface StepListener { fun onStep(step: Int, steps: Int) }

  @JvmStatic external fun nativeLoad(path: String, threads: Int): Long
  @JvmStatic external fun nativeGenerate(
    handle: Long, prompt: String, negative: String, width: Int, height: Int,
    steps: Int, cfg: Float, seed: Long, outPath: String, listener: StepListener?,
  ): Int
  @JvmStatic external fun nativeCancel(handle: Long)
  @JvmStatic external fun nativeFree(handle: Long)
  @JvmStatic external fun nativeError(): String
}
