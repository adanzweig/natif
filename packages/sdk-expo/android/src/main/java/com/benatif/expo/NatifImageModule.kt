package com.benatif.expo

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

/** Text → image on the device with stable-diffusion.cpp (CPU). Work runs on one background thread. */
class NatifImageModule : Module() {
  private var handle = 0L
  private var loadedPath: String? = null
  private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "natif-image") }

  override fun definition() = ModuleDefinition {
    Name("NatifImage")
    Events("onImageProgress")

    AsyncFunction("load") { path: String, promise: Promise ->
      worker.execute {
        try { ensureLoaded(path); promise.resolve(null) }
        catch (e: Throwable) { promise.reject("ERR_NATIF_IMAGE_LOAD", e.message, e) }
      }
    }

    AsyncFunction("generate") { opts: Map<String, Any?>, promise: Promise ->
      worker.execute {
        try {
          val modelPath = opts["modelPath"] as? String ?: error("modelPath is required")
          val prompt = opts["prompt"] as? String ?: error("prompt is required")
          val outPath = opts["outPath"] as? String ?: error("outPath is required")
          ensureLoaded(modelPath)
          val width = (opts["width"] as? Number)?.toInt() ?: 384
          val height = (opts["height"] as? Number)?.toInt() ?: 384
          val steps = (opts["steps"] as? Number)?.toInt() ?: 4
          val cfg = (opts["cfgScale"] as? Number)?.toFloat() ?: 1.0f
          val seed = (opts["seed"] as? Number)?.toLong() ?: -1L
          val negative = opts["negativePrompt"] as? String ?: ""
          val t0 = System.currentTimeMillis()
          val rc = NatifSD.nativeGenerate(handle, prompt, negative, width, height, steps, cfg, seed, outPath,
            object : NatifSD.StepListener {
              override fun onStep(step: Int, steps: Int) = sendEvent("onImageProgress", mapOf("step" to step, "steps" to steps))
            })
          if (rc != 0) error(NatifSD.nativeError())
          promise.resolve(mapOf("path" to outPath, "width" to width, "height" to height, "genMs" to (System.currentTimeMillis() - t0).toInt()))
        } catch (e: Throwable) {
          promise.reject("ERR_NATIF_IMAGE", e.message, e)
        }
      }
    }

    Function("cancel") { if (handle != 0L) NatifSD.nativeCancel(handle) }

    AsyncFunction("unload") { promise: Promise -> worker.execute { free(); promise.resolve(null) } }

    OnDestroy { worker.execute { free() }; worker.shutdown() }
  }

  private fun ensureLoaded(path: String) {
    if (handle != 0L && loadedPath == path) return
    free()
    val threads = (Runtime.getRuntime().availableProcessors() - 2).coerceIn(1, 4)
    handle = NatifSD.nativeLoad(path, threads)
    if (handle == 0L) error("load failed: " + NatifSD.nativeError())
    loadedPath = path
  }

  private fun free() {
    if (handle != 0L) NatifSD.nativeFree(handle)
    handle = 0L
    loadedPath = null
  }
}
