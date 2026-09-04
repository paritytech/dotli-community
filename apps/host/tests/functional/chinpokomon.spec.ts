// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runtime-variant proof for the shipped Chinpokomon product bundle.
 *
 * Unlike the synthetic fixtures in `pvm.spec.ts`, this suite serves the real
 * `pvm-apps/chinpokomon/bundle` directory, so it also covers the fallback's
 * sub-resource load (`/fallback/app.js`) through the sandbox service worker.
 *
 * Point `DOTLI_CHINPOKOMON_BUNDLE` at the built bundle to enable it.
 */

import { expect, test, type Page } from "@playwright/test";
import { CarWriter } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import type { PBLink } from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { SANDBOX_SCHEMA_VERSION } from "@dotli/config/host-sandbox-contract";

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

/**
 * UnixFS directory CAR with nested paths flattened into a single root, which
 * is exactly how the sandbox archive reader keys its files.
 */
async function archiveCar(
  sourceFiles: ReadonlyArray<readonly [string, Uint8Array]>,
): Promise<{ cid: string; bytes: Uint8Array }> {
  const files = await Promise.all(
    sourceFiles.map(async ([name, bytes]) => ({
      name,
      bytes,
      cid: CID.createV1(raw.code, await sha256.digest(bytes)),
    })),
  );
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
/**
 * The sandbox blocks PolkaVM startup on a Host-injected TrUAPI port, so the
 * suite answers the sandbox's readiness probe the way the host shell does.
 */
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
    await expect(product.locator("#dotli-pvm-canvas")).toHaveCount(0);
  });

  test("runs the PolkaVM program when the browser exposes a WebGPU adapter", async ({
    page,
  }) => {
    test.skip(
      process.env.DOTLI_WEBGPU !== "1",
      "DOTLI_WEBGPU=1 enables the SwiftShader WebGPU adapter",
    );
    await mountProduct(page, "chinpokomon-pvm", "chinpokomon-pvm");

    const product = page.frameLocator("#chinpokomon-pvm");
    const canvas = product.locator("#dotli-pvm-canvas");
    await expect(canvas).toHaveAttribute("data-pvm-profile", "webgpu-raster", {
      timeout: 60_000,
    });
    await expect(canvas).toHaveAttribute("data-pvm-ready", "true", {
      timeout: 120_000,
    });
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-pvm-frames")), {
        timeout: 120_000,
      })
      .toBeGreaterThan(2);
    await expect(
      product.locator("canvas[data-runtime='webgl-fallback']"),
    ).toHaveCount(0);
  });
});
