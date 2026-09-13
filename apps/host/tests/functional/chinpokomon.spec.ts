// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runtime-variant proof for the shipped Chinpokomon product bundle.
 *
 * Unlike the synthetic fixtures in `polkavm.spec.ts`, this suite serves the real
 * `polkavm-apps/chinpokomon/bundle` directory, so it also covers the fallback's
 * sub-resource load (`/fallback/app.js`) through the sandbox service worker.
 *
 * Point `DOTLI_CHINPOKOMON_BUNDLE` at the built bundle to enable it.
 */

import { expect, test, type Page } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { SANDBOX_SCHEMA_VERSION } from "@dotli/config/host-sandbox-contract";
import { archiveCar, installTruapiPortResponder } from "./helpers/polkavm";

const bundleDir = process.env.DOTLI_CHINPOKOMON_BUNDLE;

async function bundleFiles(
  root: string,
  directory = root,
): Promise<Array<[string, Uint8Array]>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<[string, Uint8Array]> = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await bundleFiles(root, path)));
    } else {
      files.push([relative(root, path), new Uint8Array(await readFile(path))]);
    }
  }
  return files;
}

async function mountProduct(
  page: Page,
  label: string,
  frameId: string,
): Promise<{ manifest: string }> {
  const root = bundleDir as string;
  const files = await bundleFiles(root);
  const manifestEntry = files.find(([name]) => name === "manifest.json");
  if (manifestEntry === undefined) {
    throw new Error("chinpokomon bundle has no manifest.json");
  }
  const manifest = new TextDecoder().decode(manifestEntry[1]);
  const fixture = await archiveCar(files);
  await installTruapiPortResponder(page);
  await page.route(`**/ipfs/${fixture.cid}?format=car`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.ipld.car",
      body: Buffer.from(fixture.bytes),
    });
  });
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ cid, executableManifest, schemaVersion, host, id }) => {
      const url = new URL(`http://${host}.app.localhost:5173/`);
      url.searchParams.set("cid", cid);
      url.searchParams.set("v", String(schemaVersion));
      url.searchParams.set("chainBackend", "rpc-gateway");
      url.searchParams.set("network", "paseo-next-v2");
      url.searchParams.set("executableManifest", executableManifest);
      const iframe = document.createElement("iframe");
      iframe.id = id;
      iframe.style.width = "480px";
      iframe.style.height = "640px";
      iframe.src = url.toString();
      document.body.replaceChildren(iframe);
    },
    {
      cid: fixture.cid,
      executableManifest: manifest,
      schemaVersion: SANDBOX_SCHEMA_VERSION,
      host: label,
      id: frameId,
    },
  );
  return { manifest };
}

test.describe("Chinpokomon runtime variants", () => {
  test.skip(
    bundleDir === undefined,
    "DOTLI_CHINPOKOMON_BUNDLE must point at the built bundle",
  );

  test("renders the WebGL fallback when the browser has no WebGPU adapter", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        value: undefined,
      });
    });
    await mountProduct(page, "chinpokomon-fallback", "chinpokomon-fallback");

    const product = page.frameLocator("#chinpokomon-fallback");
    const canvas = product.locator("canvas[data-runtime='webgl-fallback']");
    await expect(canvas).toHaveCount(1, { timeout: 30_000 });
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-frames")), {
        timeout: 30_000,
      })
      .toBeGreaterThan(2);
    await expect(product.locator("#dotli-polkavm-canvas")).toHaveCount(0);
  });

  test("runs the PolkaVM program when the browser exposes a WebGPU adapter", async ({
    page,
  }) => {
    test.skip(
      process.env.DOTLI_WEBGPU !== "1",
      "DOTLI_WEBGPU=1 enables the SwiftShader WebGPU adapter",
    );
    await mountProduct(page, "chinpokomon-polkavm", "chinpokomon-polkavm");

    const product = page.frameLocator("#chinpokomon-polkavm");
    const canvas = product.locator("#dotli-polkavm-canvas");
    await expect(canvas).toHaveAttribute(
      "data-polkavm-profile",
      "webgpu-raster",
      {
        timeout: 60_000,
      },
    );
    await expect(canvas).toHaveAttribute("data-polkavm-ready", "true", {
      timeout: 120_000,
    });
    await expect
      .poll(
        async () => Number(await canvas.getAttribute("data-polkavm-frames")),
        {
          timeout: 120_000,
        },
      )
      .toBeGreaterThan(2);
    await expect(
      product.locator("canvas[data-runtime='webgl-fallback']"),
    ).toHaveCount(0);
  });
});
