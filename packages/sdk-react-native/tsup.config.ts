import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/lib.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // @be-natif/core is bundled so apps install a single package; native modules stay external.
  noExternal: ["@be-natif/core"],
  external: ["llama.rn", "@dr.pogodin/react-native-fs", "@react-native-async-storage/async-storage", "react-native-device-info", "react-native", "zod"],
});
