// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { seedBackend } from "../functional/fixtures/settings";

const DOOM_URL = "http://doom.localhost:5173/";

interface DoomMetrics {
  backend: string | null;
  cacheHit: boolean;
  translationMs: number;
  compilationMs: number;
  startupMs: number;
  firstFrameMs: number;
  frames: number;
  fps: number;
  updates: number;
  updateP50Ms: number;
  updateP95Ms: number;
  updateMaxMs: number;
  audioChunks: number;
  audioSamples: number;
}

async function readMetrics(canvas: Locator): Promise<DoomMetrics> {
  const number = async (name: string): Promise<number> =>
    Number((await canvas.getAttribute(name)) ?? 0);
  return {
    backend: await canvas.getAttribute("data-pvm-backend"),
    cacheHit: (await canvas.getAttribute("data-pvm-cache-hit")) === "true",
    translationMs: await number("data-pvm-translation-ms"),
    compilationMs: await number("data-pvm-compilation-ms"),
    startupMs: await number("data-pvm-startup-ms"),
    firstFrameMs: await number("data-pvm-first-frame-ms"),
    frames: await number("data-pvm-frames"),
    fps: await number("data-pvm-fps"),
    updates: await number("data-pvm-updates"),
    updateP50Ms: await number("data-pvm-update-p50-ms"),
    updateP95Ms: await number("data-pvm-update-p95-ms"),
    updateMaxMs: await number("data-pvm-update-max-ms"),
    audioChunks: await number("data-pvm-audio-chunks"),
    audioSamples: await number("data-pvm-audio-samples"),
  };
}

async function launchDoom(page: Page): Promise<void> {
  await seedBackend(page, "rpc-gateway");
  await page.goto(DOOM_URL, { waitUntil: "domcontentloaded" });
}

test("doom.paseo is playable through the real-time PVM to Wasm translator", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await launchDoom(page);
  const productFrame = page.locator('iframe[src*="doom.app.localhost"]');
  await expect(productFrame).toBeAttached({ timeout: 60_000 });
  const product = page.frameLocator('iframe[src*="doom.app.localhost"]');
  const canvas = product.locator("#dotli-pvm-canvas");
  await expect(canvas).toHaveAttribute("data-pvm-ready", "true", {
    timeout: 60_000,
  });
  await canvas.click();
  await page.keyboard.down("w");
  await page.waitForTimeout(750);
  await page.keyboard.up("w");
  await page.keyboard.press("Space");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-pvm-updates")), {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(300);

  const cold = await readMetrics(canvas);
  expect(cold.backend).toBe("compiler");
  expect(cold.fps).toBeGreaterThanOrEqual(35);
  expect(cold.updateP95Ms).toBeLessThan(28.6);
  expect(cold.firstFrameMs).toBeLessThan(3_000);
  expect(cold.audioChunks).toBeGreaterThan(0);
  expect(cold.audioSamples).toBeGreaterThan(0);
  await testInfo.attach("doom-pvm-cold-metrics.json", {
    body: Buffer.from(JSON.stringify(cold, null, 2)),
    contentType: "application/json",
  });
  await testInfo.attach("doom-pvm.png", {
    body: await productFrame.screenshot(),
    contentType: "image/png",
  });

  const sandboxUrl = await productFrame.getAttribute("src");
  expect(sandboxUrl).not.toBeNull();
  await productFrame.evaluate((iframe, url) => {
    if (iframe instanceof HTMLIFrameElement && url !== null) {
      iframe.src = url;
    }
  }, sandboxUrl);
  await expect(canvas).toHaveAttribute("data-pvm-cache-hit", "true", {
    timeout: 60_000,
  });
  const warm = await readMetrics(canvas);
  expect(warm.backend).toBe("compiler");
  expect(warm.translationMs).toBe(0);
  expect(warm.firstFrameMs).toBeLessThan(1_000);
  await testInfo.attach("doom-pvm-warm-metrics.json", {
    body: Buffer.from(JSON.stringify(warm, null, 2)),
    contentType: "application/json",
  });
});
