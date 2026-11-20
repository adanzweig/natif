import ExpoModulesCore

/// Text → image on the device with stable-diffusion.cpp (Metal). One model loaded at a time;
/// work runs on a serial background queue so the JS thread never blocks.
public class NatifImageModule: Module {
  private var handle: OpaquePointer?
  private var loadedPath: String?
  private let queue = DispatchQueue(label: "com.benatif.image", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("NatifImage")
    Events("onImageProgress")

    AsyncFunction("load") { (path: String, promise: Promise) in
      self.queue.async {
        do { try self.ensureLoaded(path); promise.resolve(nil) }
        catch { promise.reject("ERR_NATIF_IMAGE_LOAD", error.localizedDescription) }
      }
    }

    AsyncFunction("generate") { (opts: [String: Any], promise: Promise) in
      self.queue.async {
        do {
          guard let modelPath = opts["modelPath"] as? String, let prompt = opts["prompt"] as? String,
                let outPath = opts["outPath"] as? String else {
            throw NSError(domain: "natif", code: 1, userInfo: [NSLocalizedDescriptionKey: "modelPath, prompt and outPath are required"])
          }
          try self.ensureLoaded(modelPath)
          let width = (opts["width"] as? Int) ?? 384
          let height = (opts["height"] as? Int) ?? 384
          let steps = (opts["steps"] as? Int) ?? 4
          let cfg = Float((opts["cfgScale"] as? Double) ?? 1.0)
          let seed = Int64((opts["seed"] as? Double) ?? -1)
          let negative = (opts["negativePrompt"] as? String) ?? ""
          let t0 = Date()
          let me = Unmanaged.passUnretained(self).toOpaque()
          let rc = natif_sd_generate(self.handle, prompt, negative, Int32(width), Int32(height), Int32(steps), cfg, seed, outPath,
            { step, steps, user in
              guard let user = user else { return }
              let module = Unmanaged<NatifImageModule>.fromOpaque(user).takeUnretainedValue()
              module.sendEvent("onImageProgress", ["step": Int(step), "steps": Int(steps)])
            }, me)
          if rc != 0 { throw NSError(domain: "natif", code: Int(rc), userInfo: [NSLocalizedDescriptionKey: String(cString: natif_sd_error())]) }
          promise.resolve(["path": outPath, "width": width, "height": height, "genMs": Int(Date().timeIntervalSince(t0) * 1000)])
        } catch {
          promise.reject("ERR_NATIF_IMAGE", error.localizedDescription)
        }
      }
    }

    Function("cancel") {
      if let h = self.handle { natif_sd_cancel(h) }
    }

    AsyncFunction("unload") { (promise: Promise) in
      self.queue.async { self.free(); promise.resolve(nil) }
    }

    OnDestroy { self.queue.sync { self.free() } }
  }

  private func ensureLoaded(_ path: String) throws {
    if handle != nil && loadedPath == path { return }
    free()
    let threads = Int32(max(1, min(4, ProcessInfo.processInfo.activeProcessorCount - 2)))
    guard let h = natif_sd_load(path, threads) else {
      throw NSError(domain: "natif", code: 2, userInfo: [NSLocalizedDescriptionKey: "load failed: " + String(cString: natif_sd_error())])
    }
    handle = h
    loadedPath = path
  }

  private func free() {
    if let h = handle { natif_sd_free(h) }
    handle = nil
    loadedPath = nil
  }
}
