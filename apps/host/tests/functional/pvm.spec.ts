// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, type Page } from "@playwright/test";
import { CarReader, CarWriter } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import type { PBLink } from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SANDBOX_SCHEMA_VERSION } from "@dotli/config/host-sandbox-contract";

interface TestCar {
  cid: string;
  bytes: Uint8Array;
}

async function pvmCar(): Promise<TestCar> {
  const fixture = join(import.meta.dirname, "fixtures/pvm");
  const files = await Promise.all(
    [
      ["manifest.json", join(fixture, "manifest.json")],
      ["app.polkavm", join(fixture, "framebuffer-test.polkavm")],
    ].map(async ([name, path]) => {
      const bytes = new Uint8Array(await readFile(path));
      const cid = CID.createV1(raw.code, await sha256.digest(bytes));
      return { name, bytes, cid };
    }),
  );
  const runtimeOverride = new TextEncoder().encode("package-owned runtime");
  files.push({
    name: "pvm-runtime/pvm-browser-runtime.wasm",
    bytes: runtimeOverride,
    cid: CID.createV1(raw.code, await sha256.digest(runtimeOverride)),
  });
  const links: PBLink[] = files
    .map(({ name, bytes, cid }) => ({
      Name: name,
      Tsize: bytes.length,
      Hash: cid,
    }))
    .sort((left, right) => (left.Name ?? "").localeCompare(right.Name ?? ""));
  const rootBytes = dagPb.encode({
    Data: new UnixFS({ type: "directory" }).marshal(),
    Links: links,
  });
  const root = CID.createV1(dagPb.code, await sha256.digest(rootBytes));
  const { writer, out } = CarWriter.create([root]);
  const chunksPromise = (async (): Promise<Uint8Array[]> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of out) chunks.push(chunk);
    return chunks;
  })();
  for (const { cid, bytes } of files) await writer.put({ cid, bytes });
  await writer.put({ cid: root, bytes: rootBytes });
  await writer.close();
  const chunks = await chunksPromise;
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const car = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    car.set(chunk, offset);
    offset += chunk.length;
  }
  return { cid: root.toString(), bytes: car };
}

async function installTruapiPortResponder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const channel = new MessageChannel();
    const scope = window as typeof window & {
      __HOST_API_PORT__?: MessagePort;
    };
    channel.port2.onmessage = (event) => {
      if (!(event.data instanceof Uint8Array)) {
        return;
      }
      const request = event.data;
      const first = request[0];
      if (first === undefined || (first & 3) !== 0) {
        return;
      }
      const kindOffset = 1 + (first >> 2);
      if (
        request.length !== kindOffset + 3 ||
        request[kindOffset] !== 0 ||
        request[kindOffset + 1] !== 0 ||
        request[kindOffset + 2] !== 1
      ) {
        return;
      }
      const response = new Uint8Array(kindOffset + 3);
      response.set(request.subarray(0, kindOffset));
      response[kindOffset] = 1;
      response[kindOffset + 1] = 0;
      response[kindOffset + 2] = 0;
      channel.port2.postMessage(response, [response.buffer]);
    };
    channel.port2.start();
    scope.__HOST_API_PORT__ = channel.port1;
  });
}

