// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, type Page } from "@playwright/test";
import { CarReader } from "@ipld/car";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SANDBOX_SCHEMA_VERSION } from "@dotli/config/host-sandbox-contract";
import {
  archiveCar,
  installRepeatedTruapiPortResponder,
  installTruapiPortResponder,
  type TestCar,
} from "./helpers/polkavm";

async function polkavmCar(): Promise<TestCar> {
  const fixture = join(import.meta.dirname, "fixtures/polkavm");
  const manifest = new Uint8Array(
    await readFile(join(fixture, "manifest.json")),
  );
  const program = new Uint8Array(
    await readFile(join(fixture, "framebuffer-test.polkavm")),
  );
  return archiveCar([
    ["manifest.json", manifest],
    ["app.polkavm", program],
  ]);
}

async function fileInputCar(): Promise<TestCar & { manifest: string }> {
  const fixture = join(import.meta.dirname, "fixtures/polkavm");
  const manifest = JSON.stringify({
    $v: 2,
    kind: "app",
    appVersion: [1, 0, 0],
    runtime: {
      kind: "polkavm",
      abiVersion: 1,
      entrypoint: "app.polkavm",
    },
    capabilities: {
      graphics: {
        abiVersion: 1,
        profile: "framebuffer",
        requiredFeatures: [],
      },
      fileInput: {
        abiVersion: 1,
        handlers: [
          {
            id: "snes-rom",
            label: "SNES cartridge image",
            extensions: [".sfc"],
            maxBytes: 1024,
            mountPath: "game/cartridge.sfc",
          },
        ],
      },
    },
  });
  const car = await archiveCar([
    ["manifest.json", new TextEncoder().encode(manifest)],
    [
      "app.polkavm",
      new Uint8Array(await readFile(join(fixture, "framebuffer-test.polkavm"))),
    ],
  ]);
  return { ...car, manifest };
}

async function webGpuFallbackCar(): Promise<TestCar & { manifest: string }> {
  const fixture = join(import.meta.dirname, "fixtures/polkavm");
  const manifest = JSON.stringify({
    $v: 2,
    kind: "app",
    appVersion: [1, 0, 0],
    runtime: {
      kind: "polkavm",
      abiVersion: 1,
      entrypoint: "app.polkavm",
      fallback: { kind: "web", entrypoint: "fallback/index.html" },
    },
    capabilities: {
      graphics: {
        abiVersion: 1,
        profile: "webgpu-raster",
        requiredFeatures: [],
        requiredLimits: {
          maxTextureDimension2D: 4096,
          maxBufferSize: 1024,
          maxBindingsPerBindGroup: 3,
        },
      },
    },
  });
  const car = await archiveCar([
    ["manifest.json", new TextEncoder().encode(manifest)],
    [
      "app.polkavm",
      new Uint8Array(await readFile(join(fixture, "framebuffer-test.polkavm"))),
    ],
    [
      "fallback/index.html",
      new TextEncoder().encode(
        '<main id="webgl-fallback">WebGL fallback selected</main>',
      ),
    ],
  ]);
  return { ...car, manifest };
}

async function waitForHostInitialization(page: Page): Promise<void> {
  await page.waitForFunction(
    () => performance.getEntriesByName("dotli:main:end").length > 0,
  );
}

