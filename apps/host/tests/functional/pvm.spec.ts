// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "@playwright/test";
import { CarReader, CarWriter } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import type { PBLink } from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
    name: "pvm-runtime/epoca-pvm-host.wasm",
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
  await page.evaluate((cid) => {
    const iframe = document.createElement("iframe");
    iframe.id = "pvm-product";
    iframe.src = `http://pvm-fixture.app.localhost:5173/?cid=${cid}&v=3&chainBackend=rpc-gateway&network=paseo-next-v2`;
    document.body.replaceChildren(iframe);
  }, fixture.cid);

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

  // Reload the same product origin: translated Wasm bytes come from IndexedDB,
  // so the second worker skips PVM instruction lowering.
  await page.evaluate((cid) => {
    const iframe = document.querySelector<HTMLIFrameElement>("#pvm-product");
    if (iframe !== null) {
      iframe.src = `http://pvm-fixture.app.localhost:5173/?cid=${cid}&v=3&chainBackend=rpc-gateway&network=paseo-next-v2`;
    }
  }, fixture.cid);
  await expect(canvas).toHaveAttribute("data-pvm-cache-hit", "true", {
    timeout: 30_000,
  });
  await expect(canvas).toHaveAttribute("data-pvm-translation-ms", "0");
});

const doomV2CarPath = process.env.DOTLI_DOOM_V2_CAR;
const doomV2ManifestPath = process.env.DOTLI_DOOM_V2_MANIFEST;

test("the canonical Doom App v2 artifact renders with exact manifest bytes", async ({
  page,
}) => {
  test.skip(
    doomV2CarPath === undefined || doomV2ManifestPath === undefined,
    "DOTLI_DOOM_V2_CAR and DOTLI_DOOM_V2_MANIFEST are required",
  );
  const carBytes = new Uint8Array(await readFile(doomV2CarPath as string));
  const manifest = await readFile(doomV2ManifestPath as string, "utf8");
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
  await page.evaluate(
    ({ artifactCid, executableManifest }) => {
      const url = new URL(
        `http://doom-v2.app.localhost:5173/?cid=${artifactCid}&v=3&chainBackend=rpc-gateway&network=paseo-next-v2`,
      );
      url.searchParams.set("executableManifest", executableManifest);
      const iframe = document.createElement("iframe");
      iframe.id = "doom-v2-product";
      iframe.src = url.toString();
      document.body.replaceChildren(iframe);
    },
    { artifactCid: cid, executableManifest: manifest },
  );

  const canvas = page
    .frameLocator("#doom-v2-product")
    .locator("#dotli-pvm-canvas");
  await expect(canvas).toHaveAttribute("data-pvm-ready", "true", {
    timeout: 60_000,
  });
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-pvm-frames")))
    .toBeGreaterThan(2);
  await expect(canvas).toHaveAttribute("data-pvm-backend", "compiler");
  const framesBeforeInput = Number(
    await canvas.getAttribute("data-pvm-frames"),
  );
  await canvas.click({ position: { x: 160, y: 100 } });
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-pvm-frames")))
    .toBeGreaterThan(framesBeforeInput);
});