test("a verified PolkaVM package translates and renders in the sandbox", async ({
  page,
}) => {
  const fixture = await pvmCar();
  await page.route(`**/ipfs/${fixture.cid}?format=car`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.ipld.car",
      body: Buffer.from(fixture.bytes),
    });
  });
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  await installTruapiPortResponder(page);
  await page.evaluate(
    ({ cid, schemaVersion }) => {
      const iframe = document.createElement("iframe");
      iframe.id = "pvm-product";
      iframe.src = `http://pvm-fixture.app.localhost:5173/?cid=${cid}&v=${String(schemaVersion)}&chainBackend=rpc-gateway&network=paseo-next-v2&fullReset=1`;
      document.body.replaceChildren(iframe);
    },
    { cid: fixture.cid, schemaVersion: SANDBOX_SCHEMA_VERSION },
  );

  const product = page.frameLocator("#pvm-product");
  const canvas = product.locator("#dotli-pvm-canvas");
  await expect(canvas).toHaveAttribute("data-pvm-ready", "true", {
    timeout: 30_000,
  });
  await expect(canvas).toHaveAttribute("data-pvm-backend", "compiler");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-pvm-frames")))
    .toBeGreaterThan(2);
  await expect(canvas).toHaveAttribute("width", "320");
  await expect(canvas).toHaveAttribute("height", "200");

  // The host-owned PVM canvas retains its verified launch contract so a
  // browser/frame reload restarts the same CID without relying on parent state.
  const productFrame = page
    .frames()
    .find((frame) => frame.url().includes("pvm-fixture.app.localhost"));
  if (productFrame === undefined) {
    throw new Error("PVM product frame did not mount");
  }
  expect(new URL(productFrame.url()).searchParams.get("cid")).toBe(fixture.cid);
  expect(new URL(productFrame.url()).searchParams.has("fullReset")).toBe(false);
  await Promise.all([
    productFrame.waitForNavigation({ waitUntil: "domcontentloaded" }),
    productFrame.evaluate(() => {
      window.location.reload();
    }),
  ]);
  await expect(canvas).toHaveAttribute("data-pvm-cache-hit", "true", {
    timeout: 30_000,
  });
  await expect(canvas).toHaveAttribute("data-pvm-translation-ms", "0");
});

test("a PolkaVM package can bypass translation and use the interpreter", async ({
  page,
}) => {
  const fixture = await pvmCar();
  await page.route(`**/ipfs/${fixture.cid}?format=car`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.ipld.car",
      body: Buffer.from(fixture.bytes),
    });
  });
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  await installTruapiPortResponder(page);
  await page.evaluate(
    ({ cid, schemaVersion }) => {
      const iframe = document.createElement("iframe");
      iframe.id = "pvm-interpreter-product";
      iframe.src = `http://pvm-fixture.app.localhost:5173/?cid=${cid}&v=${String(schemaVersion)}&chainBackend=rpc-gateway&network=paseo-next-v2&pvmMode=interpreter`;
      document.body.replaceChildren(iframe);
    },
    { cid: fixture.cid, schemaVersion: SANDBOX_SCHEMA_VERSION },
  );

  const canvas = page
    .frameLocator("#pvm-interpreter-product")
    .locator("#dotli-pvm-canvas");
  await expect(canvas).toHaveAttribute("data-pvm-ready", "true", {
    timeout: 30_000,
  });
  await expect(canvas).toHaveAttribute("data-pvm-backend", "interpreter");
  await expect(canvas).toHaveAttribute("data-pvm-translation-ms", "0");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-pvm-frames")))
    .toBeGreaterThan(2);
  await expect(canvas).toHaveAttribute("data-pvm-startup-stage", "first-frame");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-pvm-updates")))
    .toBeGreaterThan(0);
});

const doomV2CarPath = process.env.DOTLI_DOOM_V2_CAR;
const doomV2ManifestPath = process.env.DOTLI_DOOM_V2_MANIFEST;
const expectedV2Backend = process.env.DOTLI_PVM_EXPECTED_BACKEND ?? "compiler";
const expectedV2Profile = process.env.DOTLI_PVM_EXPECTED_PROFILE;
const expectedTruapi = process.env.DOTLI_PVM_EXPECTED_TRUAPI === "1";
const expectedResize = process.env.DOTLI_PVM_EXPECTED_RESIZE === "1";
const expectedInputKeys = (process.env.DOTLI_PVM_INPUT_KEYS ?? "ArrowUp,Space")
  .split(",")
  .filter(Boolean);