test("a verified PolkaVM package translates and renders in the sandbox", async ({
  page,
}) => {
  const fixture = await polkavmCar();
  await page.route(`**/ipfs/${fixture.cid}?format=car`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.ipld.car",
      body: Buffer.from(fixture.bytes),
    });
  });
  await page.goto("http://polkavm-fixture.localhost:5173/", {
    waitUntil: "domcontentloaded",
  });
  await waitForHostInitialization(page);
  await installTruapiPortResponder(page);
  await page.evaluate(
    ({ cid, schemaVersion }) => {
      const iframe = document.createElement("iframe");
      iframe.id = "polkavm-product";
      iframe.style.width = "400px";
      iframe.style.height = "400px";
      iframe.style.border = "0";
      iframe.src = `http://polkavm-fixture.app.localhost:5173/?cid=${cid}&v=${String(schemaVersion)}&chainBackend=rpc-gateway&network=paseo-next-v2&fullReset=1`;
      document.body.replaceChildren(iframe);
    },
    { cid: fixture.cid, schemaVersion: SANDBOX_SCHEMA_VERSION },
  );

  const product = page.frameLocator("#polkavm-product");
  const canvas = product.locator("#dotli-polkavm-canvas");
  await expect(canvas).toHaveAttribute("data-polkavm-ready", "true", {
    timeout: 30_000,
  });
  await expect(canvas).toHaveAttribute("data-polkavm-backend", "compiler");
  await expect(canvas).toHaveAttribute(
    "data-polkavm-safe-area-insets",
    "0,0,0,0",
  );
  await page.locator("#polkavm-product").evaluate((element) => {
    if (
      !(element instanceof HTMLIFrameElement) ||
      element.contentWindow === null
    ) {
      throw new Error("PolkaVM product frame is unavailable");
    }
    element.contentWindow.postMessage(
      {
        type: "dotli:polkavm-view-insets",
        keyboard: { left: 0, top: 0, right: 0, bottom: 180 },
      },
      "http://polkavm-fixture.app.localhost:5173",
    );
  });
  await expect(canvas).toHaveAttribute(
    "data-polkavm-keyboard-insets",
    "0,0,0,180",
  );
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-polkavm-frames")))
    .toBeGreaterThan(2);
  await expect(canvas).toHaveAttribute("width", "320");
  await expect(canvas).toHaveAttribute("height", "200");
  const expectCanvasFits = async (
    viewportWidth: number,
    viewportHeight: number,
  ) => {
    await expect(async () => {
      const geometry = await canvas.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const surface = element.parentElement!.getBoundingClientRect();
        return {
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          width: bounds.width,
          height: bounds.height,
          centerX: bounds.left + bounds.width / 2,
          centerY: bounds.top + bounds.height / 2,
          surfaceWidth: surface.width,
          surfaceHeight: surface.height,
          surfaceCenterX: surface.left + surface.width / 2,
          surfaceCenterY: surface.top + surface.height / 2,
        };
      });
      expect(geometry.viewportWidth).toBe(viewportWidth);
      expect(geometry.viewportHeight).toBe(viewportHeight);
      // Fit and center in the drawable surface, independent of host chrome.
      const width = Math.min(
        geometry.surfaceWidth,
        geometry.surfaceHeight * 1.6,
      );
      expect(geometry.width).toBeCloseTo(width, 1);
      expect(geometry.height).toBeCloseTo(width / 1.6, 1);
      expect(geometry.centerX).toBeCloseTo(geometry.surfaceCenterX, 1);
      expect(geometry.centerY).toBeCloseTo(geometry.surfaceCenterY, 1);
    }).toPass();
  };
  await expectCanvasFits(400, 400);
  const productElement = page.locator("#polkavm-product");
  await productElement.evaluate((element) => {
    element.style.width = "640px";
    element.style.height = "300px";
  });
  await expectCanvasFits(640, 300);
  await productElement.evaluate((element) => {
    element.style.width = "200px";
    element.style.height = "400px";
  });
  await expectCanvasFits(200, 400);

  // The host-owned PolkaVM canvas retains its verified launch contract so a
  // browser/frame reload restarts the same CID without relying on parent state.
  const productFrame = page
    .frames()
    .find((frame) => frame.url().includes("polkavm-fixture.app.localhost"));
  if (productFrame === undefined) {
    throw new Error("PolkaVM product frame did not mount");
  }
  expect(new URL(productFrame.url()).searchParams.get("cid")).toBe(fixture.cid);
  expect(new URL(productFrame.url()).searchParams.has("fullReset")).toBe(false);
  await Promise.all([
    productFrame.waitForNavigation({ waitUntil: "domcontentloaded" }),
    productFrame.evaluate(() => {
      window.location.reload();
    }),
  ]);
  await expect(canvas).toHaveAttribute("data-polkavm-cache-hit", "true", {
    timeout: 30_000,
  });
  await expect(canvas).toHaveAttribute("data-polkavm-translation-ms", "0");
  const teardown = await productFrame.evaluate(() => {
    const target = document.querySelector("#dotli-polkavm-canvas");
    if (!(target instanceof HTMLCanvasElement)) {
      throw new Error("PolkaVM canvas is unavailable");
    }
    let locked = true;
    let releases = 0;
    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      get: () => (locked ? target : null),
    });
    Object.defineProperty(document, "exitPointerLock", {
      configurable: true,
      value: () => {
        releases++;
        locked = false;
        document.dispatchEvent(new Event("pointerlockchange"));
      },
    });
    document.dispatchEvent(new Event("pointerlockchange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    return {
      captured: target.dataset.polkavmPointerCaptured,
      releases,
    };
  });
  expect(teardown).toEqual({ captured: "false", releases: 1 });
});

