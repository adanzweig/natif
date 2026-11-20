import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256, sha256Hex } from "../src/sha256";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("sha256 (pure JS fallback for React Native)", () => {
  it("matches node:crypto on known and edge-length inputs", () => {
    for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "ñandú 🧉 device=web|gpu=apple"]) {
      expect(hex(sha256(new TextEncoder().encode(s)))).toBe(createHash("sha256").update(s).digest("hex"));
    }
  });
  it("works without WebCrypto", async () => {
    const saved = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: saved, configurable: true });
    }
  });
});