test("the canonical Doom App v2 artifact renders with exact manifest bytes", async ({
  page,
}) => {
  test.skip(
    doomV2CarPath === undefined || doomV2ManifestPath === undefined,
    "DOTLI_DOOM_V2_CAR and DOTLI_DOOM_V2_MANIFEST are required",
  );
  const carBytes = new Uint8Array(await readFile(doomV2CarPath as string));
  const manifest = await readFile(doomV2ManifestPath as string, "utf8");
  const manifestValue = JSON.parse(manifest) as {
    capabilities?: {
      deviceInput?: { requiredFeatures?: unknown };
    };
  };
  const expectedPointerLock =
    Array.isArray(manifestValue.capabilities?.deviceInput?.requiredFeatures) &&
    manifestValue.capabilities.deviceInput.requiredFeatures.includes(
      "relative-pointer",
    );
  const reader = await CarReader.fromBytes(carBytes);
  const [root] = await reader.getRoots();
  if (root === undefined) throw new Error("Doom v2 CAR has no root");
  const cid = root.toString();
  await page.route(`**/ipfs/${cid}?format=car`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.ipld.car",
      body: Buffer.from(carBytes),
    });
  });
  await page.goto("http://localhost:5173/", {
    waitUntil: "domcontentloaded",
  });
  await installTruapiPortResponder(page);
  await page.evaluate(
    ({ artifactCid, executableManifest, schemaVersion }) => {
      const url = new URL(
        `http://doom-v2.app.localhost:5173/?cid=${artifactCid}&v=${String(schemaVersion)}&chainBackend=rpc-gateway&network=paseo-next-v2`,
      );
      url.searchParams.set("executableManifest", executableManifest);
      const iframe = document.createElement("iframe");
      iframe.id = "doom-v2-product";
      iframe.src = url.toString();
      document.body.replaceChildren(iframe);
    },
    {
      artifactCid: cid,
      executableManifest: manifest,
      schemaVersion: SANDBOX_SCHEMA_VERSION,
    },
  );

  const canvas = page
    .frameLocator("#doom-v2-product")
    .locator("#dotli-pvm-canvas");
  await expect(canvas).toHaveAttribute("data-pvm-ready", "true", {
    timeout: 60_000,
  });
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-pvm-frames")), {
      timeout: 60_000,
    })
    .toBeGreaterThan(2);
  await expect(canvas).toHaveAttribute("data-pvm-backend", expectedV2Backend);
  if (expectedV2Profile !== undefined) {
    await expect(canvas).toHaveAttribute("data-pvm-profile", expectedV2Profile);
  }
  if (expectedV2Profile === "tri2d") {
    await expect
      .poll(async () =>
        Number(await canvas.getAttribute("data-pvm-tri2d-draws")),
      )
      .toBeGreaterThan(0);
  } else if (expectedV2Profile === "webgpu-raster") {
    await expect(canvas).toHaveAttribute("data-pvm-gpu", "ready");
  }
  if (expectedTruapi) {
    await expect
      .poll(async () =>
        Number(await canvas.getAttribute("data-pvm-truapi-requests")),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () =>
        Number(await canvas.getAttribute("data-pvm-truapi-responses")),
      )
      .toBeGreaterThan(0);
  }
  if (expectedResize) {
    const framesBeforeResize = Number(
      await canvas.getAttribute("data-pvm-frames"),
    );
    await page.locator("#doom-v2-product").evaluate((iframe) => {
      iframe.style.width = "100vw";
      iframe.style.height = "100vh";
    });
    await page.setViewportSize({ width: 960, height: 640 });
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-pvm-frames")))
      .toBeGreaterThan(framesBeforeResize);
    await expect(canvas).toHaveAttribute("data-pvm-ready", "true");
    if (expectedV2Profile === "webgpu-raster") {
      await expect(canvas).toHaveAttribute("data-pvm-gpu", "ready");
    }
  }
  const framesBeforeInput = Number(
    await canvas.getAttribute("data-pvm-frames"),
  );
  await canvas.click({ position: { x: 160, y: 100 } });
  const productFrame = page
    .frames()
    .find((frame) => frame.url().includes("doom-v2.app.localhost"));
  if (productFrame === undefined) {
    throw new Error("App v2 product frame did not mount");
  }
  if (expectedPointerLock) {
    await expect
      .poll(async () =>
        productFrame.evaluate(() => document.pointerLockElement?.id ?? null),
      )
      .toBe("dotli-pvm-canvas");
    await page.keyboard.press("Escape");
    await expect
      .poll(async () =>
        productFrame.evaluate(() => document.pointerLockElement?.id ?? null),
      )
      .toBeNull();
    await canvas.click({ position: { x: 160, y: 100 } });
  } else {
    await expect
      .poll(async () =>
        productFrame.evaluate(() => document.pointerLockElement?.id ?? null),
      )
      .toBeNull();
  }
  if (expectedInputKeys.length > 0) {
    for (const key of expectedInputKeys) {
      await page.keyboard.press(key);
    }
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-pvm-frames")))
      .toBeGreaterThan(framesBeforeInput);
  }
});