test("a WebGPU PolkaVM package selects its web fallback without an adapter", async ({
  page,
}) => {
  const fixture = await webGpuFallbackCar();
  await page.addInitScript(() => {
    if (window.location.hostname === "polkavm-fallback.app.localhost") {
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        value: { requestAdapter: () => Promise.resolve(null) },
      });
    }
  });
  await page.route(`**/ipfs/${fixture.cid}?format=car`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.ipld.car",
      body: Buffer.from(fixture.bytes),
    });
  });
  await page.goto("http://localhost:5173/", {
    waitUntil: "domcontentloaded",
  });
  await waitForHostInitialization(page);
  await installTruapiPortResponder(page);
  await page.evaluate(
    ({ cid, manifest, schemaVersion }) => {
      const url = new URL("http://polkavm-fallback.app.localhost:5173/");
      url.searchParams.set("cid", cid);
      url.searchParams.set("v", String(schemaVersion));
      url.searchParams.set("chainBackend", "rpc-gateway");
      url.searchParams.set("network", "paseo-next-v2");
      url.searchParams.set("executableManifest", manifest);
      const iframe = document.createElement("iframe");
      iframe.id = "polkavm-fallback-product";
      iframe.src = url.toString();
      document.body.replaceChildren(iframe);
    },
    {
      cid: fixture.cid,
      manifest: fixture.manifest,
      schemaVersion: SANDBOX_SCHEMA_VERSION,
    },
  );

  const product = page.frameLocator("#polkavm-fallback-product");
  await expect(product.locator("#webgl-fallback")).toHaveText(
    "WebGL fallback selected",
  );
  await expect(product.locator("#dotli-polkavm-canvas")).toHaveCount(0);
});

test("a PolkaVM package can bypass translation and use the interpreter", async ({
  page,
}) => {
  const fixture = await polkavmCar();
  await page.route(`**/ipfs/${fixture.cid}?format=car`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.ipld.car",
      body: Buffer.from(fixture.bytes),
    });
  });
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  await waitForHostInitialization(page);
  await installTruapiPortResponder(page);
  await page.evaluate(
    ({ cid, schemaVersion }) => {
      const iframe = document.createElement("iframe");
      iframe.id = "polkavm-interpreter-product";
      iframe.src = `http://polkavm-fixture.app.localhost:5173/?cid=${cid}&v=${String(schemaVersion)}&chainBackend=rpc-gateway&network=paseo-next-v2&polkavmMode=interpreter`;
      document.body.replaceChildren(iframe);
    },
    { cid: fixture.cid, schemaVersion: SANDBOX_SCHEMA_VERSION },
  );

  const canvas = page
    .frameLocator("#polkavm-interpreter-product")
    .locator("#dotli-polkavm-canvas");
  await expect(canvas).toHaveAttribute("data-polkavm-ready", "true", {
    timeout: 30_000,
  });
  await expect(canvas).toHaveAttribute("data-polkavm-backend", "interpreter");
  await expect(canvas).toHaveAttribute("data-polkavm-translation-ms", "0");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-polkavm-frames")))
    .toBeGreaterThan(2);
  await expect(canvas).toHaveAttribute(
    "data-polkavm-startup-stage",
    "first-frame",
  );
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-polkavm-updates")))
    .toBeGreaterThan(0);
});

