// Writes contract/catalog.json from the TS catalog so the Swift and Kotlin SDKs ship the same
// models and selection constants. Run after `pnpm build`: node scripts/export-contract.mjs
import { writeFileSync } from "node:fs";
import * as core from "../dist/index.js";

const contract = {
  version: 1,
  constants: {
    STORAGE_HEADROOM: core.STORAGE_HEADROOM,
    AVAILABLE_MEMORY_SHARE: core.AVAILABLE_MEMORY_SHARE,
    TOTAL_MEMORY_SHARE: core.TOTAL_MEMORY_SHARE,
    UNKNOWN_FREE_MEMORY_CAP_MB: core.UNKNOWN_FREE_MEMORY_CAP_MB,
  },
  models: core.MODEL_CATALOG,
};
writeFileSync(new URL("../contract/catalog.json", import.meta.url), JSON.stringify(contract, null, 2) + "\n");
console.log(`contract/catalog.json: ${contract.models.length} models`);
