// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { seedBackend } from "../functional/fixtures/settings";
import type { Backend } from "../functional/fixtures/settings";

const PORT = process.env.PERF_PORT ?? "5173";
const DOOM_URL = `http://doom.localhost:${PORT}/`;
const QUAKE_URL = `http://quake.localhost:${PORT}/`;
const DUKE_URL = `http://duke.localhost:${PORT}/`;

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

async function launchDoom(
  page: Page,
  backend: Backend = "rpc-gateway",
): Promise<void> {
  await seedBackend(page, backend);
  await page.goto(DOOM_URL, { waitUntil: "domcontentloaded" });
}

test("doom.paseo receives its required App v2 manifest over smoldot", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await launchDoom(page, "smoldot-direct");

  const productFrame = page.locator('iframe[src*="doom.app.localhost"]');
  await expect(productFrame).toHaveAttribute("src", /[?&]executableManifest=/, {
    timeout: 120_000,
  });

  const canvas = page
    .frameLocator('iframe[src*="doom.app.localhost"]')
    .locator("#dotli-pvm-canvas");
  await expect(canvas).toHaveAttribute("data-pvm-ready", "true", {
    timeout: 60_000,
  });
});

test("quake.paseo advances frames through the translated runtime", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await seedBackend(page, "smoldot-direct");
  await page.goto(QUAKE_URL, { waitUntil: "domcontentloaded" });

  const canvas = page
    .frameLocator('iframe[src*="quake.app.localhost"]')
    .locator("#dotli-pvm-canvas");
  await expect(canvas).toHaveAttribute("data-pvm-ready", "true", {
    timeout: 120_000,
  });
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-pvm-frames")), {
      timeout: 30_000,
    })
    .toBeGreaterThan(120);
  expect(await canvas.getAttribute("data-pvm-backend")).toBe("compiler");
});

test("duke.paseo continues across bounded translated hostcall slices", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await seedBackend(page, "smoldot-direct");
  await page.goto(DUKE_URL, { waitUntil: "domcontentloaded" });

  const product = page.frameLocator('iframe[src*="duke.app.localhost"]');
  const canvas = product.locator("#dotli-pvm-canvas");
  await expect(canvas).toHaveAttribute("data-pvm-ready", "true", {
    timeout: 120_000,
  });
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-pvm-updates")), {
      timeout: 30_000,
    })
    .toBeGreaterThan(120);
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-pvm-frames")), {
      timeout: 30_000,
    })
    .toBeGreaterThan(120);
  await expect(product.locator("body")).not.toContainText(
    "exceeded hostcall budget",
  );
  expect(await canvas.getAttribute("data-pvm-backend")).toBe("compiler");
  await canvas.click();
  await page.waitForTimeout(8_000);
  const audioBefore = Number(
    await canvas.getAttribute("data-pvm-audio-samples"),
  );
  await page.waitForTimeout(8_000);
  const audioAfter = Number(
    await canvas.getAttribute("data-pvm-audio-samples"),
  );
  expect(audioAfter - audioBefore).toBeGreaterThan(300_000);
  await expect(canvas).toHaveAttribute("data-pvm-audio-nonzero", "true");
});

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
  await expect(canvas).toHaveAttribute("data-pvm-ready", "true", {
    timeout: 60_000,
  });
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