test("shows PolkaVM diagnostics inside the docked debug panel", async ({
  page,
}) => {
  const fixture = await polkavmCar();
  await page.route(`**/ipfs/${fixture.cid}?format=car`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.ipld.car",
      body: Buffer.from(fixture.bytes),
    });
  });
  await page.goto("http://polkavm-fixture.localhost:5173/?debug=true", {
    waitUntil: "domcontentloaded",
  });
  await installTruapiPortResponder(page);

  const panel = page.locator("#truapi-debug-panel");
  await expect(panel).toBeVisible();
  await page.evaluate(
    ({ cid, schemaVersion }) => {
      const app = document.querySelector("#app");
      if (app === null) {
        throw new Error("host app container is missing");
      }
      const iframe = document.createElement("iframe");
      iframe.id = "polkavm-debug-product";
      iframe.style.cssText = "width:100%;height:100%;border:0";
      iframe.src = `http://polkavm-fixture.app.localhost:5173/?cid=${cid}&v=${String(schemaVersion)}&chainBackend=rpc-gateway&network=paseo-next-v2&fullReset=1`;
      app.replaceChildren(iframe);
      window.dispatchEvent(
        new CustomEvent("dotli:product-loaded", {
          detail: { label: "polkavm-fixture", productId: "polkavm-fixture" },
        }),
      );
    },
    { cid: fixture.cid, schemaVersion: SANDBOX_SCHEMA_VERSION },
  );

  const product = page.frameLocator("#polkavm-debug-product");
  const canvas = product.locator("#dotli-polkavm-canvas");
  await expect(canvas).toHaveAttribute("data-polkavm-ready", "true", {
    timeout: 30_000,
  });
  await expect(product.locator("#dotli-polkavm-metrics")).toHaveCount(0);

  const runtimeBadge = panel.locator(".td-runtime-badge");
  await expect(runtimeBadge).toContainText("PVM JIT · FF");
  await expect(runtimeBadge).toHaveAttribute(
    "title",
    /PolkaVM \/ JIT · first frame/,
  );
  await runtimeBadge.click();

  const runtime = panel.locator(".td-runtime");
  await expect(runtime).toBeVisible();
  await expect(runtime.locator('[data-runtime-metric="backend"]')).toHaveText(
    "JIT",
  );
  await expect(
    runtime.locator('[data-runtime-metric="first-frame"]'),
  ).not.toHaveText("pending");

  await panel.locator(".td-dock").click();
  await expect(panel).toHaveClass(/docked-right/);
  await expect(runtime).toBeVisible();
});

const doomV2CarPath = process.env.DOTLI_DOOM_V2_CAR;
const doomV2ManifestPath = process.env.DOTLI_DOOM_V2_MANIFEST;
const expectedV2Backend =
  process.env.DOTLI_POLKAVM_EXPECTED_BACKEND ?? "compiler";
const expectedV2Profile = process.env.DOTLI_POLKAVM_EXPECTED_PROFILE;
const expectedTruapi = process.env.DOTLI_POLKAVM_EXPECTED_TRUAPI === "1";
const expectedResize = process.env.DOTLI_POLKAVM_EXPECTED_RESIZE === "1";
const expectedMotion = process.env.DOTLI_POLKAVM_EXPECTED_MOTION === "1";
const expectedMotionSource =
  process.env.DOTLI_POLKAVM_EXPECTED_MOTION_SOURCE ?? "pointer";
const pointerLockUnavailable =
  process.env.DOTLI_POLKAVM_POINTER_LOCK_UNAVAILABLE === "1";
const expectedPointerCapture =
  process.env.DOTLI_POLKAVM_EXPECTED_POINTER_CAPTURE === "1";
