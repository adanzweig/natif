// Real end-to-end run on this machine's GPU: fresh Chrome profile with WebGPU, real model.
// Usage: node e2e/real-gpu.mjs [profileDir]   (dev server must be running on :5190)
import { chromium } from "playwright";

const profile = process.argv[2] ?? "/tmp/benatif-e2e-profile";
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: false,
  args: ["--enable-unsafe-webgpu"],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on("console", (m) => m.type() === "error" && console.log("[console]", m.text()));
await page.goto("http://localhost:5190");

if (await page.getByText("Continuar").isVisible()) {
  await page.getByText("Continuar").click(); // both consents off: device only
}

const cases = [
  "Estoy agotada, el bebé no me dejó dormir y tengo una entrega mañana que no llego a terminar. Me siento sobrepasada.",
  "Hoy presenté mi proyecto y salió genial, todos me felicitaron. Estoy orgulloso y con muchas ganas de seguir.",
  "Slept great, went for a run, work was calm. Feeling happy and grateful.",
  "A veces pienso en matarme, no le veo sentido a nada.",
];
for (const text of cases) {
  await page.fill("textarea", text);
  const t0 = Date.now();
  await page.getByRole("button", { name: /Analizar/ }).click();
  const crisisShown = await page.getByRole("alert").isVisible().catch(() => false);
  await page.waitForSelector('[data-testid="result"], .error', { timeout: 600_000 });
  const err = await page.locator(".error").textContent().catch(() => null);
  const result = await page.locator('[data-testid="result"]').innerText().catch(() => "");
  const sent = await page.locator('[data-testid="sent"]').textContent().catch(() => "");
  console.log(JSON.stringify({ text: text.slice(0, 40), ms: Date.now() - t0, crisisShownBeforeModel: crisisShown, err, result: result.replace(/\n/g, " | "), sentHasText: sent?.includes(text.slice(0, 15)) }));
}
await ctx.close();
