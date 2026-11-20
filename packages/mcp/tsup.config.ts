import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/content.ts"],
  format: ["esm"],
  dts: { entry: ["src/index.ts", "src/content.ts"] },
  clean: true,
  target: "node20",
  // Self-contained for `npx -y @be-natif/mcp`: core is bundled, the MCP SDK and zod are dependencies.
  noExternal: ["@be-natif/core"],
});