const expectedInputKeys = (
  process.env.DOTLI_POLKAVM_INPUT_KEYS ?? "ArrowUp,Space"
)
  .split(",")
  .filter(Boolean);

test("the canonical Doom App v2 artifact renders with exact manifest bytes", async ({
  page,
}) => {
  test.skip(
    doomV2CarPath === undefined || doomV2ManifestPath === undefined,
    "DOTLI_DOOM_V2_CAR and DOTLI_DOOM_V2_MANIFEST are required",
  );
  await page.addInitScript(
    ({ disablePointerLock, physicalMotion }) => {
      if (disablePointerLock) {
        Object.defineProperty(
          HTMLCanvasElement.prototype,
          "requestPointerLock",
          {
            configurable: true,
            value: undefined,
          },
        );
      }
      if (physicalMotion) {
        Reflect.set(window, "__dotliMotionPermissionRequests", 0);
        class TestDeviceMotionEvent extends Event {
          static async requestPermission(): Promise<"granted"> {
            Reflect.set(
              window,
              "__dotliMotionPermissionRequests",
              Number(
                Reflect.get(window, "__dotliMotionPermissionRequests") ?? 0,
              ) + 1,
            );
            return "granted";
          }

          readonly accelerationIncludingGravity;
          readonly rotationRate;

          constructor(type: string, init: DeviceMotionEventInit = {}) {
            super(type);
            this.accelerationIncludingGravity =
              init.accelerationIncludingGravity ?? null;
            this.rotationRate = init.rotationRate ?? null;
          }
        }
        Object.defineProperty(window, "DeviceMotionEvent", {
          configurable: true,
          value: TestDeviceMotionEvent,
        });
      }
    },
    {
      disablePointerLock: pointerLockUnavailable,
      physicalMotion: expectedMotionSource === "device",
    },
  );
  const carBytes = new Uint8Array(await readFile(doomV2CarPath as string));
  const manifest = await readFile(doomV2ManifestPath as string, "utf8");
  const expectedPointerLock = expectedPointerCapture && !pointerLockUnavailable;
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
  await waitForHostInitialization(page);
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
    .locator("#dotli-polkavm-canvas");
  await expect(canvas).toHaveAttribute("data-polkavm-ready", "true", {
    timeout: 60_000,
  });
  await expect
    .poll(
      async () => Number(await canvas.getAttribute("data-polkavm-frames")),
      {
        timeout: 60_000,
      },
    )
    .toBeGreaterThan(2);
  await expect(canvas).toHaveAttribute(
    "data-polkavm-backend",
    expectedV2Backend,
  );
  if (expectedV2Profile !== undefined) {
    await expect(canvas).toHaveAttribute(
      "data-polkavm-profile",
      expectedV2Profile,
    );
  }
  if (expectedV2Profile === "tri2d") {
    await expect
      .poll(async () =>
        Number(await canvas.getAttribute("data-polkavm-tri2d-draws")),
      )
      .toBeGreaterThan(0);
  } else if (
    expectedV2Profile === "webgpu-raster" ||
    expectedV2Profile === "webgpu"
  ) {
    await expect(canvas).toHaveAttribute("data-polkavm-gpu", "ready");
  }
  if (expectedTruapi) {
    await expect
      .poll(async () =>
        Number(await canvas.getAttribute("data-polkavm-host-frame-requests")),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () =>
        Number(await canvas.getAttribute("data-polkavm-host-frame-responses")),
      )
      .toBeGreaterThan(0);
  }
  if (expectedResize) {
    const framesBeforeResize = Number(
      await canvas.getAttribute("data-polkavm-frames"),
    );
    await page.locator("#doom-v2-product").evaluate((iframe) => {
      iframe.style.width = "100vw";
      iframe.style.height = "100vh";
    });
    await page.setViewportSize({ width: 960, height: 640 });
    await expect
      .poll(async () =>
        Number(await canvas.getAttribute("data-polkavm-frames")),
      )
      .toBeGreaterThan(framesBeforeResize);
    await expect(canvas).toHaveAttribute("data-polkavm-ready", "true");
    if (
      expectedV2Profile === "webgpu-raster" ||
      expectedV2Profile === "webgpu"
    ) {
      await expect(canvas).toHaveAttribute("data-polkavm-gpu", "ready");
    }
  }
  const framesBeforeInput = Number(
    await canvas.getAttribute("data-polkavm-frames"),
  );
  await canvas.click({ position: { x: 160, y: 100 } });
  const productFrame = page
    .frames()
    .find((frame) => frame.url().includes("doom-v2.app.localhost"));
  if (productFrame === undefined) {
    throw new Error("PolkaVM product frame did not mount");
  }
  if (expectedPointerLock) {
    // Doom owns capture: enter a level before expecting the guest to arm it.
    for (const key of ["Escape", "Enter", "Enter", "Enter"]) {
      await page.keyboard.press(key);
    }
    await expect(canvas).toHaveAttribute(
      "data-polkavm-pointer-capture-armed",
      "true",
      { timeout: 60_000 },
    );
    await canvas.click({ position: { x: 160, y: 100 } });
    await expect
      .poll(async () =>
        productFrame.evaluate(() => document.pointerLockElement?.id ?? null),
      )
      .toBe("dotli-polkavm-canvas");
    await page.keyboard.press("Escape");
    await expect
      .poll(async () =>
        productFrame.evaluate(() => document.pointerLockElement?.id ?? null),
      )
      .toBeNull();
    await canvas.click({ position: { x: 160, y: 100 } });
    await expect
      .poll(async () =>
        productFrame.evaluate(() => document.pointerLockElement?.id ?? null),
      )
      .toBeNull();
    await page.keyboard.press("Escape");
    await expect(canvas).toHaveAttribute(
      "data-polkavm-pointer-capture-armed",
      "true",
      { timeout: 60_000 },
    );
    await canvas.click({ position: { x: 160, y: 100 } });
    await expect
      .poll(async () =>
        productFrame.evaluate(() => document.pointerLockElement?.id ?? null),
      )
      .toBe("dotli-polkavm-canvas");
  }
  if (expectedMotion) {
    if (expectedMotionSource === "device") {
      await productFrame.evaluate(() => {
        window.dispatchEvent(
          new DeviceMotionEvent("devicemotion", {
            accelerationIncludingGravity: { x: 0, y: 0, z: 9.80665 },
            rotationRate: { alpha: 0, beta: 0, gamma: 0 },
          }),
        );
        window.dispatchEvent(
          new DeviceMotionEvent("devicemotion", {
            accelerationIncludingGravity: {
              x: -9.80665 * 0.4,
              y: 0,
              z: 9,
            },
            rotationRate: { alpha: 0, beta: 0, gamma: 0 },
          }),
        );
      });
      await expect
        .poll(async () =>
          productFrame.evaluate(() =>
            Number(Reflect.get(window, "__dotliMotionPermissionRequests") ?? 0),
          ),
        )
        .toBeGreaterThan(0);
    } else if (expectedPointerLock) {
      await productFrame.evaluate(() => {
        const target = document.querySelector("#dotli-polkavm-canvas");
        if (!(target instanceof HTMLCanvasElement)) {
          throw new Error("PolkaVM canvas is unavailable");
        }
        target.dispatchEvent(
          new PointerEvent("pointermove", { movementX: 1, movementY: 1 }),
        );
        target.dispatchEvent(
          new PointerEvent("pointermove", { movementX: 24, movementY: -12 }),
        );
      });
    } else {
      const bounds = await canvas.boundingBox();
      if (bounds === null) {
        throw new Error("PolkaVM canvas has no browser bounds");
      }
      await page.mouse.move(
        bounds.x + bounds.width / 3,
        bounds.y + bounds.height / 2,
      );
      await page.mouse.move(
        bounds.x + (bounds.width * 2) / 3,
        bounds.y + bounds.height / 2,
      );
    }
    await expect
      .poll(async () =>
        Number(await canvas.getAttribute("data-polkavm-motion-samples")),
      )
      .toBeGreaterThan(0);
    await expect(canvas).toHaveAttribute(
      "data-polkavm-motion-source",
      expectedMotionSource,
    );
  }
  for (const key of expectedInputKeys) {
    await page.keyboard.press(key);
  }
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-polkavm-frames")))
    .toBeGreaterThan(framesBeforeInput);
});

