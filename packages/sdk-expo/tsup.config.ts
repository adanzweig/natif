import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // One package to install: core and the shared llama.rn engine are bundled; native modules stay external.
  noExternal: ["@be-natif/core", "@be-natif/react-native"],
  external: ["llama.rn", "expo", "expo-file-system", "expo-device", "@react-native-async-storage/async-storage", "react-native", "zod"],
});
