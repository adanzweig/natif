// Expo config plugin for @be-natif/expo. Add to app.json: { "plugins": ["@be-natif/expo"] }
//
// iOS: asks for the increased memory limit entitlement. Without it iOS caps an app's memory well
//      below the phone's RAM and kills it when a 2-3 GB model is loaded.
// Android: largeHeap, so the Java side doesn't hit its heap cap while the model is mapped.
const { createRunOncePlugin, withAndroidManifest, withEntitlementsPlist } = require("expo/config-plugins");

const pkg = { name: "@be-natif/expo", version: "0.1.0" };

function withNatif(config, props = {}) {
  const { increasedMemoryLimit = true, largeHeap = true } = props;
  if (increasedMemoryLimit) {
    config = withEntitlementsPlist(config, (c) => {
      c.modResults["com.apple.developer.kernel.increased-memory-limit"] = true;
      return c;
    });
  }
  if (largeHeap) {
    config = withAndroidManifest(config, (c) => {
      const app = c.modResults.manifest.application?.[0];
      if (app) app.$["android:largeHeap"] = "true";
      return c;
    });
  }
  return config;
}

module.exports = createRunOncePlugin(withNatif, pkg.name, pkg.version);