test("touch and wheel gestures reach the guest without scrolling the host page", async ({
  page,
}) => {
  const fixture = await polkavmCar();
  await page.route(`**/ipfs/${fixture.cid}?format=car`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.ipld.car",
      body: Buffer.from(fixture.bytes),
    });
  });
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  await waitForHostInitialization(page);
  await installTruapiPortResponder(page);
  // Input records reach the guest through the runtime worker, so recording the
  // worker traffic is the only way to observe what the guest actually received.
  await page.addInitScript(() => {
    const scope = window as typeof window & {
      __polkavmInput?: number[][];
    };
    scope.__polkavmInput = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      transfer?: unknown,
    ): void {
      const record = message as { type?: unknown; bytes?: unknown };
      if (record.type === "input" && ArrayBuffer.isView(record.bytes)) {
        scope.__polkavmInput?.push(
          Array.from(new Uint8Array(record.bytes.buffer.slice(0))),
        );
      }
      (post as (message: unknown, transfer?: unknown) => void).call(
        this,
        message,
        transfer,
      );
    } as typeof Worker.prototype.postMessage;
  });
  await page.evaluate(
    ({ cid, schemaVersion }) => {
      const iframe = document.createElement("iframe");
      iframe.id = "polkavm-product";
      iframe.style.cssText = "width:100%;height:100%;border:0";
      iframe.src = `http://polkavm-fixture.app.localhost:5173/?cid=${cid}&v=${String(schemaVersion)}&chainBackend=rpc-gateway&network=paseo-next-v2&fullReset=1&polkavmMode=interpreter`;
      (document.getElementById("app") ?? document.body).replaceChildren(iframe);
    },
    { cid: fixture.cid, schemaVersion: SANDBOX_SCHEMA_VERSION },
  );

  const product = page.frameLocator("#polkavm-product");
  const canvas = product.locator("#dotli-polkavm-canvas");
  await expect(canvas).toHaveAttribute("data-polkavm-ready", "true", {
    timeout: 30_000,
  });

  const productFrame = page
    .frames()
    .find((frame) => frame.url().includes("polkavm-fixture.app.localhost"));
  if (productFrame === undefined) {
    throw new Error("PolkaVM product frame did not mount");
  }
  const gesture = await productFrame.evaluate(() => {
    const scope = window as typeof window & { __polkavmInput?: number[][] };
    const target = document.querySelector("#dotli-polkavm-canvas");
    if (!(target instanceof HTMLCanvasElement)) {
      throw new Error("PolkaVM canvas is unavailable");
    }
    const bounds = target.getBoundingClientRect();
    const touch = (
      type: string,
      pointerId: number,
      isPrimary: boolean,
      offsetY: number,
    ): void => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: "touch",
          isPrimary,
          button: 0,
          buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2 + offsetY,
        }),
      );
    };
    const before = scope.__polkavmInput?.length ?? 0;
    touch("pointerdown", 1, true, 0);
    touch("pointermove", 1, true, -40);
    // A second finger keeps an independent stable contact identity.
    touch("pointerdown", 2, false, 120);
    touch("pointermove", 2, false, 120);
    // The browser claims the gesture and never sends `pointerup`.
    touch("pointercancel", 1, true, -40);
    touch("pointerup", 2, false, 120);
    const wheelDefaultPrevented = !target.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaX: 7,
        deltaY: 23,
      }),
    );
    const records = (scope.__polkavmInput ?? []).slice(before);
    return {
      touches: records
        .filter((record) => (record[0] ?? 0) >= 18 && (record[0] ?? 0) <= 21)
        .map((record) => record.slice(0, 2)),
      wheels: records
        .filter((record) => record[0] === 14)
        .map((record) => {
          const bytes = Uint8Array.from(record);
          const view = new DataView(bytes.buffer);
          return [view.getInt16(2, true), view.getInt16(4, true)];
        }),
      wheelDefaultPrevented,
      captured: target.hasPointerCapture(1) || target.hasPointerCapture(2),
      scrollTop: document.scrollingElement?.scrollTop ?? 0,
    };
  });

  expect(gesture.touches).toEqual([
    [18, 0],
    [19, 0],
    [18, 1],
    [19, 1],
    [21, 0],
    [20, 1],
  ]);
  expect(gesture.wheels).toEqual([[-7, -23]]);
  expect(gesture.wheelDefaultPrevented).toBe(true);
  expect(gesture.captured).toBe(false);
  expect(gesture.scrollTop).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // The browser only routes a touch drag to the guest when the canvas claims
  // every gesture; otherwise it pans and cancels the pointer stream instead.
  expect(
    await canvas.evaluate((element) => getComputedStyle(element).touchAction),
  ).toBe("none");
  expect(
    await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return { overflow: body.overflow, overscroll: body.overscrollBehaviorY };
    }),
  ).toEqual({ overflow: "hidden", overscroll: "none" });
});

