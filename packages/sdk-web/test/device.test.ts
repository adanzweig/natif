import { describe, expect, it } from "vitest";
import { parseBrowser, parseOs } from "../src/device";

const UA = {
  chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0",
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0",
};

describe("parseBrowser", () => {
  it.each([
    ["chrome", { name: "chrome", major: 157 }],
    ["edge", { name: "edge", major: 157 }],
    ["safari", { name: "safari", major: 26 }],
    ["iphone", { name: "safari", major: 26 }],
    ["firefox", { name: "firefox", major: 150 }],
  ] as const)("%s", (k, expected) => expect(parseBrowser(UA[k])).toEqual(expected));
});

describe("parseOs", () => {
  it.each([
    ["chrome", "macos"],
    ["edge", "windows"],
    ["iphone", "ios"],
    ["firefox", "linux"],
  ] as const)("%s", (k, expected) => expect(parseOs(UA[k])).toBe(expected));
});
