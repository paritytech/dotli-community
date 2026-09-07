// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, type Locator, type Page } from "@playwright/test";

interface ProductSmoke {
  label: string;
  profile: "framebuffer" | "tri2d" | "webgpu-raster";
  keys: readonly string[];
  audio: boolean;
  nonzeroAudio: boolean;
}

const products: readonly ProductSmoke[] = [
  {
    label: "doom",
    profile: "framebuffer",
    keys: ["Escape", "Enter", "Enter", "Enter", "w", "Space"],
    audio: true,
    nonzeroAudio: true,
  },
  {
    label: "quake",
    profile: "framebuffer",
    keys: ["Escape", "Enter", "ArrowUp", "Space"],
    audio: true,
    nonzeroAudio: false,
  },
  {
    label: "duke",
    profile: "framebuffer",
    keys: ["Escape", "Enter", "Enter", "Space"],
    audio: true,
    nonzeroAudio: true,
  },
  {
    label: "egui-app-lab",
    profile: "tri2d",
    keys: ["Tab", "Enter", "Tab"],
    audio: false,
    nonzeroAudio: false,
  },
  {
    label: "lot-lab",
    profile: "webgpu-raster",
    keys: ["1", "2", "3", "4", "Space"],
    audio: false,
    nonzeroAudio: false,
  },
];

const root = process.env.DOTLI_SMOKE_ROOT ?? "westendli.dev";
if (!/^[a-z0-9.-]+$/.test(root)) {
  throw new Error(`DOTLI_SMOKE_ROOT is not a valid host suffix: ${root}`);
}

const runtimeFailure =
  /Failed to load content|runtime requires ABI version|No connected peers|execution trapped|exceeded hostcall budget/i;

async function counter(canvas: Locator, name: string): Promise<number> {
  return Number((await canvas.getAttribute(name)) ?? 0);
}

async function smokeProduct(
  page: Page,
  product: ProductSmoke,
): Promise<Record<string, unknown>> {
  const productUrl = `https://${product.label}.${root}/`;
  const iframeSelector = `iframe[src*="${product.label}.app.${root}"]`;

  await page.goto(productUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  const iframe = page.locator(iframeSelector);
  await expect(iframe).toBeAttached({ timeout: 180_000 });
  const iframeSource = await iframe.getAttribute("src");
  if (iframeSource === null) {
    throw new Error(`${product.label}: product iframe has no src`);
  }

  const encodedManifest = new URL(iframeSource).searchParams.get(
    "executableManifest",
  );
  let manifest: Record<string, unknown> | null = null;
  if (encodedManifest !== null) {
    manifest = JSON.parse(encodedManifest) as {
      $v?: number;
      kind?: string;
      runtime?: { kind?: string; abiVersion?: number };
    };
    expect(manifest.$v, `${product.label}: App manifest version`).toBe(2);
    expect(manifest.kind, `${product.label}: executable kind`).toBe("app");
    const runtime = manifest.runtime as
      | { kind?: string; abiVersion?: number }
      | undefined;
    expect(runtime?.kind, `${product.label}: runtime kind`).toBe("polkavm");
    expect(runtime?.abiVersion, `${product.label}: runtime ABI`).toBe(1);
  }

  const frame = page.frameLocator(iframeSelector);
  const body = frame.locator("body");
  const canvas = frame.locator("#dotli-polkavm-canvas");
  await Promise.race([
    expect(canvas).toHaveAttribute("data-polkavm-ready", "true", {
      timeout: 180_000,
    }),
    (async () => {
      await body.getByText(runtimeFailure).first().waitFor({
        state: "visible",
        timeout: 180_000,
      });
      throw new Error(
        `${product.label}: runtime failed\n${(await body.innerText()).trim()}`,
      );
    })(),
  ]);

  await expect(canvas).toHaveAttribute("data-polkavm-profile", product.profile);
  await expect(canvas).toHaveAttribute("data-polkavm-backend", "compiler");
  await expect(body).not.toContainText(runtimeFailure);
  if (product.profile === "webgpu-raster") {
    await expect(canvas).toHaveAttribute("data-polkavm-gpu", "ready");
  }

  const framesBefore = await counter(canvas, "data-polkavm-frames");
  const updatesBefore = await counter(canvas, "data-polkavm-updates");
  const audioBefore = await counter(canvas, "data-polkavm-audio-samples");

  await canvas.click({ position: { x: 160, y: 100 } });
  for (const key of product.keys) await page.keyboard.press(key);

  await expect
    .poll(() => counter(canvas, "data-polkavm-frames"), { timeout: 30_000 })
    .toBeGreaterThan(framesBefore + 30);
  await expect
    .poll(() => counter(canvas, "data-polkavm-updates"), { timeout: 30_000 })
    .toBeGreaterThan(updatesBefore + 30);

  if (product.audio) {
    await expect
      .poll(() => counter(canvas, "data-polkavm-audio-samples"), {
        timeout: 30_000,
      })
      .toBeGreaterThan(audioBefore);
    if (product.nonzeroAudio) {
      await expect(canvas).toHaveAttribute(
        "data-polkavm-audio-nonzero",
        "true",
      );
    }
  } else if (product.profile === "tri2d") {
    await expect
      .poll(() => counter(canvas, "data-polkavm-tri2d-draws"), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
  }

  if (product.profile !== "framebuffer") {
    const framesBeforeResize = await counter(canvas, "data-polkavm-frames");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => counter(canvas, "data-polkavm-frames"), { timeout: 30_000 })
      .toBeGreaterThan(framesBeforeResize);
  }

  return {
    product: product.label,
    manifest,
    backend: await canvas.getAttribute("data-polkavm-backend"),
    profile: await canvas.getAttribute("data-polkavm-profile"),
    gpu: await canvas.getAttribute("data-polkavm-gpu"),
    frames: await counter(canvas, "data-polkavm-frames"),
    updates: await counter(canvas, "data-polkavm-updates"),
    audioSamples: await counter(canvas, "data-polkavm-audio-samples"),
    tri2dDraws: await counter(canvas, "data-polkavm-tri2d-draws"),
  };
}

test("published PolkaVM products reach playable states", async ({
  browser,
}, testInfo) => {
  const failures: string[] = [];

  for (const product of products) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    try {
      const metrics = await test.step(product.label, () =>
        smokeProduct(page, product),
      );
      await testInfo.attach(`${product.label}-smoke.json`, {
        body: Buffer.from(JSON.stringify(metrics, null, 2)),
        contentType: "application/json",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${product.label}: ${message}`);
      await testInfo.attach(`${product.label}-failure.png`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    } finally {
      await context.close();
    }
  }

  expect(failures, failures.join("\n\n")).toEqual([]);
});