test("a consented file restarts the same PolkaVM iframe", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await fileInputCar();
  const port = process.env.DOTLI_TEST_PORT ?? "5173";
  await page.route(`**/ipfs/${fixture.cid}?format=car`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.ipld.car",
      body: Buffer.from(fixture.bytes),
    });
  });
  await page.goto(`http://polkavm-file.localhost:${port}/dotli-network.js`, {
    waitUntil: "domcontentloaded",
  });
  await installRepeatedTruapiPortResponder(
    page,
    `http://polkavm-file.app.localhost:${port}`,
  );
  await page.evaluate(
    ({ cid, manifest, schemaVersion, port }) => {
      const url = new URL(`http://polkavm-file.app.localhost:${port}/`);
      url.searchParams.set("cid", cid);
      url.searchParams.set("v", String(schemaVersion));
      url.searchParams.set("chainBackend", "rpc-gateway");
      url.searchParams.set("network", "paseo-next-v2");
      url.searchParams.set("executableManifest", manifest);
      const iframe = document.createElement("iframe");
      iframe.id = "polkavm-file-product";
      iframe.style.cssText = "width:100vw;height:100vh;border:0";
      document.body.replaceChildren(iframe);
      iframe.src = url.toString();
    },
    {
      cid: fixture.cid,
      manifest: fixture.manifest,
      schemaVersion: SANDBOX_SCHEMA_VERSION,
      port,
    },
  );

  const product = page.frameLocator("#polkavm-file-product");
  const canvas = product.locator("#dotli-polkavm-canvas");
  await expect(canvas).toHaveAttribute("data-polkavm-ready", "true", {
    timeout: 30_000,
  });
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-polkavm-frames")))
    .toBeGreaterThan(2);

  await product.locator('input[type="file"]').setInputFiles({
    name: "game.sfc",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(64, 0xa5),
  });
  const consent = product.locator(".dotli-file-consent");
  await expect(consent).toContainText("Give this file to the app?");
  await expect(consent).toContainText("game.sfc · 0.1 KiB");
  await expect(consent).toContainText("SNES cartridge image");
  await expect(product.locator("#dotli-polkavm-file-open")).toBeEnabled();
  await consent.locator(".dotli-file-consent-approve").click();

  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __dotliTestPortsIssued?: number;
              }
            ).__dotliTestPortsIssued,
        ),
      { timeout: 30_000 },
    )
    .toBe(2);
  await expect(canvas).toHaveAttribute("data-polkavm-ready", "true", {
    timeout: 30_000,
  });
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-polkavm-frames")))
    .toBeGreaterThan(2);
  await expect(product.locator("#dotli-polkavm-file-open")).toBeVisible();
});
